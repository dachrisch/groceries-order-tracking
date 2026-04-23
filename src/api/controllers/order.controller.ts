import { Request, Response } from 'express';
import Order from '../../models/Order';
import { getKnusprSession } from '../../lib/knuspr-auth';
import mongoose from 'mongoose';

export async function handleGetProductPrice(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const session = await getKnusprSession(req.userId, req.derivedKey);
    const response = await fetch(`https://www.knuspr.de/api/v1/products/${id}/prices`, {
      headers: {
        'Cookie': `PHPSESSION_de-production=${session}`,
        'x-origin': 'WEB',
      },
    });

    if (!response.ok) {
      throw new Error(`Knuspr API returned ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}

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
          image: { $first: { $arrayElemAt: ["$items.images", 0] } },
          categories: { $first: "$items.categories" }
        }
      },
      { $sort: { "_id.name": 1 } }
    ]);

    // Fetch current prices from Knuspr if session is available
    let session: string | null = null;
    try {
      session = await getKnusprSession(userId, req.derivedKey);
    } catch (e) {
      console.warn('Failed to get Knuspr session for product trends:', e);
    }

    if (session) {
      const fetchEnhancedMetadata = async (item: { 
        _id: { id: number; name: string }; 
        currentPrice?: number; 
        priceValidUntil?: string; 
        availabilityStatus?: string; 
        availabilityReason?: string 
      }) => {
        try {
          const res = await fetch(`https://www.knuspr.de/api/v1/products/${item._id.id}`, {
            headers: {
              'Cookie': `PHPSESSION_de-production=${session}`,
              'x-origin': 'WEB',
            },
          });
          if (res.ok) {
            const data = await res.json();
            const product = data.data ?? data;

            if (product.prices) {
              const { salePrice, originalPrice, saleValidTill } = product.prices;
              item.currentPrice = salePrice ?? originalPrice;
              item.priceValidUntil = saleValidTill;
            }

            if (product.stock) {
              item.availabilityStatus = product.stock.availabilityStatus;
              item.availabilityReason = product.stock.availabilityReason;
            }
          }
        } catch (e) {
          console.error(`Failed to fetch enhanced metadata for ${item._id.id}:`, e);
        }
      };

      // Limit concurrency by processing in chunks of 10
      for (let i = 0; i < trends.length; i += 10) {
        const chunk = trends.slice(i, i + 10);
        await Promise.all(chunk.map(fetchEnhancedMetadata));
      }
    }

    res.json(trends);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
}
