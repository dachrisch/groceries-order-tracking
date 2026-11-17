/**
 * What a `+` will actually do, decided before anyone presses it.
 *
 * The location's destination says where a line *should* go, and `addTargetFor`
 * picks a line that can exist there. Neither of those knows whether the store is
 * reachable right now: a Knuspr row in Berlin has a perfectly valid line and an
 * unreachable store, so the button used to post anyway, collect a 409 and print
 * the refusal in red under the row.
 *
 * This module answers the question once, as a pure function, so every surface
 * that shows a `+` (a row, a due card, the product sheet) behaves the same and
 * the behaviour can be tested without a DOM.
 *
 * Reachability comes from `GET /api/location` — the same data the banner uses.
 * Nothing here is hard-coded by city, and nothing here writes anything.
 */
import { addTargetFor, targetFromOffer, type AddTarget, type BrowseItem, type BrowseOffer } from './browse';
import type { Destination, Provider } from './location';

/** One provider's reach, as `GET /api/location` reports it. */
export interface ProviderReach {
  provider: Provider;
  available: boolean;
  reason: string;
}

export type AddDecision =
  | { kind: 'add'; destination: Destination; item: AddTarget }
  | { kind: 'unavailable'; reason: string };

const STORE_DESTINATION: Record<Provider, Destination> = {
  knuspr: 'knuspr-cart',
  edeka: 'edeka-list',
};

/**
 * Where a line would go, or why it cannot go anywhere.
 *
 * An unknown location (`reach` is null, or silent about a provider) is never
 * turned into a refusal: the server shows both sources in that case, so the
 * button stays usable and the server stays the guard.
 */
export function resolveAdd(
  item: BrowseItem,
  destination: Destination,
  reach: ProviderReach[] | null | undefined,
  /** Set when the shopper pointed at one offer, e.g. "Where to get it". */
  pinned?: BrowseOffer
): AddDecision {
  const reachOf = (provider: Provider) => reach?.find((entry) => entry.provider === provider);
  const allowed = (provider: Provider) => reachOf(provider)?.available ?? true;

  // A checklist line never leaves the app, so no store's reach matters.
  if (destination === 'checklist') {
    const line: AddTarget = addTargetFor(item, destination)
      ?? { provider: item.offers[0]?.provider ?? 'knuspr', name: item.name };
    return { kind: 'add', destination: 'checklist', item: line };
  }

  const primary = pinned ? targetFromOffer(item, pinned) : addTargetFor(item, destination);
  if (!primary) return { kind: 'unavailable', reason: 'No store offers this product' };

  if (allowed(primary.provider)) {
    return { kind: 'add', destination: STORE_DESTINATION[primary.provider], item: primary };
  }

  // A pinned offer is not swapped for another store: the shopper pointed here.
  if (pinned) {
    return { kind: 'unavailable', reason: reachOf(pinned.provider)?.reason ?? 'Not orderable here' };
  }

  // The store this line belongs to cannot be reached here. A cross-store match
  // can still take it — that is the whole point of the link — but only when that
  // store is reachable and has an id to write.
  const alternative = item.offers.find(
    (offer) =>
      offer.provider !== primary.provider
      && allowed(offer.provider)
      && (offer.productId !== undefined || offer.textKey !== undefined)
  );
  if (alternative) {
    return {
      kind: 'add',
      destination: STORE_DESTINATION[alternative.provider],
      item: targetFromOffer(item, alternative),
    };
  }

  const reason = reachOf(primary.provider)?.reason;
  return { kind: 'unavailable', reason: reason ?? 'Not orderable here' };
}
