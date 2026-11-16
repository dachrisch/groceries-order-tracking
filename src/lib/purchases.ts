/**
 * One read model over both grocery sources.
 *
 * Knuspr deliveries live in `Order`, in-store EDEKA runs live in
 * `PurchaseSession`. They stay separate collections — merging them in storage
 * would double-count a week that has both a delivery and a shop run — but every
 * screen now reads the same shape, so "what did I buy" has one answer.
 *
 * Adapters are pure: hand them a lean document and they return a
 * `PurchaseEvent`. Nothing here writes, and nothing here learns.
 */
import Order from '../models/Order';
import PurchaseSession from '../models/PurchaseSession';
import { productKey } from './easyshopper/insights';
import type { Provider } from './providers';

export interface PurchaseLine {
  provider: Provider;
  /** Knuspr: the product id as text. EDEKA: `productKey()` of the receipt row. */
  productKey: string;
  name: string;
  qty: number;
  unitPrice: number | null;
  /** Knuspr product id, when the line has one (EDEKA rows carry none). */
  productId: number | null;
  image?: string | null;
}

export interface PurchaseEvent {
  /** `knuspr:<orderId>` or `edeka:<sessionId>`. */
  id: string;
  provider: Provider;
  kind: 'delivery' | 'store-run';
  at: Date;
  /** Where it happened: the delivery address, or the shop name. */
  place: string | null;
  total: number;
  itemCount: number;
  occasionIds: string[];
  /** Set when a bot run produced this basket. */
  runId: string | null;
  /** Only bot-added orders can be undone; a shop receipt cannot. */
  canUndo: boolean;
  lines: PurchaseLine[];
}

/** A list row: everything except the (potentially long) line items. */
export type PurchaseSummary = Omit<PurchaseEvent, 'lines'> & { lineCount: number };

export interface OrderItemLike {
  id: number;
  name: string;
  amount?: number | null;
  textualAmount?: string | null;
  images?: string[] | null;
  priceComposition?: { total?: { amount?: number | null } | null } | null;
}

export interface OrderLike {
  id: number;
  orderTimeDate: Date | string;
  address?: string | null;
  itemsCount?: number | null;
  priceComposition?: { total?: { amount?: number | null } | null } | null;
  items?: OrderItemLike[] | null;
  botRunId?: unknown;
  occasionIds?: unknown[] | null;
}

export interface PurchaseItemLike {
  brand?: string | null;
  name: string;
  quantity?: number | null;
  unitPrice?: number | null;
  lineTotal?: number | null;
  isCredit?: boolean;
}

export interface PurchaseSessionLike {
  _id: unknown;
  key?: string;
  purchasedAt: Date | string;
  store: string;
  total: number;
  unitCount?: number | null;
  items?: PurchaseItemLike[] | null;
}

function money(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function purchaseEventId(provider: Provider, id: string | number): string {
  return `${provider}:${id}`;
}

export function parsePurchaseEventId(raw: string): { provider: Provider; id: string } | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const provider = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!id) return null;
  if (provider !== 'knuspr' && provider !== 'edeka') return null;
  return { provider, id };
}

/** A Knuspr order as one event. Total falls back to the lines when the sum is missing. */
export function fromOrder(order: OrderLike): PurchaseEvent {
  const lines: PurchaseLine[] = (order.items ?? []).map((item) => ({
    provider: 'knuspr',
    productKey: String(item.id),
    productId: item.id,
    name: item.name,
    qty: typeof item.amount === 'number' && item.amount > 0 ? item.amount : 1,
    unitPrice: typeof item.priceComposition?.total?.amount === 'number'
      ? item.priceComposition.total.amount
      : null,
    image: item.images?.[0] ?? null,
  }));

  const lineSum = lines.reduce((sum, line) => sum + money(line.unitPrice) * line.qty, 0);
  const declared = order.priceComposition?.total?.amount;
  const runId = order.botRunId ? String(order.botRunId) : null;

  return {
    id: purchaseEventId('knuspr', order.id),
    provider: 'knuspr',
    kind: 'delivery',
    at: asDate(order.orderTimeDate),
    place: order.address ?? null,
    total: Number((money(declared) || lineSum).toFixed(2)),
    itemCount: order.itemsCount ?? lines.length,
    occasionIds: (order.occasionIds ?? []).map(String),
    runId,
    canUndo: runId !== null,
    lines,
  };
}

