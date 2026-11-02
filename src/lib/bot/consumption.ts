import mongoose from 'mongoose';
import Order from '../../models/Order';
import Occasion from '../../models/Occasion';
import { getProductGroups, leafCategory, parseSize, type KnusprCategory } from './product-groups';

/**
 * Weekly consumption model.
 *
 * This replaces the ad-hoc aggregation that used to live in the inventory
 * controller. It learns a regular consumption rate per product group and
 * estimates current stock, so both the Inventory page and the bot agree on
 * what is due.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 182; // ~26 weeks
const HALF_LIFE_DAYS = 56; // ~8 weeks
const MIN_WEEKS = 3;

export interface ConsumptionOptions {
  now?: Date;
  windowDays?: number;
  horizonDays?: number;
  deliveryLeadDays?: number;
  /** Purchases to ignore, as `${orderId}:${productId}` keys (occasion baskets). */
  excludePurchases?: Set<string>;
}

export interface Purchase {
  orderId: number;
  productId: number;
  date: Date;
  /** Number of packs bought. */
  amount: number;
  /** Base units per pack (g/ml/pieces). */
  packSize: number;
  /** Unit of packSize; 'piece' when the size could not be parsed. */
  packUnit?: 'g' | 'ml' | 'piece';
  /** Price per pack. */
  unitPrice: number;
  name: string;
  image?: string;
  categories?: KnusprCategory[];
  groupKey: string;
  groupLabel: string;
  groupProductIds: number[];
}

export interface ConsumptionItem {
  groupKey: string;
  groupLabel: string;
  productIds: number[];
  /** Product to put in the cart by default: most often bought in the group. */
  productId: number;
  name: string;
  image?: string;
  categories?: KnusprCategory[];
  packSize: number;
  modeAmount: number;
  purchaseCount: number;
  weeksPurchased: number;
  lastPurchase: Date;
  intervalDays: number;
  ratePerDay: number;
  stock: number;
  stockDays: number;
  qty: number;
  due: boolean;
  horizonDays: number;
  avgPrice: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface ConsumptionResult {
  items: ConsumptionItem[];
  referenceNow: Date;
  windowStart: Date;
}

function isoWeekKey(date: Date): string {
  const thursday = new Date(date);
  thursday.setUTCHours(0, 0, 0, 0);
  const day = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Median with the extreme 10% trimmed when there are enough samples. */
export function trimmedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 5) return median(sorted);
  const trim = Math.max(1, Math.floor(sorted.length * 0.1));
  return median(sorted.slice(trim, sorted.length - trim));
}

