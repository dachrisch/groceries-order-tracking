/**
 * The wire shapes of `GET /api/products`, plus the two lookups every grocery
 * surface needs.
 *
 * `statsByProvider` is keyed per provider and is never flattened: the type has
 * no single-stat shortcut, so a page cannot accidentally render one merged
 * number instead of one row per store.
 */
import type { Destination, Provider } from './location';

export interface ProductStat {
  provider: Provider;
  purchases: number;
  /** Null below the sample floor; never 0, which would mean "bought constantly". */
  cadenceDays: number | null;
  lastBought: string | null;
  avgPrice: number | null;
}

export interface BrowseOffer {
  provider: Provider;
  available: boolean;
  reason: string;
  price: number | null;
  productId?: number;
  textKey?: string;
}

export interface BrowseItem {
  /** `knuspr:<groupKey>` or `edeka:<textKey>`. */
  id: string;
  name: string;
  groupLabel: string | null;
  image: string | null;
  statsByProvider: Partial<Record<Provider, ProductStat>>;
  offers: BrowseOffer[];
  due: boolean;
  /** Knuspr only: estimated days of stock left. */
  stockDays: number | null;
  /**
   * True when the last purchase is older than the rate window: the row has a
   * name and a price but no cadence, stock or due date.
   */
  outsideWindow?: boolean;
  linked?: { confidence: number; source: 'auto' | 'manual' };
}

export interface ProductsResponse {
  now: string;
  horizonDays: number;
  location: { context: unknown; destination: Destination };
  /** Length of the rate window; rows outside it carry no cadence. */
  windowDays: number;
  counts: { total: number; due: number; empty: number };
  items: BrowseItem[];
}

export interface GroupProduct {
  _id: number;
  name?: string;
  textualAmount?: string;
  image?: string;
}

export interface ProductGroup {
  /**
   * The manual group's document id. `GET /api/bot/groups` rebuilds groups from
   * rules and currently drops it, so it is optional here on purpose: a Split
   * needs it and must not call the endpoint with `undefined`.
   */
  _id?: string;
  id?: string;
  key: string;
  label: string;
  productIds: number[];
  manual: boolean;
  products: GroupProduct[];
}

const PROVIDERS: Provider[] = ['knuspr', 'edeka'];

/** The stores this row has learned data from, in a stable order. */
export function providersOf(item: BrowseItem): Provider[] {
  return PROVIDERS.filter((provider) => item.statsByProvider[provider] !== undefined);
}

export function offerFor(item: BrowseItem, provider: Provider): BrowseOffer | undefined {
  return item.offers.find((offer) => offer.provider === provider);
}

/** The price to show on a row: the delivery price wins when both stores have one. */
export function priceOf(item: BrowseItem): number | null {
  const offer = offerFor(item, 'knuspr') ?? offerFor(item, 'edeka');
  if (offer?.price !== undefined && offer.price !== null) return offer.price;
  const stat = item.statsByProvider.knuspr ?? item.statsByProvider.edeka;
  return stat?.avgPrice ?? null;
}

export interface AddTarget {
  provider: Provider;
  name: string;
  productId?: number;
  textKey?: string;
  qty?: number;
}

/**
 * Which line a plain `+` should send for this row.
 *
 * The destination comes from the location, but a row that only one store knows
 * cannot travel to the other store's basket — the server would skip it and the
 * button would read as broken. So the matching offer of the destination's store
 * wins, and the row's own store is the fallback. Availability is still checked
 * server-side; this only picks a line that can exist.
 */
export function addTargetFor(item: BrowseItem, destination: Destination): AddTarget | null {
  const preferred: Provider = destination === 'edeka-list' ? 'edeka' : 'knuspr';
  const fallback: Provider = preferred === 'knuspr' ? 'edeka' : 'knuspr';
  const offer = offerFor(item, preferred) ?? offerFor(item, fallback);
  if (!offer) return null;
  return {
    provider: offer.provider,
    name: item.name,
    productId: offer.productId,
    textKey: offer.textKey,
  };
}

/** A short stock line for a row: Knuspr has stock, EDEKA only has a cadence. */
export function stockLabel(item: BrowseItem): string {
  if (item.stockDays !== null) {
    if (item.stockDays <= 0) return 'empty';
    return `~${Math.round(item.stockDays)} d left`;
  }
  const stat = item.statsByProvider.edeka;
  if (stat?.cadenceDays) return `every ~${Math.round(stat.cadenceDays)} d`;
  return item.due ? 'due' : '';
}
