import { Request, Response } from 'express';
import Order from '../../models/Order';
import mongoose from 'mongoose';

export const handleGetInventory = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const now = new Date();

  const inventory = await Order.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $unwind: '$items' },
    { $group: {
        _id: '$items.id',
        name: { $first: '$items.name' },
        image: { $first: { $arrayElemAt: ['$items.images', 0] } },
        purchases: { $push: '$orderTimeDate' }
    }},
    { $project: {
        _id: 1, name: 1, image: 1,
        purchases: { $slice: [{ $sortArray: { input: '$purchases', sortBy: -1 } }, 5] }
    }},
    { $match: { 'purchases.1': { $exists: true } } }, // At least 2 purchases
    { $addFields: {
        lastPurchase: { $arrayElemAt: ['$purchases', 0] },
        intervals: {
          $map: {
            input: { $range: [0, { $subtract: [{ $size: '$purchases' }, 1] }] },
            as: 'idx',
            in: {
              $divide: [
                { $subtract: [{ $arrayElemAt: ['$purchases', '$$idx'] }, { $arrayElemAt: ['$purchases', { $add: ['$$idx', 1] }] }] },
                1000 * 60 * 60 * 24
              ]
            }
          }
        }
    }},
    { $addFields: {
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
        daysSinceLast: { $divide: [{ $subtract: [now, '$lastPurchase'] }, 1000 * 60 * 60 * 24] }
    }}
  ]);

  res.json(inventory);
};
