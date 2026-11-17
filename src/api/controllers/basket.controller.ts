import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { addToBasket, undoBasketRun, type BasketResult } from '../../lib/basket';
import { formatZodError } from '../utils';
import '../utils';

/**
 * Basket writes: one request shape for both stores.
 *
 * The destination is chosen by the caller (the UI derives a default from the
 * location), but the *reachability* of that destination is decided here. A
 * hidden or greyed-out button never protects a cart: the server refuses a
 * destination whose provider cannot reach the shopper.
 */

const itemSchema = z.object({
  provider: z.enum(['knuspr', 'edeka']),
  productId: z.coerce.number().int().positive().optional(),
  textKey: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200),
  qty: z.number().int().min(1).max(100),
});

const addSchema = z
  .object({
    destination: z.enum(['knuspr-cart', 'edeka-list', 'checklist']),
    // One request per basket action: 200 lines is already far past a weekly fill.
    items: z.array(itemSchema).min(1).max(200),
  })
  .superRefine((body, ctx) => {
    body.items.forEach((item, index) => {
      if (body.destination === 'knuspr-cart' && item.provider !== 'knuspr') {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'provider'],
          message: 'a Knuspr cart line needs provider "knuspr"',
        });
      }
      if (body.destination === 'knuspr-cart' && typeof item.productId !== 'number') {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'productId'],
          message: 'a Knuspr cart line needs a productId',
        });
      }
      if (body.destination === 'edeka-list' && item.provider !== 'edeka') {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'provider'],
          message: 'an EDEKA list line needs provider "edeka"',
        });
      }
    });
  });

function requireKey(req: Request, res: Response): Buffer | null {
  if (!req.derivedKey) {
    res.status(401).json({ error: 'Session key missing — please re-login' });
    return null;
  }
  return req.derivedKey;
}

function sendResult(res: Response, result: BasketResult) {
  if (result.status === 'unavailable') {
    return res.status(409).json({ ...result, error: result.error });
  }
  if (result.status === 'blocked') {
    return res.status(409).json({ ...result, error: result.guardrail.reason });
  }
  res.json(result);
}

/** POST /api/basket/add — write the basket to its destination, or explain why not. */
export async function handleAddToBasket(req: Request, res: Response) {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });
  const key = requireKey(req, res);
  if (!key) return;

  try {
    const result = await addToBasket(req.userId, {
      destination: parsed.data.destination,
      items: parsed.data.items,
      derivedKey: key,
    });
    sendResult(res, result);
  } catch (error) {
    console.error('basket add failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'basket add failed' });
  }
}

/** POST /api/basket/undo/:runId — undo one run in the store it was written to. */
export async function handleUndoBasketRun(req: Request, res: Response) {
  const runId = String(req.params.runId);
  if (!mongoose.isValidObjectId(runId)) {
    return res.status(400).json({ error: 'Invalid run id', undone: false, restored: 0 });
  }
  const key = requireKey(req, res);
  if (!key) return;

  try {
    const result = await undoBasketRun(req.userId, runId, { derivedKey: key });
    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Run not found', undone: false, restored: 0 });
    }
    if (result.status === 'not-undoable') {
      return res.status(409).json({ error: result.reason, undone: false, restored: 0 });
    }
    if (result.status === 'failed') {
      return res.status(502).json({
        error: result.reason,
        undone: false,
        restored: result.restored,
        failed: result.failed,
      });
    }
    res.json({ undone: true, restored: result.restored });
  } catch (error) {
    console.error('basket undo failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'basket undo failed' });
  }
}
