import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, clearDB, teardownTestDB } from '../../api/__tests__/helpers';
import Order from '../../models/Order';
import PurchaseSession from '../../models/PurchaseSession';
import ProductLink from '../../models/ProductLink';
import { getWeeklyConsumption } from '../bot/consumption';
import { LINK_SIMILARITY_FLOOR, resolveLinks } from '../product-links';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-16T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

const MILK = { textKey: 'gut & guenstig|vollmilch', name: 'Vollmilch 1l' };
const BREAD = { textKey: '|bauernbrot', name: 'Bauernbrot 750g' };

describe('resolveLinks', () => {
  it('links an identical name and size automatically', () => {
    const links = resolveLinks([{ productId: 1001, name: 'Vollmilch 1l' }], [MILK]);

    expect(links.get(1001)).toEqual({
      edekaTextKey: MILK.textKey,
      confidence: 1,
      source: 'auto',
    });
  });

  it('never guesses below the similarity floor', () => {
    const links = resolveLinks([{ productId: 1001, name: 'Vollmilch 1l' }], [BREAD]);

    expect(links.size).toBe(1);
    expect(links.get(1001)).toBeNull();
    expect(LINK_SIMILARITY_FLOOR).toBe(0.8);
  });

  it('refuses an otherwise identical name in a different pack size', () => {
    const links = resolveLinks([{ productId: 1001, name: 'Vollmilch 500ml' }], [MILK]);

    expect(links.get(1001)).toBeNull();
  });

  it('keeps fat percentages apart even when the pack size matches', () => {
    const links = resolveLinks(
      [{ productId: 1001, name: 'Vollmilch 1,5 %' }],
      [{ textKey: 'milk-35', name: 'Vollmilch 3,5 %' }]
    );

    expect(links.get(1001)).toBeNull();
  });

  it('links when the percentages agree', () => {
    const links = resolveLinks(
      [{ productId: 1001, name: 'Vollmilch 1,5 %' }],
      [{ textKey: 'milk-15', name: 'Vollmilch 1.5 %' }]
    );

    expect(links.get(1001)).toEqual({
      edekaTextKey: 'milk-15',
      confidence: 1,
      source: 'auto',
    });
  });

  it('lets a manual correction beat the name matcher, with confidence 1', () => {
    const links = resolveLinks(
      [{ productId: 1001, name: 'Vollmilch 1l' }],
      [MILK, BREAD],
      [{ knusprProductId: 1001, edekaTextKey: BREAD.textKey }]
    );

    expect(links.get(1001)).toEqual({
      edekaTextKey: BREAD.textKey,
      confidence: 1,
      source: 'manual',
    });
  });

  it('honours a manual correction made against another product of the same group', () => {
    // Knuspr rotates ids inside a group; the shopper pointed at one of them.
    const links = resolveLinks(
      [{ productId: 2002, productIds: [1001, 2002], name: 'Vollmilch 1l' }],
      [MILK],
      [{ knusprProductId: 1001, edekaTextKey: MILK.textKey }]
    );

    expect(links.get(2002)).toMatchObject({ source: 'manual', confidence: 1 });
  });

  it('gives one EDEKA bucket to only one row, even with near-duplicate products', () => {
    const links = resolveLinks(
      [
        { productId: 1, name: 'Vollmilch 1l' },
        { productId: 2, name: 'Vollmilch 1l' },
      ],
      [MILK]
    );

    expect([links.get(1), links.get(2)].filter(Boolean)).toHaveLength(1);
  });

  it('keeps an EDEKA bucket free when the manual link points at something else', () => {
    const links = resolveLinks(
      [{ productId: 1001, name: 'Vollmilch 1l' }],
      [MILK, BREAD],
      [{ knusprProductId: 1001, edekaTextKey: BREAD.textKey }]
    );

    // The milk bucket was not claimed by anyone, so its own row still exists.
    expect(links.get(1001)?.edekaTextKey).toBe(BREAD.textKey);
  });
});

describe('the display link cannot reach learning', () => {
  let userId: string;

  beforeAll(setupTestDB);
  afterAll(teardownTestDB);

  beforeEach(async () => {
    await clearDB();
    userId = new mongoose.Types.ObjectId().toString();

    // Four weekly deliveries of the same milk: enough weeks to learn a rate.
    for (let index = 0; index < 4; index++) {
      await Order.create({
        userId,
        id: 5000 + index,
        itemsCount: 1,
        orderTimeDate: daysAgo(index * 7 + 1),
        items: [{
          id: 1001,
          name: 'Vollmilch 1l',
          unit: 'l',
          textualAmount: '1l',
          amount: 1,
          images: [],
          priceComposition: {
            total: { amount: 129, currency: 'EUR' },
            unit: { amount: 129, currency: 'EUR' },
          },
          categories: [{ id: 7, name: 'Milch', slug: 'milch', level: 1 }],
        }],
      });
    }

    // The same product bought in store: the link exists, the rate must not move.
    for (let index = 0; index < 3; index++) {
      await PurchaseSession.create({
        userId,
        key: `receipt-${index}`,
        purchasedAt: daysAgo(index * 7 + 3),
        store: 'Marktkauf Musterstadt',
        total: 4.5,
        items: [{ brand: 'Gut & Günstig', name: 'Vollmilch 1l', quantity: 1, unitPrice: 1.29 }],
      });
    }
  });

  it('leaves getWeeklyConsumption byte-identical after a manual link is stored', async () => {
    const before = await getWeeklyConsumption(userId, { now: NOW });
    expect(before.items.length).toBeGreaterThan(0);

    await ProductLink.create({
      userId,
      knusprProductId: 1001,
      edekaTextKey: MILK.textKey,
      confidence: 1,
      source: 'manual',
    });
    expect(await ProductLink.countDocuments({ userId })).toBe(1);

    const after = await getWeeklyConsumption(userId, { now: NOW });

    // Byte-identical, not merely "close": the link must not touch a rate, a
    // stock, a cadence or a due flag (invariant D5).
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
