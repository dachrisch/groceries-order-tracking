import { describe, it, expect } from 'vitest';
import { computeConsumption, type Purchase } from '../bot/consumption';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function purchase(overrides: Partial<Purchase> & Pick<Purchase, 'orderId' | 'productId' | 'date'>): Purchase {
  return {
    amount: 1,
    packSize: 1000,
    unitPrice: 1.29,
    name: 'Vollmilch 1l',
    groupKey: 'milch|1000ml|vollmilch',
    groupLabel: 'Vollmilch 1l',
    groupProductIds: [1],
    ...overrides,
  };
}

describe('computeConsumption', () => {
  it('learns a weekly rate and ignores a one-off birthday cake', () => {
    const purchases: Purchase[] = [];
    for (let week = 0; week < 8; week++) {
      purchases.push(purchase({ orderId: 100 + week, productId: 1, date: daysAgo(week * 7 + 1) }));
    }
    // Cake: one purchase only, so it is not a regular item.
    purchases.push(
      purchase({
        orderId: 200,
        productId: 99,
        date: daysAgo(10),
        name: 'Geburtstagstorte',
        groupKey: 'backwaren|nosize|torte',
        groupLabel: 'Geburtstagstorte',
        groupProductIds: [99],
        packSize: 1,
      })
    );

    const result = computeConsumption(purchases, { now: NOW });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].productId).toBe(1);
    // 1l per week → ~143 ml/day.
    expect(result.items[0].ratePerDay).toBeGreaterThan(130);
    expect(result.items[0].ratePerDay).toBeLessThan(150);
    expect(result.items[0].confidence).toBe('high');
  });

  it('computes horizon quantities for a top-up shopper', () => {
    const purchases: Purchase[] = [];
    // 500g pack every 4 days → ~125g/day.
    for (let index = 0; index < 8; index++) {
      purchases.push(
        purchase({
          orderId: 300 + index,
          productId: 2,
          date: daysAgo(index * 4 + 1),
          packSize: 500,
          groupKey: 'milch|500ml|vollmilch',
          groupProductIds: [2],
        })
      );
    }

    const result = computeConsumption(purchases, { now: NOW, horizonDays: 7, deliveryLeadDays: 2 });
    const item = result.items[0];

    expect(item.due).toBe(true);
    // 125g/day × 9 days ≈ 1125g needed; with ~1 pack in stock this is 2–3 packs.
    expect(item.qty).toBeGreaterThanOrEqual(2);
    expect(item.qty).toBeLessThanOrEqual(3);
    expect(item.reason).toContain('stock');
  });

  it('drops items that stopped being bought', () => {
    const purchases: Purchase[] = [];
    for (let week = 0; week < 6; week++) {
      purchases.push(purchase({ orderId: 400 + week, productId: 3, date: daysAgo(200 + week * 7) }));
    }

    const result = computeConsumption(purchases, { now: NOW });
    expect(result.items).toHaveLength(0);
  });

  it('does not count occasion purchases toward the weekly rate', () => {
    const purchases: Purchase[] = [];
    for (let week = 0; week < 6; week++) {
      purchases.push(purchase({ orderId: 500 + week, productId: 4, date: daysAgo(week * 7 + 1) }));
    }

    const excluded = new Set(['500:4', '501:4', '502:4', '503:4']);
    const result = computeConsumption(purchases, { now: NOW, excludePurchases: excluded });

    // Only two weeks remain, below the three-week regularity threshold.
    expect(result.items).toHaveLength(0);
  });

  it('rounds up to the usual pack count for bulk buyers', () => {
    const purchases: Purchase[] = [];
    for (let week = 0; week < 8; week++) {
      purchases.push(
        purchase({
          orderId: 600 + week,
          productId: 5,
          date: daysAgo(week * 7 + 5),
          amount: 2,
          packSize: 500,
          groupKey: 'milch|500ml|vollmilch',
          groupProductIds: [5],
        })
      );
    }

    const result = computeConsumption(purchases, { now: NOW, horizonDays: 7, deliveryLeadDays: 2 });
    const item = result.items[0];

    expect(item.modeAmount).toBe(2);
    expect(item.qty % 2).toBe(0);
  });
});
