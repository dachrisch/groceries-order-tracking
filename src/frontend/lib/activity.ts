/**
 * The wire shapes of `GET /api/activity` and `GET /api/activity/:id`.
 *
 * Dates arrive as ISO strings (Express serialises `PurchaseEvent.at`), and the
 * provider always travels with the event. A caller cannot build a merged total
 * from these types without deliberately adding two numbers, which is the point:
 * every figure on the activity page names its store.
 */
import { providerLabel } from './location';
import type { Provider } from './location';

export interface OccasionRef {
  id: string;
  name: string;
  servings: number;
}

export interface ActivitySummary {
  /** `knuspr:<orderId>` or `edeka:<sessionId>`. */
  id: string;
  provider: Provider;
  kind: 'delivery' | 'store-run';
  at: string;
  place: string | null;
  total: number;
  itemCount: number;
  occasionIds: string[];
  /** Set when a bot run produced this basket; the undo handle. */
  runId: string | null;
  canUndo: boolean;
  lineCount: number;
  occasions: OccasionRef[];
}

export interface ActivityResponse {
  events: ActivitySummary[];
  /** Totals over the events returned, per source. `all` exists but no view uses it. */
  totals: { knuspr: number; edeka: number; all: number; count: number };
}

export interface ActivityLine {
  provider: Provider;
  productKey: string;
  name: string;
  qty: number;
  unitPrice: number | null;
  productId: number | null;
  image?: string | null;
}

export interface ActivityDetail extends Omit<ActivitySummary, 'lineCount'> {
  lines: ActivityLine[];
}

/** What a row is called when it has no place: the store kind is the title. */
export function activityTitle(event: Pick<ActivitySummary, 'provider' | 'place' | 'kind'>): string {
  if (event.place?.trim()) return event.place;
  return event.kind === 'delivery' ? 'Knuspr delivery' : `${providerLabel(event.provider)} shop run`;
}

/**
 * The month a timeline view is looking at, as an inclusive date range. The
 * current month stops at "now" so a future cart cannot appear in a spend figure.
 *
 * Built in UTC because the API's date filters and the consumption model both
 * compare UTC timestamps; a local-midnight start would pull a few hours of the
 * previous month into this one.
 */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function monthRange(start: Date, now = new Date()): { from: Date; to: Date } {
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const current =
    start.getUTCFullYear() === now.getUTCFullYear() && start.getUTCMonth() === now.getUTCMonth();
  return { from: start, to: current ? now : new Date(end.getTime() - 1) };
}

export function shiftMonth(start: Date, offset: number): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
}
