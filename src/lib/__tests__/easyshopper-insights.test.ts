import { describe, it, expect } from 'vitest';
import { isAggregateLine, productKey, storeKey, summarizePurchases, type PurchaseSessionLike } from '../easyshopper/insights';

const session = (overrides: Partial<PurchaseSessionLike> = {}): PurchaseSessionLike => ({
  purchasedAt: '2026-11-13T15:50:00.000Z',
  store: 'Marktkauf Musterstadt',
  total: 10,
  items: [],
  ...overrides,
});

describe('productKey', () => {
  it('collapses pack-size variants of the same product', () => {
    expect(productKey({ brand: 'Frosch', name: 'Waschmittel 1450g' })).toBe(
      productKey({ brand: 'Frosch', name: 'Waschmittel 2000g' })
    );
  });

  it('keeps a genuinely different variant apart', () => {
    // "22WL Sensitiv" is a different product, not a pack size.
    expect(productKey({ brand: 'Frosch', name: 'Waschmittel 1450g' })).not.toBe(
      productKey({ brand: 'Frosch', name: 'Waschmittel 22WL 1450g Sensitiv' })
    );
  });

  it('separates different brands', () => {
    expect(productKey({ brand: 'Frosch', name: 'Waschmittel' })).not.toBe(
      productKey({ brand: 'Persil', name: 'Waschmittel' })
    );
  });
});

describe('summarizePurchases', () => {
  const sessions: PurchaseSessionLike[] = [
    session({
      total: 107.19,
      items: [
        { brand: 'Kneipp', name: 'Dusche 200ml Gute Laune', quantity: 1, lineTotal: 2.95 },
        { brand: 'Frosch', name: 'Waschmittel 1450g', quantity: 1, lineTotal: 5.45 },
        { brand: null, name: 'Leergut', quantity: 1, lineTotal: -3.3, isCredit: true },
      ],
    }),
    session({
      purchasedAt: '2026-10-17T09:54:00.000Z',
      store: 'WEZ Musterstadt',
      total: 16.96,
      items: [
        { brand: 'Frosch', name: 'Waschmittel 1450g', quantity: 2, lineTotal: 10.9 },
        { brand: null, name: 'Zitronen klein', quantity: 1, lineTotal: 0.99 },
        { brand: null, name: 'Leergut', quantity: 1, lineTotal: -7.95, isCredit: true },
      ],
    }),
  ];

  it('totals spend, units and deposit returns separately', () => {
    const insights = summarizePurchases(sessions);
    expect(insights.totals.sessions).toBe(2);
    expect(insights.totals.spend).toBe(124.15);
    expect(insights.totals.units).toBe(7);
    expect(insights.totals.creditReturned).toBe(-11.25);
    expect(insights.totals.averageBasket).toBe(62.08);
  });

  it('ranks products by how often they were bought, not by price', () => {
    const [first, second] = summarizePurchases(sessions).topProducts;
    expect(first.name).toBe('Waschmittel 1450g');
    expect(first.trips).toBe(2);
    expect(first.units).toBe(3);
    expect(second.name).toContain('Dusche');
  });

  it('never lists a deposit return as a product', () => {
    const names = summarizePurchases(sessions).topProducts.map((product) => product.name);
    expect(names).not.toContain('Leergut');
  });

  it('breaks spend down per store and per month, newest month first', () => {
    const insights = summarizePurchases(sessions);
    expect(insights.stores[0].store).toBe('Marktkauf Musterstadt');
    expect(insights.stores[1]).toMatchObject({ visits: 1, spend: 16.96 });
    expect(insights.monthly.map((entry) => entry.month)).toEqual(['2026-11', '2026-10']);
  });

  it('reports the purchase window', () => {
    const insights = summarizePurchases(sessions);
    expect(insights.totals.firstPurchaseAt).toBe('2026-10-17T09:54:00.000Z');
    expect(insights.totals.lastPurchaseAt).toBe('2026-11-13T15:50:00.000Z');
  });

  it('handles an empty history', () => {
    const insights = summarizePurchases([]);
    expect(insights.totals).toMatchObject({ sessions: 0, spend: 0, averageBasket: 0 });
    expect(insights.topProducts).toEqual([]);
  });
});

describe('storeKey', () => {
  it('treats the street suffix as decoration', () => {
    expect(storeKey('Marktkauf Musterstadt')).toBe(storeKey('Marktkauf Musterstadt (MUSTERSTR.)'));
  });
});

describe('isAggregateLine', () => {
  it('spot the till summary rows', () => {
    expect(isAggregateLine('Summenart.129999EH KäseBEerm.')).toBe(true);
    expect(isAggregateLine('Frischkäse 200g')).toBe(false);
  });
});

describe('summarizePurchases store merging', () => {
  it('merges visits of the same shop spelled with and without the street', () => {
    const insights = summarizePurchases([
      session({ store: 'Marktkauf Musterstadt', total: 10 }),
      session({ store: 'Marktkauf Musterstadt (MUSTERSTR.)', total: 20 }),
    ]);
    expect(insights.stores).toHaveLength(1);
    expect(insights.stores[0]).toMatchObject({ visits: 2, spend: 30 });
    expect(insights.stores[0].store).toContain('(');
  });

  it('keeps till summary rows out of the product ranking', () => {
    const insights = summarizePurchases([
      session({ items: [{ brand: null, name: 'Summenart.129999EH KäseBEerm.', quantity: 1, lineTotal: 20.98 }] }),
    ]);
    expect(insights.topProducts).toEqual([]);
  });
});
