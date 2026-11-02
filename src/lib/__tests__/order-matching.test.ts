import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, clearDB, teardownTestDB } from '../../api/__tests__/helpers';
import Order from '../../models/Order';
import BotRun from '../../models/BotRun';
import { matchRunsToOrders } from '../bot/order-matching';

const DAY_MS = 24 * 60 * 60 * 1000;

function orderItem(id: number) {
  return {
    id,
    name: `Product ${id}`,
    amount: 1,
    textualAmount: '1 Stück',
    images: [],
    priceComposition: { total: { amount: 100, currency: 'EUR' }, unit: { amount: 100, currency: 'EUR' } },
    categories: [{ id: 1, name: 'Test', slug: 'test', level: 1 }],
  };
}

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('matchRunsToOrders', () => {
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    userId = new mongoose.Types.ObjectId().toString();
  });

  it('matches a delivered order containing 12 of 14 run items', async () => {
    const run = await BotRun.create({
      userId,
      intent: { type: 'weekly' },
      items: Array.from({ length: 14 }, (_, index) => ({
        productId: index + 1,
        name: `Product ${index + 1}`,
        qty: 1,
        price: 1,
      })),
      totalPrice: 14,
      status: 'in-cart',
    });
    await BotRun.collection.updateOne({ _id: run._id }, { $set: { createdAt: new Date(Date.now() - DAY_MS) } });

    const order = await Order.create({
      userId,
      id: 9001,
      itemsCount: 12,
      orderTimeDate: new Date(),
      items: Array.from({ length: 12 }, (_, index) => orderItem(index + 1)),
      priceComposition: { total: { amount: 1200, currency: 'EUR' } },
    });

    const matched = await matchRunsToOrders(userId);

    expect(matched).toBe(1);
    const updatedOrder = await Order.findOne({ userId, id: order.id }).lean();
    expect(String(updatedOrder?.botRunId)).toBe(String(run._id));
    expect(updatedOrder?.botRunDeliveredCount).toBe(12);
    expect(updatedOrder?.botRunItemCount).toBe(14);

    const updatedRun = await BotRun.findById(run._id).lean();
    expect(updatedRun?.status).toBe('partially-delivered');
    expect(updatedRun?.deliveredItemCount).toBe(12);
  });

  it('ignores orders outside the 7-day window', async () => {
    const run = await BotRun.create({
      userId,
      intent: { type: 'weekly' },
      items: [{ productId: 1, name: 'Product 1', qty: 1, price: 1 }],
      totalPrice: 1,
      status: 'in-cart',
    });
    await BotRun.collection.updateOne({ _id: run._id }, { $set: { createdAt: new Date(Date.now() - 10 * DAY_MS) } });

    await Order.create({
      userId,
      id: 9002,
      itemsCount: 1,
      orderTimeDate: new Date(),
      items: [orderItem(1)],
      priceComposition: { total: { amount: 100, currency: 'EUR' } },
    });

    const matched = await matchRunsToOrders(userId);
    expect(matched).toBe(0);
  });
});
