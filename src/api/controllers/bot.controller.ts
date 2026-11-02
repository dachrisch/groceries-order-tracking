import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import BotRun from '../../models/BotRun';
import BotSettings, { BOT_SETTINGS_DEFAULTS } from '../../models/BotSettings';
import ProductGroup from '../../models/ProductGroup';
import Order from '../../models/Order';
import { getKnusprSession } from '../../lib/knuspr-auth';
import { removeItems } from '../../lib/knuspr-cart';
import { executeWeeklyFill, getBotSettings } from '../../lib/bot/fill';
import { getProductGroups, invalidateProductGroupCache } from '../../lib/bot/product-groups';
import { getBotJob, startBotJob } from '../../lib/bot/jobs';
import { detectOccasions, fillOccasion } from '../../lib/bot/occasions';
import Occasion from '../../models/Occasion';
import { formatZodError } from '../utils';
import '../utils';

const fillWeekSchema = z.object({
  confirm: z.boolean().optional(),
});

const mergeGroupsSchema = z.object({
  productIds: z.array(z.union([z.string(), z.number()]).transform(Number)).min(2),
});

const splitGroupSchema = z.object({
  productId: z.union([z.string(), z.number()]).transform(Number),
});

const messageSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

const occasionFillSchema = z.object({
  servings: z.number().int().min(1).max(100),
  confirm: z.boolean().optional(),
});

const settingsSchema = z.object({
  maxEuro: z.number().min(1).max(10_000).optional(),
  maxItems: z.number().int().min(1).max(500).optional(),
  horizonDays: z.number().int().min(1).max(60).optional(),
  deliveryLeadDays: z.number().int().min(0).max(14).optional(),
  opencodeEnabled: z.boolean().optional(),
});

function serializeRun(run: unknown): unknown {
  const doc = run as { toObject?: () => unknown };
  return doc.toObject ? doc.toObject() : run;
}

function requireKey(req: Request, res: Response): Buffer | null {
  if (!req.derivedKey) {
    res.status(401).json({ error: 'Session key missing — please re-login' });
    return null;
  }
  return req.derivedKey;
}

export async function handleBotMessage(req: Request, res: Response) {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }

  try {
    const job = startBotJob(req.userId, parsed.data.text, req.derivedKey);
    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not start job' });
  }
}

export async function handleGetJob(req: Request, res: Response) {
  const job = getBotJob(req.userId, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}

export async function handleGetOccasions(req: Request, res: Response) {
  try {
    const occasions = await Occasion.find({ userId: req.userId }).sort({ lastSeen: -1 }).lean();
    res.json(occasions);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load occasions' });
  }
}

export async function handleGetOccasion(req: Request, res: Response) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid occasion id' });
  }
  try {
    const occasion = await Occasion.findOne({ _id: id, userId: req.userId }).lean();
    if (!occasion) return res.status(404).json({ error: 'Occasion not found' });
    res.json(occasion);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load occasion' });
  }
}

export async function handleFillOccasion(req: Request, res: Response) {
  const parsed = occasionFillSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const key = requireKey(req, res);
  if (!key) return;

  try {
    const result = await fillOccasion(
      req.userId,
      key,
      req.params.id,
      parsed.data.servings,
      { confirm: parsed.data.confirm }
    );
    res.json({ ...result, run: serializeRun(result.run) });
  } catch (error) {
    console.error('occasion fill failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Occasion fill failed' });
  }
}

export async function handleDetectOccasions(req: Request, res: Response) {
  try {
    await detectOccasions(req.userId);
    const occasions = await Occasion.find({ userId: req.userId }).sort({ lastSeen: -1 }).lean();
    res.json(occasions);
  } catch (error) {
    console.error('occasion detection failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Detection failed' });
  }
}

export async function handleFillWeek(req: Request, res: Response) {
  const parsed = fillWeekSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const key = requireKey(req, res);
  if (!key) return;

  try {
    const result = await executeWeeklyFill(req.userId, key, { confirm: parsed.data.confirm });
    res.json({ ...result, run: serializeRun(result.run) });
  } catch (error) {
    console.error('fill-week failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Fill failed' });
  }
}

export async function handleGetRuns(req: Request, res: Response) {
  try {
    const runs = await BotRun.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(runs);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load runs' });
  }
}

