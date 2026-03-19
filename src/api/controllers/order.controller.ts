import { Request, Response } from 'express';
import Order from '../../models/Order';
import mongoose from 'mongoose';

export async function handleGetAggregates(req: Request, res: Response) {
  const userId = req.userId;

  try {
    const amountOverTime = await Order.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: {
            year: { $year: "$orderTimeDate" },
            month: { $month: "$orderTimeDate" }
          },
          totalAmount: { $sum: "$priceComposition.total.amount" },
          orderCount: { $sum: 1 },
          itemCount: { $sum: "$itemsCount" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    res.json(amountOverTime);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleGetStats(req: Request, res: Response) {
  const userId = req.userId;

  try {
    const stats = await Order.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalSpend: { $sum: "$priceComposition.total.amount" },
                totalItems: { $sum: "$itemsCount" },
                totalOrders: { $sum: 1 },
                firstOrder: { $min: "$orderTimeDate" },
                lastOrder: { $max: "$orderTimeDate" }
              }
            }
          ],
          distinctItems: [
            { $unwind: "$items" },
            { $group: { _id: "$items.id" } },
            { $count: "count" }
          ]
        }
      }
    ]);

    const result = {
      totalSpend: stats[0].totals[0]?.totalSpend || 0,
      totalItems: stats[0].totals[0]?.totalItems || 0,
      totalOrders: stats[0].totals[0]?.totalOrders || 0,
      distinctItems: stats[0].distinctItems[0]?.count || 0,
      firstOrder: stats[0].totals[0]?.firstOrder,
      lastOrder: stats[0].totals[0]?.lastOrder
    };

    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleGetOrders(req: Request, res: Response) {
  const userId = req.userId;

  try {
    const orders = await Order.find({ userId })
      .sort({ orderTimeDate: -1 })
      .select('-items'); // Don't send items for the list view to keep payload small
    res.json(orders);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleGetOrderDetail(req: Request, res: Response) {
  const userId = req.userId;
  const { id } = req.params;

  try {
    const order = await Order.findOne({ userId, id: Number(id) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function handleGetProductTrends(req: Request, res: Response) {
  const userId = req.userId;

  try {
    const trends = await Order.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $unwind: "$items" },
      {
        $group: {
          _id: { id: "$items.id", name: "$items.name" },
          prices: {
            $push: {
              date: "$orderTimeDate",
              unitPrice: "$items.priceComposition.unit.amount",
              orderId: "$id"
            }
          },
          count: { $sum: 1 },
          image: { $first: { $arrayElemAt: ["$items.images", 0] } }
        }
      },
      { $sort: { "_id.name": 1 } }
    ]);

    res.json(trends);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}
