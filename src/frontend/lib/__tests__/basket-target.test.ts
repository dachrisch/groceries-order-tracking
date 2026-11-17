import { describe, it, expect } from 'vitest';
import { resolveAdd, type ProviderReach } from '../basket-target';
import type { BrowseItem } from '../browse';

/**
 * These cases are the ones the browser showed: a Knuspr row's `+` was enabled in
 * Berlin, posted a Knuspr cart line and printed the server's refusal in red.
 */

const AWAY: ProviderReach[] = [
  { provider: 'knuspr', available: false, reason: 'Knuspr delivers in Munich only — not here' },
  { provider: 'edeka', available: true, reason: 'Shop in person' },
];

const HOME: ProviderReach[] = [
  { provider: 'knuspr', available: true, reason: 'Delivers here' },
  { provider: 'edeka', available: true, reason: 'Shop in person' },
];

const ABROAD: ProviderReach[] = [
  { provider: 'knuspr', available: false, reason: 'Knuspr delivers in Munich only' },
  { provider: 'edeka', available: false, reason: 'EDEKA stores are in Germany only' },
];

function knusprOnly(overrides: Partial<BrowseItem> = {}): BrowseItem {
  return {
    id: 'knuspr:milk',
    name: 'Miil Frische Vollmilch 3,5%',
    groupLabel: 'Vollmilch',
    image: null,
    statsByProvider: {
      knuspr: { provider: 'knuspr', purchases: 42, cadenceDays: 4, lastBought: '2026-11-14', avgPrice: 0.85 },
    },
    offers: [
      { provider: 'knuspr', available: true, reason: 'Delivers here', price: 0.85, productId: 5001 },
    ],
    due: false,
    stockDays: 2,
    ...overrides,
  };
}

function withEdekaLink(): BrowseItem {
  const base = knusprOnly();
  return {
    ...base,
    statsByProvider: {
      ...base.statsByProvider,
      edeka: { provider: 'edeka', purchases: 3, cadenceDays: 6, lastBought: '2026-11-12', avgPrice: 0.99 },
    },
    offers: [
      ...base.offers,
      {
        provider: 'edeka',
        available: true,
        reason: 'Shop in person',
        price: 0.99,
        textKey: 'gut & guenstig|vollmilch',
        name: 'Gut & Günstig H-Milch 1,5%',
      },
    ],
    linked: { confidence: 0.92, source: 'auto' },
  };
}

describe('resolveAdd', () => {
  it('disables a Knuspr-only row while away, with the availability reason', () => {
    const decision = resolveAdd(knusprOnly(), 'edeka-list', AWAY);

    expect(decision).toEqual({
      kind: 'unavailable',
      reason: 'Knuspr delivers in Munich only — not here',
    });
  });

  it('sends a linked row to the EDEKA list instead, under the store name', () => {
    const decision = resolveAdd(withEdekaLink(), 'edeka-list', AWAY);

    expect(decision.kind).toBe('add');
    if (decision.kind !== 'add') return;
    expect(decision.destination).toBe('edeka-list');
    expect(decision.item).toMatchObject({
      provider: 'edeka',
      textKey: 'gut & guenstig|vollmilch',
      name: 'Gut & Günstig H-Milch 1,5%',
    });
  });

  it('uses the cart at home', () => {
    const decision = resolveAdd(knusprOnly(), 'knuspr-cart', HOME);

    expect(decision.kind).toBe('add');
    if (decision.kind !== 'add') return;
    expect(decision.destination).toBe('knuspr-cart');
    expect(decision.item.productId).toBe(5001);
  });

  it('keeps a checklist line usable abroad, where no store is reachable', () => {
    const decision = resolveAdd(knusprOnly(), 'checklist', ABROAD);

    expect(decision.kind).toBe('add');
    if (decision.kind !== 'add') return;
    expect(decision.destination).toBe('checklist');
    expect(decision.item.name).toBe('Miil Frische Vollmilch 3,5%');
  });

  it('refuses an EDEKA-only row when EDEKA is out of reach', () => {
    const item: BrowseItem = {
      ...knusprOnly(),
      id: 'edeka:bread',
      name: 'Bauernbrot',
      statsByProvider: {
        edeka: { provider: 'edeka', purchases: 4, cadenceDays: 5, lastBought: '2026-11-10', avgPrice: 2.5 },
      },
      offers: [
        { provider: 'edeka', available: false, reason: 'EDEKA stores are in Germany only', price: 2.5, textKey: '|bauernbrot' },
      ],
    };

    expect(resolveAdd(item, 'edeka-list', ABROAD)).toEqual({
      kind: 'unavailable',
      reason: 'EDEKA stores are in Germany only',
    });
  });

  it('never refuses on an unknown location: the server stays the guard', () => {
    expect(resolveAdd(knusprOnly(), 'knuspr-cart', null).kind).toBe('add');
    expect(resolveAdd(knusprOnly(), 'knuspr-cart', []).kind).toBe('add');
  });
});
