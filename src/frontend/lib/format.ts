/**
 * Small display helpers shared by the merged grocery pages.
 *
 * Nothing here knows about providers: a formatter that could merge two stores'
 * numbers would be the easiest place to break the "one rate per store" rule by
 * accident, so the per-provider split lives in the pages and the helpers stay
 * dumb.
 */

/** `4.2` -> `4.20€`; an unknown price is a dash, never a zero. */
export function euro(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}€` : '—';
}

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function monthLabel(date: Date): string {
  // Month starts are UTC (see `monthStart`), so format in UTC: a negative
  // offset must not label November as October.
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Whole days between a timestamp and now, or null when the date is unusable. */
export function daysSince(value: string | Date | null | undefined, now = new Date()): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

/** `2 d ago`, `today`, `3 weeks ago` — enough for a last-bought line. */
export function relativeDays(value: string | Date | null | undefined): string {
  const days = daysSince(value);
  if (days === null) return 'never';
  if (days <= 0) return 'today';
  if (days === 1) return '1 d ago';
  if (days < 14) return `${days} d ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** One provider's cadence. A null cadence means "not enough data", not zero. */
export function cadenceLabel(days: number | null | undefined): string {
  return typeof days === 'number' && days > 0 ? `every ~${Math.round(days)} d` : 'no rhythm yet';
}

/**
 * The cadence of a provider's basket as one span. Still one provider; this only
 * collapses several products of the same store into a readable range.
 */
export function cadenceRange(days: Array<number | null | undefined>): string {
  const known = days.filter((value): value is number => typeof value === 'number' && value > 0);
  if (known.length === 0) return 'no rhythm yet';
  const low = Math.round(Math.min(...known));
  const high = Math.round(Math.max(...known));
  return low === high ? `every ~${low} d` : `every ~${low}–${high} d`;
}
