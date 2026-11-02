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
}

export interface FillResult {
  status: 'added' | 'requires-confirmation' | 'nothing-to-add';
  intent: { type: 'weekly' | 'occasion'; occasion?: string; occasionId?: string; servings?: number };
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

export async function planWeeklyFill(userId: string, settings?: BotSettingsShape): Promise<WeeklyPlan> {
  const effectiveSettings = settings ?? (await getBotSettings(userId));
  const { items } = await getWeeklyConsumption(userId, {
    horizonDays: effectiveSettings.horizonDays,
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

/**
 * Execute a weekly fill. Returns `requires-confirmation` instead of adding
 * when the run exceeds the configured guardrails.
 */
export async function executeWeeklyFill(
  userId: string,
  derivedKey: Buffer | undefined,
  options: { confirm?: boolean } = {}
): Promise<FillResult> {
  if (!derivedKey) throw new Error('Session key missing — please re-login');

  const plan = await planWeeklyFill(userId);
  const settings = plan.settings;
  const intent: FillResult['intent'] = { type: 'weekly' };

  if (plan.items.length === 0) {
    return {
      status: 'nothing-to-add',
      intent,
      items: [],
      estimatedTotal: 0,
      maxEuro: settings.maxEuro,
      maxItems: settings.maxItems,
    };
  }

  const session = await getKnusprSession(userId, derivedKey);
  const cart = await getCart(userId, session);
  const inCart = cartQuantityByProduct(cart);

  const allGroupProductIds = plan.consumption.flatMap((item) => item.productIds);
  const prices = await fetchPrices(session, allGroupProductIds);

  const skipped: string[] = [];
  const planned: PlannedItem[] = [];

  for (const item of plan.consumption) {
    if (item.productIds.some((productId) => inCart.has(productId))) {
      skipped.push(item.groupLabel || item.name);
      continue;
    }

    const variant = chooseVariant(item.productIds, item.productId, prices);
    const price = variant.price?.effectivePrice ?? item.avgPrice;
    planned.push({
      productId: variant.productId,
      name: item.name,
      qty: item.qty,
      reason: withDealReason(item.reason, variant.reason),
      groupKey: item.groupKey,
      price,
    });
  }

  const estimatedTotal = planned.reduce((sum, item) => sum + item.price * item.qty, 0);

  if (planned.length === 0) {
    return {
      status: 'nothing-to-add',
      intent,
      items: [],
      estimatedTotal: 0,
      cart,
      skipped,
      maxEuro: settings.maxEuro,
      maxItems: settings.maxItems,
    };
  }

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
