/**
 * One basket contract, two adapters.
 *
 * Knuspr has a cart, EDEKA has a shopping list, and a place neither reaches
 * keeps a checklist — but a caller should not have to know which one it got.
 * This module owns the shared rules: the destination must be reachable *here*
 * (a greyed-out button is not the guard), the guardrails apply to both stores,
 * and every write is a `BotRun` so undo stays possible.
 *
 * Nothing here learns or decides what to buy: items arrive from a caller that
 * already picked them, and the adapters only move them into a basket.
 */
import mongoose from 'mongoose';
import BotRun from '../models/BotRun';
import { ensureSession } from '../api/controllers/easyshopper.controller';
import { getBotSettings } from './bot/fill';
import { getLocationSettings } from './bot/location-settings';
import { getKnusprSession } from './knuspr-auth';
import {
  addItems,
  cartQuantityByProduct,
  checkCart,
  fetchPrices,
  normalizeCart,
  removeItems,
} from './knuspr-cart';
import {
  availability,
  resolveLocation,
  type Destination,
  type LocationContext,
  type Provider,
} from './providers';

export interface BasketItemInput {
  provider: Provider;
  /** Knuspr product id; a cart line without one is skipped. */
  productId?: number;
  /** EDEKA identity of a free-text row, when the caller has no catalogue id. */
  textKey?: string;
  name: string;
  qty: number;
}

export interface BasketItem extends BasketItemInput {
  /** Unit price the guardrail used. Absent for EDEKA, whose list carries no prices. */
  price?: number;
  /** EASY Shopper row id returned by the write, used to remove exactly that row. */
  listItemGuid?: string;
}

export interface BasketSkip {
  name: string;
  reason: string;
}

export interface BasketGuardrail {
  /** True when the write was refused; nothing was written. */
  blocked: boolean;
  /** Why it was refused, empty when it was not. */
  reason: string;
  maxEuro: number;
  maxItems: number;
}

export type BasketStatus = 'added' | 'nothing-to-add' | 'blocked' | 'unavailable';

export interface BasketResult {
  status: BasketStatus;
  runId: string | null;
  destination: Destination;
  added: BasketItem[];
  skipped: BasketSkip[];
  /** Written total, or the intended total when the guardrail refused the run. */
  total: number;
  guardrail: BasketGuardrail;
  /** Why nothing was written, when that happened. */
  error?: string;
}

export interface AddToBasketOptions {
  destination: Destination;
  items: BasketItemInput[];
  /** The session cookie key: both stores authenticate on the user's behalf. */
  derivedKey?: Buffer;
  now?: Date;
}

export type UndoBasketResult =
  | { status: 'undone'; restored: number }
  | { status: 'not-found'; restored: 0 }
  | { status: 'not-undoable'; restored: 0; reason: string }
  | { status: 'failed'; restored: number; reason: string; failed: BasketSkip[] };

