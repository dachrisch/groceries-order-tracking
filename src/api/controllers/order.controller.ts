import { Request, Response } from 'express';
import Order from '../../models/Order';
import Integration from '../../models/Integration';
import { importOrders } from '../../lib/order-importer';
import mongoose from 'mongoose';

export async function handleImport(req: Request, res: Response) {
  if (!req.derivedKey) return res.status(401).json({ error: 'Session key missing — please log in again' });

  const userId = req.userId;
  const integration = await Integration.findOne({ userId, provider: 'knuspr' });
  if (!integration) {
    return res.status(400).json({ error: 'Knuspr not connected. Go to Settings to connect.' });
  }

  try {
    const result = await importOrders(userId, req.derivedKey, integration);
    await Integration.findByIdAndUpdate(integration._id, { lastSyncAt: new Date() });
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

export async function handleGetStats(req: Request, res: Response) {
  const userId = (req as any).userId;

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleGetOrders(req: Request, res: Response) {
  const userId = (req as any).userId;

  try {
    const orders = await Order.find({ userId })
      .sort({ orderTimeDate: -1 })
      .select('-items'); // Don't send items for the list view to keep payload small
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleGetOrderDetail(req: Request, res: Response) {
  const userId = (req as any).userId;
  const { id } = req.params;

  try {
    const order = await Order.findOne({ userId, id: Number(id) });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
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
