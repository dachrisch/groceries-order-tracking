import { Request, Response } from 'express';
import Order from '../../models/Order';
import { importOrders } from '../../lib/order-importer';
import mongoose from 'mongoose';

export async function handleImport(req: Request, res: Response) {
  const userId = (req as any).userId;
  const { curl } = req.body;

  try {
    const result = await importOrders(userId, curl);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleGetAggregates(req: Request, res: Response) {
  const userId = (req as any).userId;

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleGetProductTrends(req: Request, res: Response) {
  const userId = (req as any).userId;

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
          count: { $sum: 1 }
        }
      },
      { $sort: { "_id.name": 1 } }
    ]);

    res.json(trends);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
