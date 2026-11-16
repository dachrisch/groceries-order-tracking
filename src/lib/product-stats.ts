/**
 * Per-provider product statistics.
 *
 * Everything here is deliberately one-sided: a `ProductStat` knows which provider
 * it came from, and no function in this file ever combines two. That is the
 * mechanical part of "weekly rates stay per store" — the UI can render one row
 * per provider, and a merged figure cannot be produced by accident.
 */
import type { ConsumptionItem } from './bot/consumption';
import { productKey, type PurchaseItemLike, type PurchaseSessionLike } from './easyshopper/insights';
import type { ProductStat } from './providers';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Three trips before a cadence is claimed, matching the bot's own floor. */
const MIN_PURCHASES_FOR_CADENCE = 3;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / DAY_MS;
}

/** A Knuspr group's cadence as the bot already learned it. */
export function knusprStat(item: ConsumptionItem): ProductStat {
  return {
    provider: 'knuspr',
    purchases: item.purchaseCount,
    cadenceDays: item.purchaseCount >= MIN_PURCHASES_FOR_CADENCE ? Math.round(item.intervalDays) : null,
    lastBought: item.lastPurchase ?? null,
    avgPrice: Number.isFinite(item.avgPrice) ? Number(item.avgPrice.toFixed(2)) : null,
  };
}

export interface EdekaProductAgg extends ProductStat {
  textKey: string;
  name: string;
  brand: string | null;
  /** Most recent unit price, which is what a list would be priced at. */
  lastPrice: number | null;
}

/**
 * Collapse in-store receipts into one bucket per `productKey()`.
 *
 * `purchases` counts trips, not rows: buying the same milk twice in one run is
 * one habit signal, not two. Deposit returns are skipped (they are not products).
 */
export function aggregateEdeka(
  sessions: Array<PurchaseSessionLike & { items?: PurchaseItemLike[] | null }>
): Map<string, EdekaProductAgg> {
  interface Bucket {
    name: string;
    brand: string | null;
    trips: number[];
    prices: Array<{ at: number; price: number }>;
  }
  const buckets = new Map<string, Bucket>();

  for (const session of sessions) {
    const at = asDate(session.purchasedAt);
    const seenInTrip = new Set<string>();

    for (const item of session.items ?? []) {
      if (item.isCredit) continue;
      const key = productKey(item);
      if (seenInTrip.has(key)) continue;
      seenInTrip.add(key);

      const bucket = buckets.get(key) ?? { name: item.name, brand: item.brand ?? null, trips: [], prices: [] };
      bucket.trips.push(at.getTime());
      if (typeof item.unitPrice === 'number') bucket.prices.push({ at: at.getTime(), price: item.unitPrice });
      // Keep the longest name we saw; receipt rows are sometimes truncated.
      if (item.name.length > bucket.name.length) bucket.name = item.name;
      buckets.set(key, bucket);
    }
  }

  const result = new Map<string, EdekaProductAgg>();
  for (const [key, bucket] of buckets) {
    const trips = bucket.trips.sort((a, b) => a - b);
    const dates = trips.map((value) => new Date(value));
    const gaps: number[] = [];
    for (let index = 1; index < dates.length; index += 1) {
      gaps.push(daysBetween(dates[index - 1], dates[index]));
    }
    const last = dates[dates.length - 1] ?? null;
    const prices = bucket.prices.sort((a, b) => a.at - b.at);
    const avg = prices.length
      ? prices.reduce((sum, entry) => sum + entry.price, 0) / prices.length
      : null;

    result.set(key, {
      provider: 'edeka',
      textKey: key,
      name: bucket.name,
      brand: bucket.brand,
      purchases: trips.length,
      cadenceDays: gaps.length && trips.length >= MIN_PURCHASES_FOR_CADENCE ? Math.round(median(gaps)) : null,
      lastBought: last,
      avgPrice: avg === null ? null : Number(avg.toFixed(2)),
      lastPrice: prices.length ? prices[prices.length - 1].price : null,
    });
  }
  return result;
}

/**
 * Is an in-store product due again?
 *
 * There is no stock model for a shop receipt — we only know when it was bought.
 * So "due" here means the learned cadence is nearly elapsed, and a product with
 * fewer than three trips is never called due: a guess would be worse than silence.
 */
export function edekaDue(stat: ProductStat, now: Date): boolean {
  if (stat.cadenceDays === null || !stat.lastBought) return false;
  return daysBetween(asDate(stat.lastBought), now) >= stat.cadenceDays * 0.9;
}