export async function handleUndoRun(req: Request, res: Response) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid run id' });
  }
  const key = requireKey(req, res);
  if (!key) return;

  try {
    const run = await BotRun.findOne({ _id: id, userId: req.userId });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'in-cart') {
      return res.status(409).json({ error: `Run is ${run.status} and can no longer be undone` });
    }

    const session = await getKnusprSession(req.userId, key);
    const { removed, failed } = await removeItems(
      req.userId,
      session,
      run.items.map((item) => ({ productId: item.productId, amount: item.qty }))
    );

    if (failed.length > 0) {
      return res.status(502).json({
        error: 'Knuspr did not remove every item',
        removed: removed.length,
        failed,
        cartUrl: 'https://www.knuspr.de/bestellung/mein-warenkorb',
      });
    }

    run.status = 'undone';
    await run.save();
    res.json({ run: serializeRun(run), removed: removed.length });
  } catch (error) {
    console.error('undo failed:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Undo failed',
      cartUrl: 'https://www.knuspr.de/bestellung/mein-warenkorb',
    });
  }
}

export async function handleGetGroups(req: Request, res: Response) {
  try {
    const groups = await getProductGroups(req.userId);
    const productIds = groups.flatMap((group) => group.productIds);

    const products = await Order.aggregate<{
      _id: number;
      name: string;
      textualAmount?: string;
      image?: string;
      purchaseCount: number;
    }>([
      { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
      { $unwind: '$items' },
      { $match: { 'items.id': { $in: productIds } } },
      {
        $group: {
          _id: '$items.id',
          name: { $last: '$items.name' },
          textualAmount: { $last: '$items.textualAmount' },
          image: { $last: { $arrayElemAt: ['$items.images', 0] } },
          purchaseCount: { $sum: 1 },
        },
      },
    ]);

    const productMap = new Map(products.map((product) => [product._id, product]));
    res.json(
      groups.map((group) => ({
        ...group,
        products: group.productIds.map((productId) => productMap.get(productId) ?? { _id: productId }),
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load groups' });
  }
}

export async function handleMergeGroups(req: Request, res: Response) {
  const parsed = mergeGroupsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }

  try {
    const productIds = [...new Set(parsed.data.productIds)];
    const firstProduct = await Order.findOne({ userId: req.userId, 'items.id': productIds[0] })
      .select('items')
      .lean();
    const label = firstProduct?.items?.find((item) => item.id === productIds[0])?.name ?? `Group ${productIds[0]}`;
    const key = `manual:${[...productIds].sort((a, b) => a - b).join('-')}`;

    // A product belongs to at most one manual group.
    await ProductGroup.updateMany(
      { userId: req.userId, manual: true },
      { $pull: { productIds: { $in: productIds } } }
    );
    await ProductGroup.deleteMany({ userId: req.userId, manual: true, productIds: { $size: 1 } });
    await ProductGroup.deleteMany({ userId: req.userId, manual: true, productIds: { $size: 0 } });

    await ProductGroup.findOneAndUpdate(
      { userId: req.userId, key },
      { $set: { label, productIds, manual: true } },
      { upsert: true, returnDocument: 'after' }
    );

    invalidateProductGroupCache(req.userId);
    res.json({ groups: await getProductGroups(req.userId) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Merge failed' });
  }
}

export async function handleSplitGroup(req: Request, res: Response) {
  const parsed = splitGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid group id' });
  }

  try {
    const group = await ProductGroup.findOne({ _id: id, userId: req.userId, manual: true });
    if (!group) return res.status(404).json({ error: 'Manual group not found' });

    group.productIds = group.productIds.filter((productId) => productId !== parsed.data.productId);
    if (group.productIds.length < 2) {
      await ProductGroup.deleteOne({ _id: group._id });
    } else {
      await group.save();
    }

    invalidateProductGroupCache(req.userId);
    res.json({ groups: await getProductGroups(req.userId) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Split failed' });
  }
}

export async function handleGetSettings(req: Request, res: Response) {
  try {
    res.json(await getBotSettings(req.userId));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load settings' });
  }
}

export async function handleUpdateSettings(req: Request, res: Response) {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }

  try {
    const settings = await BotSettings.findOneAndUpdate(
      { userId: req.userId },
      { $set: parsed.data, $setOnInsert: { userId: req.userId } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).lean();

    res.json({
      maxEuro: settings?.maxEuro ?? BOT_SETTINGS_DEFAULTS.maxEuro,
      maxItems: settings?.maxItems ?? BOT_SETTINGS_DEFAULTS.maxItems,
      horizonDays: settings?.horizonDays ?? BOT_SETTINGS_DEFAULTS.horizonDays,
      deliveryLeadDays: settings?.deliveryLeadDays ?? BOT_SETTINGS_DEFAULTS.deliveryLeadDays,
      opencodeEnabled: settings?.opencodeEnabled ?? BOT_SETTINGS_DEFAULTS.opencodeEnabled,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save settings' });
  }
}
