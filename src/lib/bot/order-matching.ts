import mongoose from 'mongoose';
import Order from '../../models/Order';
import BotRun from '../../models/BotRun';
import Occasion from '../../models/Occasion';
import { getProductGroupMap } from './product-groups';

const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_WINDOW_DAYS = 7;
/** How far one delivery moves a recipe amount toward what was actually ordered. */
const LEARNING_RATE = 0.3;

/**
 * New per-serving amount after a delivery, or null when there is nothing to
 * learn. Only a changed pack count teaches anything: re-learning from the
 * bot's own rounded-up packs would make every recipe creep upwards.
 */
export function learnedQtyPerServing(
  current: number,
  plannedPacks: number,
  deliveredPacks: number,
  packSize: number,
  servings: number
): number | null {
  if (deliveredPacks <= 0 || deliveredPacks === plannedPacks || servings <= 0) return null;
  const observed = (deliveredPacks * packSize) / servings;
  return current * (1 - LEARNING_RATE) + observed * LEARNING_RATE;
}

/** Nudge recipe amounts toward what the user actually ordered after editing the cart. */
async function learnFromDelivery(
  userId: string,
  runItems: Array<{ productId: number; groupKey?: string; qty: number; occasionId?: unknown; servings?: number }>,
  orderItems: Array<{ id: number; amount?: number }>,
  groupByProduct: Map<number, { key: string }>
): Promise<void> {
  for (const runItem of runItems) {
    if (!runItem.occasionId || !runItem.servings) continue;
    const delivered = orderItems
      .filter((item) => item.id === runItem.productId || (runItem.groupKey && groupByProduct.get(item.id)?.key === runItem.groupKey))
      .reduce((sum, item) => sum + (item.amount ?? 1), 0);

    const occasion = await Occasion.findOne({ _id: runItem.occasionId, userId });
    if (!occasion) continue;
    const item = occasion.items.find(
      (entry: { productId: number; groupKey?: string }) =>
        entry.productId === runItem.productId || (runItem.groupKey && entry.groupKey === runItem.groupKey)
    );
    if (!item) continue;
    const next = learnedQtyPerServing(item.qtyPerServing, runItem.qty, delivered, item.packSize, runItem.servings);
    if (next === null) continue;
    item.qtyPerServing = next;
    await occasion.save();
  }
}

/**
 * Match newly delivered orders to open bot runs: same user, order placed at or
 * after the run, within 7 days, best overlap by product group. The order and
 * the run both remember the overlap so the Orders page can show "🤖 Bot 12/14".
 */
export async function matchRunsToOrders(userId: string): Promise<number> {
  const runs = await BotRun.find({
    userId,
    status: { $in: ['in-cart', 'partially-delivered'] },
  }).sort({ createdAt: 1 });

  if (runs.length === 0) return 0;

  const earliest = new Date(Math.min(...runs.map((run) => new Date(run.createdAt).getTime())));
  const orders = await Order.find({
    userId,
    orderTimeDate: { $gte: new Date(earliest.getTime() - DAY_MS) },
  })
    .sort({ orderTimeDate: 1 })
    .select('id orderTimeDate items botRunId')
    .lean();

  const groupByProduct = await getProductGroupMap(userId);
  const orderGroups = new Map<number, Set<string>>();
  const orderProducts = new Map<number, Set<number>>();
  for (const order of orders) {
    orderProducts.set(order.id, new Set((order.items ?? []).map((item) => item.id)));
    const groups = new Set<string>();
    for (const item of order.items ?? []) {
      const group = groupByProduct.get(item.id);
      if (group) groups.add(group.key);
    }
    orderGroups.set(order.id, groups);
  }

  const usedOrderIds = new Set<number>();
  let matched = 0;

  for (const run of runs) {
    const runDate = new Date(run.createdAt).getTime();
    let best: { orderId: number; score: number } | null = null;

    for (const order of orders) {
      if (usedOrderIds.has(order.id) || order.botRunId) continue;
      const orderDate = new Date(order.orderTimeDate).getTime();
      if (orderDate < runDate || orderDate > runDate + MATCH_WINDOW_DAYS * DAY_MS) continue;

      const products = orderProducts.get(order.id)!;
      const groups = orderGroups.get(order.id)!;
      const score = run.items.filter((item) => {
        if (products.has(item.productId)) return true;
        return item.groupKey ? groups.has(item.groupKey) : false;
      }).length;

      if (score > 0 && (!best || score > best.score)) {
        best = { orderId: order.id, score };
      }
    }

    if (!best) continue;

    usedOrderIds.add(best.orderId);
    matched++;

    const matchedOrder = orders.find((order) => order.id === best!.orderId);
    await learnFromDelivery(userId, run.items, matchedOrder?.items ?? [], groupByProduct);

    await Order.updateOne(
      { userId, id: best.orderId },
      {
        $set: {
          botRunId: run._id,
          botRunItemCount: run.items.length,
          botRunDeliveredCount: best.score,
        },
      }
    );

    await BotRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: best.score >= run.items.length ? 'delivered' : 'partially-delivered',
          matchedOrderId: best.orderId,
          deliveredItemCount: best.score,
        },
      }
    );
  }

  return matched;
}

/**
 * Tag orders that contained a detected occasion basket, and remove tags for
 * occasions that no longer exist. Runs even when there is no bot run.
 */
export async function tagOccasionOrders(userId: string): Promise<void> {
  const occasions = await Occasion.find({ userId }).select('_id sourceOrders').lean();
  const validIds = new Set(occasions.map((occasion) => String(occasion._id)));

  for (const occasion of occasions) {
    const orderIds = (occasion.sourceOrders ?? []).map((source) => source.orderId);
    if (orderIds.length === 0) continue;
    await Order.updateMany(
      { userId, id: { $in: orderIds } },
      { $addToSet: { occasionIds: occasion._id } }
    );
  }

  // Drop tags pointing at occasions that were deleted by a rebuild.
  const tagged = await Order.find({ userId, occasionIds: { $exists: true, $ne: [] } })
    .select('id occasionIds')
    .lean();
  for (const order of tagged) {
    const stale = (order.occasionIds ?? []).filter((id) => !validIds.has(String(id)));
    if (stale.length > 0) {
      await Order.updateOne(
        { userId, id: order.id },
        { $pull: { occasionIds: { $in: stale.map((id) => new mongoose.Types.ObjectId(String(id))) } } }
      );
    }
  }
}