/** The store a destination writes to; a checklist has none. */
export function providerForDestination(destination: Destination): Provider | null {
  if (destination === 'knuspr-cart') return 'knuspr';
  if (destination === 'edeka-list') return 'edeka';
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a basket is over the guardrails, or an empty string when it fits. */
function guardrailReason(lines: number, total: number, maxEuro: number, maxItems: number): string {
  if (total > maxEuro) {
    return `Basket is €${total.toFixed(2)}, over the €${maxEuro.toFixed(2)} limit`;
  }
  if (lines > maxItems) {
    return `${lines} items, over the ${maxItems}-item limit`;
  }
  return '';
}

function storedItems(items: BasketItem[]): Array<Record<string, unknown>> {
  return items.map((item) => ({
    productId: item.productId,
    provider: item.provider,
    textKey: item.textKey,
    listItemGuid: item.listItemGuid,
    name: item.name,
    qty: item.qty,
    price: item.price,
  }));
}

async function recordRun(
  userId: string,
  destination: Destination,
  context: LocationContext,
  items: BasketItem[],
  total: number
): Promise<string> {
  const run = await BotRun.create({
    userId,
    intent: {
      type: 'plan',
      summary: `${items.length} item${items.length === 1 ? '' : 's'} to ${destination}`,
    },
    items: storedItems(items),
    totalPrice: total,
    destination,
    // The snapshot is what makes a derived default explainable after the trip.
    locationContext: {
      source: context.source,
      city: context.city ?? undefined,
      country: context.country ?? undefined,
    },
    status: 'in-cart',
  });
  return String(run._id);
}

/**
 * Add items to one destination. An unreachable destination and an over-limit
 * basket are both refused before the first write, with a reason the caller can
 * show verbatim.
 */
export async function addToBasket(userId: string, options: AddToBasketOptions): Promise<BasketResult> {
  const { destination } = options;
  const context = resolveLocation(options.now ?? new Date(), await getLocationSettings(userId));
  const settings = await getBotSettings(userId);

  const guardrail: BasketGuardrail = {
    blocked: false,
    reason: '',
    maxEuro: settings.maxEuro,
    maxItems: settings.maxItems,
  };
  const result = (status: BasketStatus, extra: Partial<BasketResult> = {}): BasketResult => ({
    status,
    runId: null,
    destination,
    added: [],
    skipped: [],
    total: 0,
    guardrail,
    ...extra,
  });

  // Availability is a server-side gate, not a UI state: a stale or hand-made
  // request must not write to a store that cannot reach the shopper.
  const provider = providerForDestination(destination);
  if (provider) {
    const reach = availability(provider, context);
    if (!reach.available) return result('unavailable', { error: reach.reason });
  }

  const items = options.items
    .map((item) => ({ ...item, name: item.name.trim() }))
    .filter((item) => item.name.length > 0 && item.qty > 0);
  if (items.length === 0) return result('nothing-to-add');

  // An item from the other store has no id here; say so instead of inventing one.
  const applicable = provider ? items.filter((item) => item.provider === provider) : items;
  const skipped: BasketSkip[] = provider
    ? items
        .filter((item) => item.provider !== provider)
        .map((item) => ({ name: item.name, reason: `${item.provider} items cannot go to ${destination}` }))
    : [];
  if (applicable.length === 0) return result('nothing-to-add', { skipped });

  if (destination === 'knuspr-cart') {
    if (!options.derivedKey) throw new Error('Session key missing — please re-login');
    return writeKnusprCart(userId, options.derivedKey, applicable, skipped, guardrail, context);
  }
  if (destination === 'edeka-list') {
    if (!options.derivedKey) throw new Error('Session key missing — please re-login');
    return writeEdekaList(userId, options.derivedKey, applicable, skipped, guardrail, context);
  }
  return writeChecklist(userId, applicable, skipped, guardrail, context);
}

async function writeKnusprCart(
  userId: string,
  derivedKey: Buffer,
  items: BasketItemInput[],
  skipped: BasketSkip[],
  guardrail: BasketGuardrail,
  context: LocationContext
): Promise<BasketResult> {
  const destination: Destination = 'knuspr-cart';
  const session = await getKnusprSession(userId, derivedKey);
  const raw = await checkCart(session);
  const inCart = cartQuantityByProduct(raw ? await normalizeCart(userId, raw) : null);
  const productIds = items
    .map((item) => item.productId)
    .filter((productId): productId is number => typeof productId === 'number');
  const prices = await fetchPrices(session, productIds);

  const planned: BasketItem[] = [];
  for (const item of items) {
    if (typeof item.productId !== 'number') {
      skipped.push({ name: item.name, reason: 'no Knuspr product id' });
      continue;
    }
    if (inCart.has(item.productId)) {
      skipped.push({ name: item.name, reason: 'already in the cart' });
      continue;
    }
    planned.push({ ...item, price: prices.get(item.productId)?.effectivePrice ?? 0 });
  }

  const intendedTotal = planned.reduce((sum, item) => sum + (item.price ?? 0) * item.qty, 0);
  const blocked = guardrailReason(planned.length, intendedTotal, guardrail.maxEuro, guardrail.maxItems);
  if (blocked) {
    guardrail.blocked = true;
    guardrail.reason = blocked;
    return { status: 'blocked', runId: null, destination, added: [], skipped, total: intendedTotal, guardrail };
  }
  if (planned.length === 0) {
    return { status: 'nothing-to-add', runId: null, destination, added: [], skipped, total: 0, guardrail };
  }

  const { added, failed } = await addItems(
    session,
    planned.map((item) => ({ productId: item.productId as number, amount: item.qty }))
  );
  const addedIds = new Set(added.map((line) => line.productId));
  const written = planned.filter((item) => addedIds.has(item.productId as number));
  for (const failure of failed) {
    const name = planned.find((item) => item.productId === failure.item.productId)?.name
      ?? String(failure.item.productId);
    skipped.push({ name, reason: failure.error });
  }
  if (written.length === 0) {
    return { status: 'nothing-to-add', runId: null, destination, added: [], skipped, total: 0, guardrail };
  }

  const total = written.reduce((sum, item) => sum + (item.price ?? 0) * item.qty, 0);
  const runId = await recordRun(userId, destination, context, written, total);
  return { status: 'added', runId, destination, added: written, skipped, total, guardrail };
}

/** The response shape is not documented, so take the first id-shaped field it has. */
function responseGuid(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  const guid = record.shoppingListItemGuid ?? record.guid ?? record.id;
  return typeof guid === 'string' ? guid : undefined;
}

async function writeEdekaList(
  userId: string,
  derivedKey: Buffer,
  items: BasketItemInput[],
  skipped: BasketSkip[],
  guardrail: BasketGuardrail,
  context: LocationContext
): Promise<BasketResult> {
  const destination: Destination = 'edeka-list';
  const { client, session, storeGuid } = await ensureSession(userId, derivedKey);

  // The list carries no prices, so the euro guardrail has nothing to add up;
  // maxItems still applies and is the one that can refuse this adapter.
  const blocked = guardrailReason(items.length, 0, guardrail.maxEuro, guardrail.maxItems);
  if (blocked) {
    guardrail.blocked = true;
    guardrail.reason = blocked;
    return { status: 'blocked', runId: null, destination, added: [], skipped, total: 0, guardrail };
  }

  const written: BasketItem[] = [];
  for (const item of items) {
    try {
      const response = await client.upsertItem(session.token, storeGuid, {
        amount: item.qty,
        name: item.name,
      });
      written.push({ ...item, listItemGuid: responseGuid(response) });
    } catch (error) {
      skipped.push({ name: item.name, reason: describeError(error) });
    }
  }
  if (written.length === 0) {
    return { status: 'nothing-to-add', runId: null, destination, added: [], skipped, total: 0, guardrail };
  }

  const runId = await recordRun(userId, destination, context, written, 0);
  return { status: 'added', runId, destination, added: written, skipped, total: 0, guardrail };
}

/**
 * A checklist has no store to reach, so the run *is* the checklist: it records
 * what the shopper wants without pretending a provider can fulfil it.
 */
async function writeChecklist(
  userId: string,
  items: BasketItemInput[],
  skipped: BasketSkip[],
  guardrail: BasketGuardrail,
  context: LocationContext
): Promise<BasketResult> {
  const destination: Destination = 'checklist';
  const blocked = guardrailReason(items.length, 0, guardrail.maxEuro, guardrail.maxItems);
  if (blocked) {
    guardrail.blocked = true;
    guardrail.reason = blocked;
    return { status: 'blocked', runId: null, destination, added: [], skipped, total: 0, guardrail };
  }

  const runId = await recordRun(userId, destination, context, items, 0);
  return { status: 'added', runId, destination, added: items, skipped, total: 0, guardrail };
}

interface StoredRunItem {
  productId?: number | null;
  name: string;
  qty: number;
  listItemGuid?: string | null;
}

/**
 * Undo one run in the basket it was written to. Deletion is `amount: 0` on the
 * EDEKA list and a best-effort cart removal on Knuspr, so both adapters can
 * report how many lines were actually returned.
 */
export async function undoBasketRun(
  userId: string,
  runId: string,
  options: { derivedKey?: Buffer } = {}
): Promise<UndoBasketResult> {
  if (!mongoose.isValidObjectId(runId)) return { status: 'not-found', restored: 0 };

  const run = await BotRun.findOne({ _id: runId, userId });
  if (!run) return { status: 'not-found', restored: 0 };
  if (run.status !== 'in-cart') {
    return { status: 'not-undoable', restored: 0, reason: `Run is ${run.status} and can no longer be undone` };
  }

  const destination = (run.destination ?? 'knuspr-cart') as Destination;
  const items = run.items as unknown as StoredRunItem[];

  if (destination === 'knuspr-cart') {
    const cartItems = items.filter(
      (item): item is StoredRunItem & { productId: number } => typeof item.productId === 'number'
    );
    if (cartItems.length > 0) {
      if (!options.derivedKey) throw new Error('Session key missing — please re-login');
      const session = await getKnusprSession(userId, options.derivedKey);
      const { removed, failed } = await removeItems(
        userId,
        session,
        cartItems.map((item) => ({ productId: item.productId, amount: item.qty }))
      );
      if (failed.length > 0) {
        return {
          status: 'failed',
          restored: removed.length,
          reason: 'Knuspr did not remove every item',
          failed: failed.map((entry) => ({ name: String(entry.item.productId), reason: entry.error })),
        };
      }
      run.status = 'undone';
      await run.save();
      return { status: 'undone', restored: removed.length };
    }
  }

  if (destination === 'edeka-list') {
    if (!options.derivedKey) throw new Error('Session key missing — please re-login');
    const { client, session, storeGuid } = await ensureSession(userId, options.derivedKey);
    let restored = 0;
    const failed: BasketSkip[] = [];
    for (const item of items) {
      try {
        if (item.listItemGuid) {
          await client.removeItem(session.token, storeGuid, item.listItemGuid);
        } else {
          // Deletion is the same upsert with amount 0; a row that never carried a
          // guid is still addressable by the name it was written with.
          await client.upsertItem(session.token, storeGuid, { amount: 0, name: item.name });
        }
        restored += 1;
      } catch (error) {
        failed.push({ name: item.name, reason: describeError(error) });
      }
    }
    if (failed.length > 0) {
      return { status: 'failed', restored, reason: 'EASY Shopper did not remove every row', failed };
    }
    run.status = 'undone';
    await run.save();
    return { status: 'undone', restored };
  }

  // A checklist line never reached a provider, so undoing it is local.
  run.status = 'undone';
  await run.save();
  return { status: 'undone', restored: items.length };
}