/** An in-store receipt as one event. Deposit returns are lines too, not money off the total. */
export function fromPurchaseSession(session: PurchaseSessionLike): PurchaseEvent {
  const lines: PurchaseLine[] = (session.items ?? [])
    .filter((item) => !item.isCredit)
    .map((item) => ({
      provider: 'edeka' as const,
      productKey: productKey(item),
      productId: null,
      name: [item.brand, item.name].filter(Boolean).join(' ').trim() || item.name,
      qty: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
      unitPrice: typeof item.unitPrice === 'number' ? item.unitPrice : null,
      image: null,
    }));

  return {
    id: purchaseEventId('edeka', String(session._id)),
    provider: 'edeka',
    kind: 'store-run',
    at: asDate(session.purchasedAt),
    place: session.store,
    total: Number(money(session.total).toFixed(2)),
    itemCount: session.unitCount ?? lines.length,
    occasionIds: [],
    runId: null,
    canUndo: false,
    lines,
  };
}

export function toSummary(event: PurchaseEvent): PurchaseSummary {
  const { lines, ...rest } = event;
  return { ...rest, lineCount: lines.length };
}

export interface ListPurchasesOptions {
  from?: Date;
  to?: Date;
  /** Omitted means both sources, which is the normal case. */
  provider?: Provider;
  /** Newest first. Defaults to 100 events. */
  limit?: number;
}

function dateFilter(from?: Date, to?: Date): { $gte?: Date; $lte?: Date } | null {
  if (!from && !to) return null;
  const range: { $gte?: Date; $lte?: Date } = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return range;
}

/**
 * Both sources as one newest-first stream.
 *
 * The two queries run in parallel; the merge is in memory because a Mongo union
 * across two collections with different date fields buys nothing at this size.
 */
export async function listPurchases(
  userId: string,
  options: ListPurchasesOptions = {}
): Promise<PurchaseEvent[]> {
  const limit = options.limit ?? 100;
  const events: PurchaseEvent[] = [];

  const wantKnuspr = !options.provider || options.provider === 'knuspr';
  const wantEdeka = !options.provider || options.provider === 'edeka';
  const range = dateFilter(options.from, options.to);

  // A `{}` here would be cast as a date and throw, so the field is only present
  // when there is something to compare against.
  const orderQuery: Record<string, unknown> = { userId };
  const sessionQuery: Record<string, unknown> = { userId };
  if (range) {
    orderQuery.orderTimeDate = range;
    sessionQuery.purchasedAt = range;
  }

  const [orders, sessions] = await Promise.all([
    wantKnuspr
      ? Order.find(orderQuery).sort({ orderTimeDate: -1 }).limit(limit).lean()
      : Promise.resolve([]),
    wantEdeka
      ? PurchaseSession.find(sessionQuery).sort({ purchasedAt: -1 }).limit(limit).lean()
      : Promise.resolve([]),
  ]);

  for (const order of orders) events.push(fromOrder(order as unknown as OrderLike));
  for (const session of sessions) events.push(fromPurchaseSession(session as unknown as PurchaseSessionLike));

  return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** One event by its public id, or null when it is gone or not this user's. */
export async function findPurchase(userId: string, eventId: string): Promise<PurchaseEvent | null> {
  const parsed = parsePurchaseEventId(eventId);
  if (!parsed) return null;

  if (parsed.provider === 'knuspr') {
    const orderId = Number(parsed.id);
    if (!Number.isFinite(orderId)) return null;
    const order = await Order.findOne({ userId, id: orderId }).lean();
    return order ? fromOrder(order as unknown as OrderLike) : null;
  }

  const session = await PurchaseSession.findOne({ userId, _id: parsed.id }).lean();
  return session ? fromPurchaseSession(session as unknown as PurchaseSessionLike) : null;
}
