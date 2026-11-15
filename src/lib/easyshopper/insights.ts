/**
 * Deterministic insights from in-store purchases: what was actually bought, where,
 * and for how much. No LLM — this is the data the list generator leans on when it
 * prefers "the one I bought last time".
 */
import { normalizeName } from '../bot/product-groups';

export interface PurchaseItemLike {
  brand?: string | null;
  name: string;
  quantity?: number | null;
  unitPrice?: number | null;
  lineTotal?: number | null;
  isCredit?: boolean;
}

export interface PurchaseSessionLike {
  purchasedAt: Date | string;
  store: string;
  total: number;
  items: PurchaseItemLike[];
}

export interface PurchaseInsights {
  totals: {
    sessions: number;
    rows: number;
    units: number;
    spend: number;
    /** Money returned via Leergut/Pfand, shown separately from spend. */
    creditReturned: number;
    averageBasket: number;
    firstPurchaseAt: string | null;
    lastPurchaseAt: string | null;
  };
  stores: Array<{ store: string; visits: number; spend: number; averageBasket: number }>;
  monthly: Array<{ month: string; spend: number; visits: number }>;
  topProducts: Array<{
    brand: string | null;
    name: string;
    units: number;
    spend: number;
    /** Number of distinct shopping trips that included it. */
    trips: number;
    lastBoughtAt: string;
  }>;
}

/**
 * Canonical store key. The same shop shows up as "Marktkauf Musterstadt" and
 * "Edeka Musterstadt (MUSTERSTR.)" depending on the receipt, so the
 * street suffix is stripped before grouping.
 */
export function storeKey(store: string): string {
  return store
    .toUpperCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * POS summary lines are not products: "Summenart.129999EH KäseBEerm." is the till's
 * own aggregation row and would otherwise dominate the "most bought" ranking.
 */
export function isAggregateLine(name: string): boolean {
  return /^summenart\b/i.test(name.trim());
}

/** Grouping key: brand + normalised name, so pack-size variants collapse together. */
export function productKey(item: PurchaseItemLike): string {
  const brand = (item.brand ?? '').trim().toLowerCase();
  return `${brand}|${normalizeName(item.name).normalized || item.name.toLowerCase()}`;
}

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function summarizePurchases(sessions: PurchaseSessionLike[]): PurchaseInsights {
  const byStore = new Map<string, { label: string; visits: number; spend: number }>();
  const byMonth = new Map<string, { spend: number; visits: number }>();
  const byProduct = new Map<
    string,
    { brand: string | null; name: string; units: number; spend: number; trips: Set<string>; last: Date }
  >();

  let spend = 0;
  let creditReturned = 0;
  let rows = 0;
  let units = 0;
  let first: Date | null = null;
  let last: Date | null = null;

  for (const session of sessions) {
    const date = session.purchasedAt instanceof Date ? session.purchasedAt : new Date(session.purchasedAt);
    if (Number.isNaN(date.getTime())) continue;

    spend += session.total;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;

    const key = storeKey(session.store);
    const store = byStore.get(key) ?? { label: session.store, visits: 0, spend: 0 };
    store.visits += 1;
    store.spend += session.total;
    // Keep the most descriptive spelling (the one with the street).
    if (session.store.length > store.label.length) store.label = session.store;
    byStore.set(key, store);

    const month = monthOf(date);
    const monthEntry = byMonth.get(month) ?? { spend: 0, visits: 0 };
    monthEntry.visits += 1;
    monthEntry.spend += session.total;
    byMonth.set(month, monthEntry);

    for (const item of session.items ?? []) {
      const lineTotal = item.lineTotal ?? 0;
      const quantity = item.quantity ?? 1;
      rows += 1;
      units += quantity;

      if (item.isCredit || lineTotal < 0) {
        creditReturned += lineTotal;
        continue; // a deposit return is money back, not a purchase
      }
      if (isAggregateLine(item.name)) continue; // till summary row, not a product

      const key = productKey(item);
      const entry =
        byProduct.get(key) ??
        { brand: item.brand ?? null, name: item.name, units: 0, spend: 0, trips: new Set<string>(), last: date };
      entry.units += quantity;
      entry.spend += lineTotal;
      entry.trips.add(`${date.toISOString()}|${session.store}`);
      if (date > entry.last) {
        entry.last = date;
        entry.name = item.name;
        entry.brand = item.brand ?? null;
      }
      byProduct.set(key, entry);
    }
  }

  const round = (value: number) => Number(value.toFixed(2));

  return {
    totals: {
      sessions: sessions.length,
      rows,
      units,
      spend: round(spend),
      creditReturned: round(creditReturned),
      averageBasket: sessions.length ? round(spend / sessions.length) : 0,
      firstPurchaseAt: first ? first.toISOString() : null,
      lastPurchaseAt: last ? last.toISOString() : null,
    },
    stores: [...byStore.values()]
      .map((entry) => ({
        store: entry.label,
        visits: entry.visits,
        spend: round(entry.spend),
        averageBasket: round(entry.spend / entry.visits),
      }))
      .sort((a, b) => b.spend - a.spend),
    monthly: [...byMonth.entries()]
      .map(([month, entry]) => ({ month, spend: round(entry.spend), visits: entry.visits }))
      .sort((a, b) => b.month.localeCompare(a.month)),
    topProducts: [...byProduct.values()]
      .map((entry) => ({
        brand: entry.brand,
        name: entry.name,
        units: entry.units,
        spend: round(entry.spend),
        trips: entry.trips.size,
        lastBoughtAt: entry.last.toISOString(),
      }))
      .sort((a, b) => b.trips - a.trips || b.spend - a.spend),
  };
}
