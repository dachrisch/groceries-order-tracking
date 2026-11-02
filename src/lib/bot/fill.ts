import BotRun from '../../models/BotRun';
import BotSettings, { BOT_SETTINGS_DEFAULTS, type BotSettingsShape } from '../../models/BotSettings';
import { getKnusprSession } from '../knuspr-auth';
import { addItems, cartQuantityByProduct, checkCart, fetchPrices, getCart, normalizeCart, type CartPrice, type NormalizedCart } from '../knuspr-cart';
import { getWeeklyConsumption, type ConsumptionItem } from './consumption';

export interface PlannedItem {
  productId: number;
  name: string;
  qty: number;
  reason: string;
  groupKey: string;
  price: number;
  occasionId?: string;
  servings?: number;
}

/**
 * Something one action wants in the cart, before cart and price checks. The
 * weekly fill and every occasion produce candidates; they are merged by
 * product group so nothing is added twice.
 */
export interface FillCandidate {
  groupKey: string;
  productIds: number[];
  /** Preferred product (most bought in the group). */
  productId: number;
  name: string;
  qty: number;
  reason: string;
  /** Price to assume when live prices are unavailable. */
  fallbackPrice: number;
  /** Set when the candidate comes from exactly one occasion (for learning). */
  occasionId?: string;
  servings?: number;
}

/** Merge candidate lists by group: larger quantity wins, reasons are joined. */
export function mergeCandidates(lists: FillCandidate[][]): FillCandidate[] {
  const merged = new Map<string, FillCandidate & { sources: number }>();
  for (const list of lists) {
    for (const candidate of list) {
      const existing = merged.get(candidate.groupKey);
      if (!existing) {
        merged.set(candidate.groupKey, { ...candidate, sources: 1 });
        continue;
      }
      const reasons = existing.reason.split('; ');
      if (!reasons.includes(candidate.reason)) reasons.push(candidate.reason);
      const bigger = candidate.qty > existing.qty ? candidate : existing;
      merged.set(candidate.groupKey, {
        ...bigger,
        productIds: [...new Set([...existing.productIds, ...candidate.productIds])],
        qty: Math.max(existing.qty, candidate.qty),
        reason: reasons.join('; '),
        fallbackPrice: existing.fallbackPrice || candidate.fallbackPrice,
        sources: existing.sources + 1,
      });
    }
  }
  return [...merged.values()].map(({ sources, ...candidate }) =>
    sources > 1 ? { ...candidate, occasionId: undefined, servings: undefined } : candidate
  );
}

export interface FillResult {
  status: 'added' | 'requires-confirmation' | 'nothing-to-add';
  intent: { type: 'weekly' | 'occasion' | 'plan'; occasion?: string; occasionId?: string; servings?: number; summary?: string };
  items: PlannedItem[];
  estimatedTotal: number;
  run?: unknown;
  cart?: NormalizedCart | null;
  skipped?: string[];
  failed?: Array<{ productId: number; error: string }>;
  maxEuro: number;
  maxItems: number;
}

export async function getBotSettings(userId: string): Promise<BotSettingsShape> {
  const doc = await BotSettings.findOne({ userId }).lean();
  if (!doc) return { ...BOT_SETTINGS_DEFAULTS };
  return {
    maxEuro: doc.maxEuro ?? BOT_SETTINGS_DEFAULTS.maxEuro,
    maxItems: doc.maxItems ?? BOT_SETTINGS_DEFAULTS.maxItems,
    horizonDays: doc.horizonDays ?? BOT_SETTINGS_DEFAULTS.horizonDays,
    deliveryLeadDays: doc.deliveryLeadDays ?? BOT_SETTINGS_DEFAULTS.deliveryLeadDays,
    opencodeEnabled: doc.opencodeEnabled ?? BOT_SETTINGS_DEFAULTS.opencodeEnabled,
  };
}

/**
 * Pick the variant to buy from a product group: the one you buy most often by
 * default, unless another variant in the group has an active sale or a lower
 * price.
 */
export function chooseVariant(
  productIds: number[],
  preferredProductId: number,
  prices: Map<number, CartPrice>
): { productId: number; price?: CartPrice; reason?: string } {
  const preferredPrice = prices.get(preferredProductId);

  let bestId = preferredProductId;
  let bestPrice = preferredPrice;
  let bestEffective = preferredPrice?.effectivePrice ?? Number.POSITIVE_INFINITY;

  for (const productId of productIds) {
    const price = prices.get(productId);
    if (!price) continue;
    if (price.effectivePrice < bestEffective) {
      bestId = productId;
      bestPrice = price;
      bestEffective = price.effectivePrice;
    }
  }

  if (bestId === preferredProductId) {
    if (preferredPrice?.salePrice !== undefined) {
      return {
        productId: bestId,
        price: bestPrice,
        reason: `deal: -${preferredPrice.salePercent ?? 0}%`,
      };
    }
    return { productId: bestId, price: bestPrice };
  }

  const dealPercent = bestPrice?.salePercent;
  return {
    productId: bestId,
    price: bestPrice,
    reason: dealPercent ? `deal: -${dealPercent}%` : 'cheaper variant',
  };
}

function withDealReason(base: string, deal?: string): string {
  return deal ? `${base}; ${deal}` : base;
}

