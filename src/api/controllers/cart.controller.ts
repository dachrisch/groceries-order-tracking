import { Request, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import Order from '../../models/Order';
import Integration from '../../models/Integration';
import { decrypt } from '../../lib/crypto';
import { loginToKnuspr } from '../../lib/knuspr-auth';
import { formatZodError } from '../utils';

const addToCartSchema = z.object({
  productId: z.union([z.string(), z.number()]).transform(Number),
  count: z.number().optional()
});

interface KnusprCartItem {
  productId: number;
  productName: string;
  price: number;
  quantity: number;
  imgPath: string;
  textualAmount: string;
  multipack?: { price: number; savedPercents: number; needAmount: number } | null;
}

interface NormalizedCart {
  cartId: number;
  totalPrice: number;
  totalSavings: number;
  items: {
    productId: number;
    productName: string;
    price: number;
    avgPrice?: number;
    quantity: number;
    imgUrl: string;
    textualAmount: string;
    multipack?: { price: number; savedPercents: number; needAmount: number };
  }[];
}

async function normalizeCart(userId: string, data: { items: Record<string, KnusprCartItem>; cartId: number; totalPrice: number; totalSavings?: number }): Promise<NormalizedCart> {
  const knusprItems = Object.values(data.items as Record<string, KnusprCartItem>);
  const productIds = knusprItems.map(i => i.productId);

  // Fetch average prices for these products from history
  const avgPrices = await Order.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $unwind: '$items' },
    { $match: { 'items.id': { $in: productIds } } },
    {
      $group: {
        _id: '$items.id',
        avgPrice: { $avg: '$items.priceComposition.unit.amount' }
      }
    }
  ]);

  const priceMap = new Map(avgPrices.map(p => [p._id, p.avgPrice]));

  const items = knusprItems.map(item => {
    const normalized: NormalizedCart['items'][0] = {
      productId: item.productId,
      productName: item.productName,
      price: item.price,
      avgPrice: priceMap.get(item.productId),
      quantity: item.quantity,
      imgUrl: `https://cdn.knuspr.de${item.imgPath}`,
      textualAmount: item.textualAmount,
    };
    if (item.multipack) {
      normalized.multipack = {
        price: item.multipack.price,
        savedPercents: item.multipack.savedPercents,
        needAmount: item.multipack.needAmount,
      };
    }
    return normalized;
  });

  return {
    cartId: data.cartId,
    totalPrice: data.totalPrice,
    totalSavings: data.totalSavings ?? 0,
    items,
  };
}

export async function handleGetCart(req: Request, res: Response) {
  if (!req.derivedKey) {
    return res.json({ cart: null });
  }

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration?.encryptedCredentials) {
    return res.json({ cart: null });
  }

  let knusprEmail: string;
  let knusprPassword: string;
  try {
    const creds = JSON.parse(decrypt(integration.encryptedCredentials, req.derivedKey));
    knusprEmail = creds.email;
    knusprPassword = creds.password;
  } catch {
    return res.json({ cart: null });
  }

  try {
    const { session } = await loginToKnuspr(knusprEmail, knusprPassword);
    const sessionCookie = `PHPSESSION_de-production=${session}`;

    const cartResponse = await fetch(
      'https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart',
      { headers: { 'Cookie': sessionCookie, 'x-origin': 'WEB' } }
    );

    if (!cartResponse.ok) {
      return res.json({ cart: null });
    }

    const cartData = await cartResponse.json();
    return res.json({ cart: await normalizeCart(req.userId, cartData.data) });
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

  const integration = await Integration.findOne({ userId: req.userId, provider: 'knuspr' });
  if (!integration?.encryptedCredentials) {
    return res.status(404).json({ error: 'Knuspr not connected. Go to Settings to connect.' });
  }

  let knusprEmail: string;
  let knusprPassword: string;
  try {
    const creds = JSON.parse(decrypt(integration.encryptedCredentials, req.derivedKey));
    knusprEmail = creds.email;
    knusprPassword = creds.password;
  } catch {
    return res.status(401).json({ error: 'Failed to decrypt Knuspr credentials — please reconnect in Settings' });
  }

  try {
    const { session } = await loginToKnuspr(knusprEmail, knusprPassword);

    const sessionCookie = `PHPSESSION_de-production=${session}`;
    const knusprHeaders = {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie,
      'x-origin': 'WEB',
      'origin': 'https://www.knuspr.de',
    };

    // Add item to cart
    const addResponse = await fetch('https://www.knuspr.de/api/v1/cart/item', {
      method: 'POST',
      headers: knusprHeaders,
      body: JSON.stringify({
        amount: count ?? 1,
        productId,
        actionId: null,
        source: 'reorder',
      }),
    });

    if (!addResponse.ok) {
      const errorText = await addResponse.text();
      console.error('Knuspr add-to-cart error:', addResponse.status, errorText);
      return res.status(addResponse.status).json({ error: `Knuspr API error: ${addResponse.status}` });
    }

    // Verify cart and return state
    let cart: NormalizedCart | null = null;
    try {
      const cartResponse = await fetch(
        'https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart',
        { headers: { 'Cookie': sessionCookie, 'x-origin': 'WEB' } }
      );
      if (cartResponse.ok) {
        const cartData = await cartResponse.json();
        cart = await normalizeCart(req.userId, cartData.data);
      }
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