export function mode(values: number[]): number {
  if (values.length === 0) return 1;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 1;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 1;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

interface GroupedPurchases {
  groupKey: string;
  purchases: Purchase[];
}

function groupPurchases(purchases: Purchase[]): GroupedPurchases[] {
  const map = new Map<string, Purchase[]>();
  for (const purchase of purchases) {
    const list = map.get(purchase.groupKey) ?? [];
    list.push(purchase);
    map.set(purchase.groupKey, list);
  }
  return [...map.entries()].map(([groupKey, list]) => ({
    groupKey,
    purchases: list.sort((a, b) => a.date.getTime() - b.date.getTime()),
  }));
}

/**
 * Pure consumption calculation. Exposed separately so tests can feed
 * synthetic histories without touching MongoDB.
 */
export function computeConsumption(purchases: Purchase[], options: ConsumptionOptions = {}): ConsumptionResult {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const horizonDays = (options.horizonDays ?? 7) + (options.deliveryLeadDays ?? 2);
  const exclude = options.excludePurchases ?? new Set<string>();

  const referenceNow = now;
  const windowStart = new Date(referenceNow.getTime() - windowDays * DAY_MS);

  const filtered = purchases.filter(
    (purchase) =>
      purchase.date >= windowStart &&
      purchase.date <= referenceNow &&
      !exclude.has(`${purchase.orderId}:${purchase.productId}`)
  );

  const items: ConsumptionItem[] = [];

  for (const group of groupPurchases(filtered)) {
    const purchasesInWindow = group.purchases;
    if (purchasesInWindow.length === 0) continue;

    const distinctWeeks = new Set(purchasesInWindow.map((purchase) => isoWeekKey(purchase.date)));
    if (distinctWeeks.size < MIN_WEEKS) continue;

    const intervals: number[] = [];
    for (let i = 1; i < purchasesInWindow.length; i++) {
      intervals.push(
        (purchasesInWindow[i].date.getTime() - purchasesInWindow[i - 1].date.getTime()) / DAY_MS
      );
    }
    const medianInterval = trimmedMedian(intervals);
    if (medianInterval <= 0) continue;

    const lastPurchase = purchasesInWindow[purchasesInWindow.length - 1];
    const daysSinceLastAtReference = (referenceNow.getTime() - lastPurchase.date.getTime()) / DAY_MS;
    if (daysSinceLastAtReference > medianInterval * 2.5) continue;

    // Time-decayed rate: each purchase represents the interval since the
    // previous one. Older purchases count less (8-week half-life), so a
    // changed habit wins, while a two-weekly shopper still gets a two-weekly
    // rate instead of a weekly one.
    let weightedUnits = 0;
    let weightedDays = 0;
    for (let index = 0; index < purchasesInWindow.length; index++) {
      const purchase = purchasesInWindow[index];
      const previous = purchasesInWindow[index - 1];
      const deltaDays = previous
        ? Math.max(0.5, (purchase.date.getTime() - previous.date.getTime()) / DAY_MS)
        : Math.max(0.5, intervals[0] ?? 7);
      const ageDays = Math.max(0, (referenceNow.getTime() - purchase.date.getTime()) / DAY_MS);
      const weight = 0.5 ** (ageDays / HALF_LIFE_DAYS);
      weightedUnits += weight * purchase.amount * purchase.packSize;
      weightedDays += weight * deltaDays;
    }

    const ratePerDay = weightedDays > 0 ? weightedUnits / weightedDays : 0;
    if (ratePerDay <= 0) continue;

    const packSize = lastPurchase.packSize;
    const lastUnits = lastPurchase.amount * packSize;
    const daysSinceLast = Math.max(0, (now.getTime() - lastPurchase.date.getTime()) / DAY_MS);
    const stock = Math.max(0, lastUnits - ratePerDay * daysSinceLast);
    const stockDays = ratePerDay > 0 ? stock / ratePerDay : Number.POSITIVE_INFINITY;

    const neededUnits = ratePerDay * horizonDays - stock;
    let qty = 0;
    const modeAmount = mode(purchasesInWindow.map((purchase) => purchase.amount));
    if (neededUnits > 0) {
      qty = Math.ceil(neededUnits / packSize);
      // Round up to the usual pack count for bulk buyers (need 3, usually 2 → 4).
      if (modeAmount >= 2 && qty >= modeAmount) {
        qty = Math.ceil(qty / modeAmount) * modeAmount;
      }
      qty = Math.max(1, qty);
    }

    const productCounts = new Map<number, { count: number; lastDate: Date }>();
    for (const purchase of purchasesInWindow) {
      const entry = productCounts.get(purchase.productId) ?? { count: 0, lastDate: purchase.date };
      entry.count++;
      if (purchase.date > entry.lastDate) entry.lastDate = purchase.date;
      productCounts.set(purchase.productId, entry);
    }
    const representativeId = [...productCounts.entries()].sort(
      (a, b) => b[1].count - a[1].count || b[1].lastDate.getTime() - a[1].lastDate.getTime()
    )[0][0];
    const representative = purchasesInWindow.filter((purchase) => purchase.productId === representativeId).pop()!;

    const intervalDays = packSize / ratePerDay;
    const cv = coefficientOfVariation(intervals);
    const confidence: ConsumptionItem['confidence'] =
      distinctWeeks.size >= 6 && cv <= 0.6 ? 'high' : distinctWeeks.size >= 4 ? 'medium' : 'low';

    const due = neededUnits > 0;
    const reason = due
      ? stockDays <= 0
        ? `every ~${Math.round(intervalDays)}d, stock ~0`
        : `every ~${Math.round(intervalDays)}d, stock ~${Math.round(stockDays)}d`
      : `every ~${Math.round(intervalDays)}d, last bought ${Math.round(daysSinceLast)}d ago`;

    const avgPrice = purchasesInWindow.reduce((sum, purchase) => sum + purchase.unitPrice, 0) / purchasesInWindow.length;

    items.push({
      groupKey: group.groupKey,
      groupLabel: lastPurchase.groupLabel,
      productIds: lastPurchase.groupProductIds,
      productId: representative.productId,
      name: representative.name,
      image: representative.image,
      categories: representative.categories,
      packSize,
      modeAmount,
      purchaseCount: purchasesInWindow.length,
      weeksPurchased: distinctWeeks.size,
      lastPurchase: lastPurchase.date,
      intervalDays,
      ratePerDay,
      stock,
      stockDays,
      qty,
      due,
      horizonDays,
      avgPrice,
      confidence,
      reason,
    });
  }

  items.sort((a, b) => a.stockDays - b.stockDays);
  return { items, referenceNow, windowStart };
}

/** Load purchases for a user, grouped by product group. */
export async function loadPurchases(userId: string, options: ConsumptionOptions = {}): Promise<{
  purchases: Purchase[];
  referenceNow: Date;
  windowStart: Date;
}> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;

  const referenceNow = now;
  const windowStart = new Date(referenceNow.getTime() - windowDays * DAY_MS);

  const groups = await getProductGroups(userId);
  const groupByProduct = new Map<number, { key: string; label: string; productIds: number[] }>();
  for (const group of groups) {
    for (const productId of group.productIds) {
      groupByProduct.set(productId, { key: group.key, label: group.label, productIds: group.productIds });
    }
  }

  const orders = await Order.find({ userId, orderTimeDate: { $gte: windowStart } })
    .sort({ orderTimeDate: 1 })
    .select('id orderTimeDate items')
    .lean();

  const purchases: Purchase[] = [];
  for (const order of orders) {
    for (const item of order.items ?? []) {
      const group = groupByProduct.get(item.id);
      if (!group) continue;
      const parsedSize = parseSize(item.textualAmount, item.unit);
      purchases.push({
        orderId: order.id,
        productId: item.id,
        date: new Date(order.orderTimeDate),
        amount: Math.max(1, item.amount ?? 1),
        packSize: parsedSize?.value ?? 1,
        packUnit: parsedSize?.unit ?? 'piece',
        unitPrice: item.priceComposition?.unit?.amount ?? 0,
        name: item.name,
        image: item.images?.[0],
        categories: item.categories,
        groupKey: group.key,
        groupLabel: group.label,
        groupProductIds: group.productIds,
      });
    }
  }

  return { purchases, referenceNow, windowStart };
}

