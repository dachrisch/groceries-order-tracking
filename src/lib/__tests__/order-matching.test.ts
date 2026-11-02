import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, clearDB, teardownTestDB } from '../../api/__tests__/helpers';
import Order from '../../models/Order';
import BotRun from '../../models/BotRun';
import Occasion from '../../models/Occasion';
import { learnedQtyPerServing, matchRunsToOrders } from '../bot/order-matching';

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

describe('learnedQtyPerServing', () => {
  it('learns nothing when the delivery matched the plan', () => {
    expect(learnedQtyPerServing(60, 3, 3, 125, 6)).toBeNull();
  });

  it('moves 30% toward what was actually delivered', () => {
    // planned 3 packs, user bumped it to 4 packs of 125 g for 6 people → 83.3 g observed
    expect(learnedQtyPerServing(60, 3, 4, 125, 6)).toBeCloseTo(60 * 0.7 + (500 / 6) * 0.3);
  });

  it('ignores a delivery without the item (dropped from the cart is not "zero")', () => {
    expect(learnedQtyPerServing(60, 3, 0, 125, 6)).toBeNull();
  });
});

describe('learning recipe amounts from deliveries', () => {
  beforeEach(clearDB);

  it('updates the occasion when the delivered packs differ from the bot run', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const occasion = await Occasion.create({
      userId,
      key: 'recipe:pizza',
      name: 'Pizza',
      source: 'recipe',
      status: 'confirmed',
      items: [{ productId: 7, name: 'Mozzarella', groupKey: 'g:mozz', qtyPerServing: 60, packSize: 125, core: true }],
    });
    const run = await BotRun.create({
      userId,
      intent: { type: 'occasion', occasion: 'Pizza', occasionId: occasion._id, servings: 6 },
      items: [{ productId: 7, name: 'Mozzarella', qty: 3, price: 1, groupKey: 'g:mozz', occasionId: occasion._id, servings: 6 }],
      totalPrice: 3,
      status: 'in-cart',
    });
    await BotRun.collection.updateOne({ _id: run._id }, { $set: { createdAt: new Date(Date.now() - DAY_MS) } });
    await Order.create({
      userId,
      id: 9100,
      itemsCount: 1,
      orderTimeDate: new Date(),
      items: [{ ...orderItem(7), amount: 4 }],
      priceComposition: { total: { amount: 400, currency: 'EUR' } },
    });

    await matchRunsToOrders(userId);

    const updated = await Occasion.findById(occasion._id).lean();
    expect(updated?.items[0].qtyPerServing).toBeCloseTo(60 * 0.7 + (500 / 6) * 0.3);
  });
});
