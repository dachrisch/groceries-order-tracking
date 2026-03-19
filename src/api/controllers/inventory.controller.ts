import { Request, Response } from 'express';
import Order from '../../models/Order';
import { getKnusprSession } from '../../lib/knuspr-auth';
import mongoose from 'mongoose';
import '../utils';

/**
 * GET /api/inventory
 * 
 * Aggregates user inventory and calculates purchase patterns to predict reordering needs.
 * 
 * The algorithm:
 * 1. Groups items by ID across all orders for the current user.
 * 2. Collects the last 5 purchase dates for each item.
 * 3. Filters for items with at least 2 purchases (necessary to calculate intervals).
 * 4. Calculates intervals (in days) between consecutive purchases.
 * 5. Computes a weighted average interval, giving more weight to recent behavior:
 *    - Most recent interval: 50%
 *    - Second most recent: 30% (or fall back to first if missing)
 *    - Third most recent: 20% (or fall back to first if missing)
 * 6. Calculates days since the last purchase for comparison with the average interval.
 * 
 * @param req - Express request object with authenticated userId
 * @param res - Express response object
 */
export async function handleGetInventory(req: Request, res: Response) {
  const userId = req.userId;
  const now = new Date();

  try {
    const inventory = await Order.aggregate([
      // Stage 1: Filter by current user
      { 
        $match: { userId: new mongoose.Types.ObjectId(userId) } 
      },
      
      // Stage 2: Expand items array to process each item individually
      { 
        $unwind: '$items' 
      },
      
      // Stage 3: Group by item ID — push {date, amount} tuples to keep them aligned
      {
        $group: {
          _id: '$items.id',
          name: { $first: '$items.name' },
          image: { $first: { $arrayElemAt: ['$items.images', 0] } },
          categories: { $first: '$items.categories' },
          purchases: { $push: { date: '$orderTimeDate', amount: '$items.amount', price: '$items.priceComposition.unit.amount' } }
        }
      },

      // Stage 4: Sort tuples by date desc, keep most recent 5
      {
        $project: {
          _id: 1,
          name: 1,
          image: 1,
          categories: 1,
          purchases: {
            $slice: [
              { $sortArray: { input: '$purchases', sortBy: { date: -1 } } },
              5
            ]
          }
        }
      },

      // Stage 5: Filter items purchased at least twice
      { $match: { 'purchases.1': { $exists: true } } },

      // Stage 6: Extract dates and amounts from sorted tuples; compute avgQuantity
      {
        $addFields: {
          lastPurchase: { $arrayElemAt: ['$purchases.date', 0] },
          purchaseDates: '$purchases.date',
          amounts: '$purchases.amount',
          avgQuantity: {
            $max: [
              1,
              {
                $round: [
                  { $avg: '$purchases.amount' },
                  0
                ]
              }
            ]
          },
          avgPrice: { $avg: '$purchases.price' }
        }
      },

      // Stage 7: Calculate intervals from purchaseDates
      {
        $addFields: {
          intervals: {
            $map: {
              input: { $range: [0, { $subtract: [{ $size: '$purchaseDates' }, 1] }] },
              as: 'idx',
              in: {
                $divide: [
                  {
                    $subtract: [
                      { $arrayElemAt: ['$purchaseDates', '$$idx'] },
                      { $arrayElemAt: ['$purchaseDates', { $add: ['$$idx', 1] }] }
                    ]
                  },
                  1000 * 60 * 60 * 24
                ]
              }
            }
          }
        }
      },

      // Stage 8: Weighted average interval and daysSinceLast
      {
        $addFields: {
          avgInterval: {
            $let: {
              vars: {
                g1: { $arrayElemAt: ['$intervals', 0] },
                g2: { $arrayElemAt: ['$intervals', 1] },
                g3: { $arrayElemAt: ['$intervals', 2] }
              },
              in: {
                $add: [
                  { $multiply: ['$$g1', 0.5] },
                  { $cond: ['$$g2', { $multiply: ['$$g2', 0.3] }, { $multiply: ['$$g1', 0.3] }] },
                  { $cond: ['$$g3', { $multiply: ['$$g3', 0.2] }, { $multiply: ['$$g1', 0.2] }] }
                ]
              }
            }
          },
          daysSinceLast: {
            $divide: [
              { $subtract: [now, '$lastPurchase'] },
              1000 * 60 * 60 * 24
            ]
          }
        }
      },

      // Stage 9: Shape public output
      {
        $project: {
          _id: 1,
          name: 1,
          image: 1,
          categories: 1,
          avgInterval: 1,
          daysSinceLast: 1,
          avgQuantity: 1,
          avgPrice: 1,
        }
      },

      // Stage 10: Sort by average rebuy time
      {
        $sort: { avgInterval: 1 }
      }
    ]);

    // Fetch current prices from Knuspr if session is available
    let session: string | null = null;
    try {
      session = await getKnusprSession(userId, req.derivedKey);
    } catch (e) {
      console.warn('Failed to get Knuspr session for inventory prices:', e);
    }

    if (session) {
      const fetchPrice = async (item: any) => {
        try {
          const res = await fetch(`https://www.knuspr.de/api/v1/products/${item._id}/prices`, {
            headers: {
              'Cookie': `PHPSESSION_de-production=${session}`,
              'x-origin': 'WEB',
            },
          });
          if (res.ok) {
            const data = await res.json();
            // The Knuspr API often returns price in data.price or just price
            item.currentPrice = data.data?.price || data.price;
          }
        } catch (e) {
          console.error(`Failed to fetch price for ${item._id}:`, e);
        }
      };

      // Limit concurrency by processing in chunks of 10
      for (let i = 0; i < inventory.length; i += 10) {
        const chunk = inventory.slice(i, i + 10);
        await Promise.all(chunk.map(fetchPrice));
      }
    }

    res.json(inventory);
  } catch (error: unknown) {
    console.error('Error in handleGetInventory:', error);
    res.status(500).json({ error: 'Failed to aggregate inventory data' });
  }
}
