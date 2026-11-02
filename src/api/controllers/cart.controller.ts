import { Request, Response } from 'express';
import { z } from 'zod';
import Integration from '../../models/Integration';
import { addItems, getCart } from '../../lib/knuspr-cart';
import { getKnusprSession } from '../../lib/knuspr-auth';
import { formatZodError } from '../utils';

const addToCartSchema = z.object({
  productId: z.union([z.string(), z.number()]).transform(Number),
  count: z.number().optional(),
});

export async function handleGetCart(req: Request, res: Response) {
  if (!req.derivedKey) {
    return res.json({ cart: null });
  }

  try {
    const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
    if (!integration?.encryptedCredentials) return res.json({ cart: null });

    const session = await getKnusprSession(req.userId, req.derivedKey);
    return res.json({ cart: await getCart(req.userId, session) });
  } catch (err) {
    console.error('get-cart failed:', err);
    return res.json({ cart: null });
  }
}

export async function handleAddToCart(req: Request, res: Response) {
  const result = addToCartSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: formatZodError(result.error) });
  }

  const { productId, count } = result.data;

  if (!req.derivedKey) {
    return res.status(401).json({ error: 'Session key missing — please re-login' });
  }

  try {
    const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
    if (!integration?.encryptedCredentials) {
      return res.status(404).json({ error: 'Knuspr not connected. Go to Settings to connect.' });
    }

    const session = await getKnusprSession(req.userId, req.derivedKey);
    const { failed } = await addItems(session, [{ productId, amount: count ?? 1 }]);

    if (failed.length > 0) {
      return res.status(failed[0].status ?? 502).json({ error: failed[0].error });
    }

    let cart = null;
    try {
      cart = await getCart(req.userId, session);
    } catch (err) {
      console.error('check-cart failed (non-fatal):', err);
    }

    res.json({ success: true, cart });
  } catch (err: unknown) {
    console.error('Add to cart failed:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
}
