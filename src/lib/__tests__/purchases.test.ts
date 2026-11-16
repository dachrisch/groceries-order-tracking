import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, clearDB, teardownTestDB } from '../../api/__tests__/helpers';
import Order from '../../models/Order';
import PurchaseSession from '../../models/PurchaseSession';
import {
  findPurchase,
  fromOrder,
  fromPurchaseSession,
  listPurchases,
  parsePurchaseEventId,
  purchaseEventId,
  toSummary,
  type OrderLike,
  type PurchaseSessionLike,
} from '../purchases';

beforeAll(setupTestDB);
afterAll(teardownTestDB);
beforeEach(clearDB);

const userId = new mongoose.Types.ObjectId().toString();

function order(overrides: Partial<OrderLike> = {}): OrderLike {
  return {
    id: 4711,
    orderTimeDate: new Date('2026-11-14T18:00:00Z'),
    address: 'Musterstraße 1, München',
    itemsCount: 2,
    priceComposition: { total: { amount: 12.5 } },
    items: [
      {
        id: 1001,
        name: 'Bio Vollmilch 1,5%',
        amount: 2,
        priceComposition: { total: { amount: 1.19 } },
        images: ['https://cdn.knuspr.de/milk.jpg'],
      },
      { id: 1002, name: 'Bauernbrot', amount: 1, priceComposition: { total: { amount: 2.89 } } },
    ],
    ...overrides,
  };
}

function receipt(overrides: Partial<PurchaseSessionLike> = {}): PurchaseSessionLike {
  return {
    _id: new mongoose.Types.ObjectId(),
    purchasedAt: new Date('2026-11-12T16:00:00Z'),
    store: 'Marktkauf Musterstadt',
    total: 23.9,
    unitCount: 2,
    items: [
      { brand: 'Gut & Günstig', name: 'H-Milch 1,5%', quantity: 1, unitPrice: 0.95 },
      { brand: null, name: 'Leergut', quantity: 1, unitPrice: -0.25, isCredit: true },
    ],
    ...overrides,
  };
}

describe('fromOrder', () => {
  it('maps an order with provider, place and lines', () => {
    const event = fromOrder(order());
    expect(event).toMatchObject({
      id: 'knuspr:4711',
      provider: 'knuspr',
      kind: 'delivery',
      place: 'Musterstraße 1, München',
      itemCount: 2,
      total: 12.5,
      canUndo: false,
    });
    expect(event.lines).toHaveLength(2);
    expect(event.lines[0]).toMatchObject({ productKey: '1001', productId: 1001, qty: 2, unitPrice: 1.19 });
  });

  it('derives the total from the lines when the sum is missing', () => {
    const event = fromOrder(order({ priceComposition: {} }));
    expect(event.total).toBe(5.27);
  });

  it('is undoable only when a bot run produced it', () => {
    const event = fromOrder(order({ botRunId: 'abc123' }));
    expect(event.runId).toBe('abc123');
    expect(event.canUndo).toBe(true);
  });

  it('keeps occasion ids so the timeline can explain a big basket', () => {
    const event = fromOrder(order({ occasionIds: ['o1', 'o2'] }));
    expect(event.occasionIds).toEqual(['o1', 'o2']);
  });
});

describe('fromPurchaseSession', () => {
  it('drops deposit returns from the lines but keeps the receipt total', () => {
    const event = fromPurchaseSession(receipt());
    expect(event.kind).toBe('store-run');
    expect(event.place).toBe('Marktkauf Musterstadt');
    expect(event.lines).toHaveLength(1);
    expect(event.lines[0].name).toBe('Gut & Günstig H-Milch 1,5%');
    expect(event.total).toBe(23.9);
    expect(event.canUndo).toBe(false);
  });
});

describe('ids', () => {
  it('round-trips a namespaced id', () => {
    expect(purchaseEventId('knuspr', 12)).toBe('knuspr:12');
    expect(parsePurchaseEventId('knuspr:12')).toEqual({ provider: 'knuspr', id: '12' });
    expect(parsePurchaseEventId('edeka:65f000000000000000000000')).toEqual({
      provider: 'edeka',
      id: '65f000000000000000000000',
    });
  });

  it('rejects anything else', () => {
    expect(parsePurchaseEventId('12')).toBeNull();
    expect(parsePurchaseEventId('amazon:12')).toBeNull();
    expect(parsePurchaseEventId('knuspr:')).toBeNull();
  });
});

describe('toSummary', () => {
  it('drops the lines but keeps the count', () => {
    const summary = toSummary(fromOrder(order()));
    expect(summary).not.toHaveProperty('lines');
    expect(summary.lineCount).toBe(2);
  });
});

describe('listPurchases', () => {
  beforeEach(async () => {
    await Order.create({ ...order(), userId, state: 'delivered' });
    await Order.create({
      ...order({ id: 4712, orderTimeDate: new Date('2026-11-01T18:00:00Z') }),
      userId,
      state: 'delivered',
    });
    await PurchaseSession.create({ ...receipt(), userId, key: 'k1' });
  });

  it('merges both sources newest first', async () => {
    const events = await listPurchases(userId);
    expect(events.map((event) => event.provider)).toEqual(['knuspr', 'edeka', 'knuspr']);
    expect(events[0].at.getTime()).toBeGreaterThan(events[1].at.getTime());
  });

  it('filters by provider', async () => {
    const events = await listPurchases(userId, { provider: 'edeka' });
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe('edeka');
  });

  it('filters by date range', async () => {
    const events = await listPurchases(userId, {
      from: new Date('2026-11-10T00:00:00Z'),
      to: new Date('2026-11-30T00:00:00Z'),
    });
    expect(events).toHaveLength(2);
  });

  it('never returns another user`s events', async () => {
    const events = await listPurchases(new mongoose.Types.ObjectId().toString());
    expect(events).toHaveLength(0);
  });
});

describe('findPurchase', () => {
  it('finds a knuspr order by its public id', async () => {
    await Order.create({ ...order(), userId, state: 'delivered' });
    const event = await findPurchase(userId, 'knuspr:4711');
    expect(event?.id).toBe('knuspr:4711');
    expect(event?.lines).toHaveLength(2);
  });

  it('finds a receipt by its session id', async () => {
    const created = await PurchaseSession.create({ ...receipt(), userId, key: 'k1' });
    const event = await findPurchase(userId, `edeka:${created._id}`);
    expect(event?.provider).toBe('edeka');
  });

  it('returns null for an unknown or foreign id', async () => {
    expect(await findPurchase(userId, 'knuspr:999')).toBeNull();
    expect(await findPurchase(userId, 'nope:1')).toBeNull();
  });
});
