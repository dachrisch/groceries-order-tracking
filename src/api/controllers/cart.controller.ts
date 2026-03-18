import { Request, Response } from 'express';
import { z } from 'zod';
import Integration from '../../models/Integration';
import { decrypt } from '../../lib/crypto';
import { formatZodError } from '../utils';

const addToCartSchema = z.object({
  productId: z.string().min(1, 'Product ID is required'),
  count: z.number().optional()
});

export async function handleAddToCart(req: Request, res: Response) {
  const result = addToCartSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: formatZodError(result.error) });
  }

  const { productId, count } = result.data;
  const integration = await Integration.findOne({ userId: req.userId });
  
  if (!integration || !integration.headers) {
    return res.status(404).json({ error: 'No integration found' });
  }

  if (!req.derivedKey) {
    return res.status(401).json({ error: 'Session key missing — please re-login' });
  }

  try {
    // Decrypt headers
    const decryptedHeaders = decrypt(integration.headers, req.derivedKey);
    const headers = JSON.parse(decryptedHeaders);

    const response = await fetch('https://www.knuspr.de/services/frontend-service/metric/add-to-cart', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { id: null, type: 'GENERAL' },
        component: { id: null, type: 'PRODUCT_LIST' },
        isAuthenticated: true,
        userId: headers['x-knuspr-userid'] || "3896299", // Fallback or extract
        item: { id: productId, type: 'PRODUCT', position: 1, count: count || 1 }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Knuspr API error:', errorText);
      return res.status(response.status).json({ error: 'Knuspr API error' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Add to cart failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