/**
 * Purchases that belong to a detected occasion basket are excluded from the
 * regular weekly rate; otherwise pizza night inflates the weekly mozzarella.
 */
export async function loadOccasionExclusions(userId: string): Promise<Set<string>> {
  const occasions = await Occasion.find({ userId }).select('sourceOrders').lean();
  const excluded = new Set<string>();
  for (const occasion of occasions) {
    for (const source of occasion.sourceOrders ?? []) {
      for (const productId of source.productIds ?? []) {
        excluded.add(`${source.orderId}:${productId}`);
      }
    }
  }
  return excluded;
}

export interface WeeklyConsumptionResult extends ConsumptionResult {
  referenceNow: Date;
  windowStart: Date;
}

/** Full pipeline used by the Inventory page and the bot. */
export async function getWeeklyConsumption(
  userId: string,
  options: ConsumptionOptions = {}
): Promise<WeeklyConsumptionResult> {
  const excludePurchases = options.excludePurchases ?? (await loadOccasionExclusions(userId));
  const { purchases } = await loadPurchases(userId, options);
  const result = computeConsumption(purchases, { ...options, excludePurchases });
  return result;
}

/** Map a group's product IDs to a human label for the cart/reason text. */
export function groupLabelFor(item: ConsumptionItem): string {
  return item.groupLabel || item.name;
}

/** Leaf category of a consumption item (used for UI grouping). */
export function consumptionLeafCategory(item: ConsumptionItem): string {
  return leafCategory(item.categories);
}

export function toObjectId(userId: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(userId);
}
