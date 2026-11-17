import { describe, it, expect } from 'vitest';
import { aggregateEdeka, edekaDue, knusprStat } from '../product-stats';
import type { ConsumptionItem } from '../bot/consumption';

function session(purchasedAt: string, items: Array<{ brand?: string; name: string; quantity?: number; unitPrice?: number; isCredit?: boolean }>) {
  return { purchasedAt: new Date(purchasedAt), store: 'Marktkauf', total: 10, items };
}

describe('aggregateEdeka', () => {
  it('counts trips, not rows, so buying two in one run is one habit signal', () => {
    const stats = aggregateEdeka([
      session('2026-10-01T10:00:00Z', [
        { brand: 'Gut & Günstig', name: 'H-Milch 1,5%', unitPrice: 0.95 },
        { brand: 'Gut & Günstig', name: 'H-Milch 1,5%', unitPrice: 0.95 },
      ]),
    ]);
    const [entry] = [...stats.values()];
    expect(entry.purchases).toBe(1);
  });

  it('ignores deposit returns', () => {
    const stats = aggregateEdeka([
      session('2026-10-01T10:00:00Z', [
        { name: 'Leergut', unitPrice: -0.25, isCredit: true },
        { brand: 'Frosch', name: 'Spülmittel', unitPrice: 1.49 },
      ]),
    ]);
    expect(stats.size).toBe(1);
    expect([...stats.values()][0].name).toBe('Spülmittel');
  });

  it('withholds a cadence below three trips', () => {
    const stats = aggregateEdeka([
      session('2026-10-01T10:00:00Z', [{ name: 'Brot', unitPrice: 2.5 }]),
      session('2026-10-05T10:00:00Z', [{ name: 'Brot', unitPrice: 2.5 }]),
    ]);
    const [entry] = [...stats.values()];
    expect(entry.purchases).toBe(2);
    expect(entry.cadenceDays).toBeNull();
  });

  it('learns a cadence once there are three trips', () => {
    const stats = aggregateEdeka([
      session('2026-10-01T10:00:00Z', [{ name: 'Brot', unitPrice: 2.5 }]),
      session('2026-10-05T10:00:00Z', [{ name: 'Brot', unitPrice: 2.5 }]),
      session('2026-10-09T10:00:00Z', [{ name: 'Brot', unitPrice: 2.5 }]),
    ]);
    const [entry] = [...stats.values()];
    expect(entry.cadenceDays).toBe(4);
    expect(entry.avgPrice).toBe(2.5);
  });

  it('keys by brand and name so pack-size variants collapse', () => {
    const stats = aggregateEdeka([
      session('2026-10-01T10:00:00Z', [{ brand: 'Kneipp', name: 'Dusche 200ml Gute Laune', unitPrice: 2.95 }]),
      session('2026-10-05T10:00:00Z', [{ brand: 'Kneipp', name: 'Dusche 200ml Gute Laune', unitPrice: 3.15 }]),
    ]);
    expect(stats.size).toBe(1);
    const [entry] = [...stats.values()];
    expect(entry.purchases).toBe(2);
    expect(entry.lastPrice).toBe(3.15);
  });
});

describe('edekaDue', () => {
  const base = {
    provider: 'edeka' as const,
    purchases: 3,
    cadenceDays: 4,
    lastBought: new Date('2026-11-10T10:00:00Z'),
    avgPrice: 2.5,
  };

  it('is never due without a cadence', () => {
    expect(edekaDue({ ...base, cadenceDays: null }, new Date('2027-01-01'))).toBe(false);
  });

  it('is due once the cadence has nearly elapsed', () => {
    expect(edekaDue(base, new Date('2026-11-14T09:00:00Z'))).toBe(true);
    expect(edekaDue(base, new Date('2026-11-11T09:00:00Z'))).toBe(false);
  });
});

describe('knusprStat', () => {
  it('keeps the bot cadence but refuses one below the sample floor', () => {
    const item = {
      groupKey: 'milk',
      groupLabel: 'Milk',
      productIds: [1],
      productId: 1,
      name: 'Bio Vollmilch',
      packSize: 1000,
      modeAmount: 1,
      purchaseCount: 6,
      weeksPurchased: 6,
      lastPurchase: new Date('2026-11-14T10:00:00Z'),
      intervalDays: 3.6,
      ratePerDay: 0.2,
      stock: 1,
      stockDays: 0.8,
      qty: 1,
      due: true,
      horizonDays: 7,
      avgPrice: 1.191,
      confidence: 'high' as const,
      reason: '',
    } satisfies ConsumptionItem;

    expect(knusprStat(item)).toEqual({
      provider: 'knuspr',
      purchases: 6,
      cadenceDays: 4,
      lastBought: item.lastPurchase,
      avgPrice: 1.19,
    });
    expect(knusprStat({ ...item, purchaseCount: 2 }).cadenceDays).toBeNull();
  });
});
