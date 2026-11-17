/**
 * Where the shopper is, and what that makes orderable.
 *
 * The app has two grocery sources with completely different reach: Knuspr
 * delivers inside Munich only, EDEKA is a shop you walk into anywhere in
 * Germany. Availability therefore depends on location, but location is only
 * ever allowed to change *defaults and copy* — never to write to a cart or a
 * list on its own.
 *
 * Three rules hold everywhere:
 *  - a provider's availability always carries a human reason;
 *  - an unknown location shows both sources rather than guessing one away;
 *  - nothing here reads the database, so it is all pure and testable.
 */

export type Provider = 'knuspr' | 'edeka';

/** Where an action will land. Knuspr has a cart; EDEKA has a list, not a checkout. */
export type Destination = 'knuspr-cart' | 'edeka-list' | 'checklist';

export interface AwayWindow {
  from: Date;
  to: Date;
  city: string;
}

export interface LocationSettings {
  /** The city the shopper lives in. Null until they set one. */
  homeCity: string | null;
  /** ISO 3166-1 alpha-2. Knuspr and EDEKA both only exist in Germany. */
  homeCountry: string | null;
  /** Derived automatically for dates outside homeCity; editable for corrections. */
  awayWindows: AwayWindow[];
}

export interface LocationContext {
  source: 'home' | 'away' | 'unknown';
  city: string | null;
  country: string | null;
  awayWindow?: AwayWindow;
}

export interface ProviderAvailability {
  provider: Provider;
  available: boolean;
  /** Shown next to the disabled state; never empty. */
  reason: string;
}

/**
 * One provider's view of a product. Rates are never merged across providers:
 * a Knuspr delivery cadence and an in-store cadence describe different habits,
 * and adding them would double-count a week that had both.
 */
export interface ProductStat {
  provider: Provider;
  /** Distinct purchases or shopping trips that included this product. */
  purchases: number;
  /** Median days between purchases; null below the sample floor. */
  cadenceDays: number | null;
  lastBought: Date | null;
  avgPrice: number | null;
}

/** Knuspr deliverable cities. `München`, `Munchen` and `Munich` are one place. */
const KNUSPR_CITIES = new Set(['munich', 'muenchen', 'munchen']);

const GERMANY = 'DE';

/** Lowercase, de-umlauted, letters only — so city input needs no ceremony. */
export function normalizeCity(city: string): string {
  return city
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');
}

function dayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Inclusive of both ends, compared by calendar day: an away trip ends at midnight. */
export function isWithin(window: AwayWindow, now: Date): boolean {
  const day = dayStart(now);
  return day >= dayStart(new Date(window.from)) && day <= dayStart(new Date(window.to));
}

/**
 * Resolve where the shopper is. An away window wins over the home city, which is
 * what makes a date outside homeCity imply "away" without the user maintaining a
 * list of trips.
 */
export function resolveLocation(now: Date, settings: LocationSettings): LocationContext {
  const country = settings.homeCountry ?? GERMANY;
  const active = settings.awayWindows.find((window) => isWithin(window, now));
  if (active) {
    return { source: 'away', city: active.city, country: countryFor(active.city, country), awayWindow: active };
  }
  if (!settings.homeCity) return { source: 'unknown', city: null, country };
  return { source: 'home', city: settings.homeCity, country };
}

/**
 * A name we cannot place (a trip to "Italy") is treated as abroad only when the
 * caller told us the home country differs. Domestic trips keep the home country.
 */
function countryFor(city: string, homeCountry: string): string {
  return isKnownGermanCity(city) ? GERMANY : homeCountry;
}

/**
 * Cities we can confidently call German. This list is deliberately short: it only
 * decides *presentation* (an unavailable source vs. an absent one), never a write.
 */
const GERMAN_CITIES = new Set([
  'berlin', 'hamburg', 'muenchen', 'munchen', 'munich', 'koeln', 'cologne', 'frankfurt',
  'stuttgart', 'duesseldorf', 'dusseldorf', 'leipzig', 'dresden', 'hannover', 'nuernberg',
  'nurnberg', 'bremen', 'essen', 'dortmund', 'bonn', 'muenster', 'karlsruhe', 'freiburg',
]);

export function isKnownGermanCity(city: string): boolean {
  return GERMAN_CITIES.has(normalizeCity(city));
}

export function isKnusprCity(city: string | null): boolean {
  return city !== null && KNUSPR_CITIES.has(normalizeCity(city));
}

/**
 * Can this provider be ordered from, here and now?
 *
 * An unknown location is never used to hide a source: both stay available and the
 * reason says why, so the user can fix it in one tap instead of wondering where a
 * store went.
 */
export function availability(provider: Provider, context: LocationContext): ProviderAvailability {
  if (context.source === 'unknown') {
    return {
      provider,
      available: true,
      reason: 'Location not set — showing both sources',
    };
  }

  const abroad = (context.country ?? GERMANY).toUpperCase() !== GERMANY;

  if (provider === 'knuspr') {
    if (isKnusprCity(context.city)) {
      return { provider, available: true, reason: 'Delivers here' };
    }
    return {
      provider,
      available: false,
      reason: abroad ? 'Knuspr delivers in Munich only' : 'Knuspr delivers in Munich only — not here',
    };
  }

  if (abroad) {
    return { provider, available: false, reason: 'EDEKA stores are in Germany only' };
  }
  return { provider, available: true, reason: 'Shop in person' };
}

export function availabilityFor(context: LocationContext): ProviderAvailability[] {
  return [availability('knuspr', context), availability('edeka', context)];
}

/**
 * The destination a plain "+" should use. Derived, never stored as a preference:
 * the first available provider wins, and when neither is reachable the action
 * falls back to a plain checklist so nothing is silently dropped.
 */
export function derivedDestination(context: LocationContext): Destination {
  if (availability('knuspr', context).available) return 'knuspr-cart';
  if (availability('edeka', context).available) return 'edeka-list';
  return 'checklist';
}

/** One-line explanation for the destination, used verbatim by the UI. */
export function destinationReason(context: LocationContext): string {
  const knuspr = availability('knuspr', context);
  if (knuspr.available) return 'Knuspr delivers here — + fills the cart';
  const edeka = availability('edeka', context);
  if (edeka.available) return 'Knuspr does not deliver here, so + writes to your EDEKA list';
  return 'No source reaches here — + keeps items on a checklist';
}