export interface WeeklyPlan {
  items: PlannedItem[];
  consumption: ConsumptionItem[];
  settings: BotSettingsShape;
}

export async function planWeeklyFill(
  userId: string,
  settings?: BotSettingsShape,
  options: { horizonDays?: number } = {}
): Promise<WeeklyPlan> {
  const effectiveSettings = settings ?? (await getBotSettings(userId));
  const { items } = await getWeeklyConsumption(userId, {
    horizonDays: options.horizonDays ?? effectiveSettings.horizonDays,
    deliveryLeadDays: effectiveSettings.deliveryLeadDays,
  });

  const due = items.filter((item) => item.qty > 0);

  return {
    items: due.map((item) => ({
      productId: item.productId,
      name: item.name,
      qty: item.qty,
      reason: item.reason,
      groupKey: item.groupKey,
      price: item.avgPrice,
    })),
    consumption: due,
    settings: effectiveSettings,
  };
}

export function weeklyCandidates(consumption: ConsumptionItem[]): FillCandidate[] {
  return consumption.map((item) => ({
    groupKey: item.groupKey,
    productIds: item.productIds,
    productId: item.productId,
    name: item.name,
    qty: item.qty,
    reason: item.reason,
    fallbackPrice: item.avgPrice,
  }));
}

/**
 * The one place that touches the Knuspr cart: skip what is already in it,
 * pick variants by live price, enforce the guardrails, add, record a BotRun.
 */
export async function executeCandidates(
  userId: string,
  derivedKey: Buffer | undefined,
  candidates: FillCandidate[],
  intent: FillResult['intent'],
  settings: BotSettingsShape,
  options: { confirm?: boolean } = {}
): Promise<FillResult> {
  if (!derivedKey) throw new Error('Session key missing — please re-login');

  const empty = (extra: Partial<FillResult> = {}): FillResult => ({
    status: 'nothing-to-add',
    intent,
    items: [],
    estimatedTotal: 0,
    maxEuro: settings.maxEuro,
    maxItems: settings.maxItems,
    ...extra,
  });
  if (candidates.length === 0) return empty();

  const session = await getKnusprSession(userId, derivedKey);
  const cart = await getCart(userId, session);
  const inCart = cartQuantityByProduct(cart);
  const prices = await fetchPrices(session, candidates.flatMap((candidate) => candidate.productIds));

  const skipped: string[] = [];
  const planned: PlannedItem[] = [];

  for (const candidate of candidates) {
    if (candidate.productIds.some((productId) => inCart.has(productId))) {
      skipped.push(candidate.name);
      continue;
    }
    const variant = chooseVariant(candidate.productIds, candidate.productId, prices);
    planned.push({
      productId: variant.productId,
      name: candidate.name,
      qty: candidate.qty,
      reason: withDealReason(candidate.reason, variant.reason),
      groupKey: candidate.groupKey,
      price: variant.price?.effectivePrice ?? candidate.fallbackPrice,
      ...(candidate.occasionId ? { occasionId: candidate.occasionId, servings: candidate.servings } : {}),
    });
  }

  const estimatedTotal = planned.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (planned.length === 0) return empty({ cart, skipped });

  if (!options.confirm && (estimatedTotal > settings.maxEuro || planned.length > settings.maxItems)) {
    return {
      status: 'requires-confirmation',
      intent,
      items: planned,
      estimatedTotal,
      cart,
      skipped,
      maxEuro: settings.maxEuro,
      maxItems: settings.maxItems,
    };
  }

  const { added, failed } = await addItems(
    session,
    planned.map((item) => ({ productId: item.productId, amount: item.qty }))
  );

  const addedIds = new Set(added.map((line) => line.productId));
  const addedItems = planned.filter((item) => addedIds.has(item.productId));
  const actualTotal = addedItems.reduce((sum, item) => sum + item.price * item.qty, 0);

  const run = await BotRun.create({
    userId,
    intent,
    items: addedItems,
    totalPrice: actualTotal,
    status: 'in-cart',
  });

  let updatedCart: NormalizedCart | null = cart;
  try {
    const raw = await checkCart(session);
    updatedCart = raw ? await normalizeCart(userId, raw) : cart;
  } catch {
    // Non-fatal: the run already records what was added.
  }

  return {
    status: addedItems.length > 0 ? 'added' : 'nothing-to-add',
    intent,
    items: addedItems,
    estimatedTotal: actualTotal,
    run,
    cart: updatedCart,
    skipped,
    failed: failed.map((entry) => ({ productId: entry.item.productId, error: entry.error })),
    maxEuro: settings.maxEuro,
    maxItems: settings.maxItems,
  };
}

/**
 * Execute a weekly fill. Returns `requires-confirmation` instead of adding
 * when the run exceeds the configured guardrails.
 */
export async function executeWeeklyFill(
  userId: string,
  derivedKey: Buffer | undefined,
  options: { confirm?: boolean; horizonDays?: number } = {}
): Promise<FillResult> {
  if (!derivedKey) throw new Error('Session key missing — please re-login');
  const plan = await planWeeklyFill(userId, undefined, { horizonDays: options.horizonDays });
  return executeCandidates(
    userId,
    derivedKey,
    weeklyCandidates(plan.consumption),
    { type: 'weekly' },
    plan.settings,
    { confirm: options.confirm }
  );
}
