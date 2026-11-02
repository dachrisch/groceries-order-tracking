import mongoose from 'mongoose';
import Order from '../models/Order';

const KNUSPR_BASE = 'https://www.knuspr.de';

export interface KnusprCartItem {
  productId: number;
  productName: string;
  price: number;
  quantity: number;
  imgPath: string;
  textualAmount: string;
  multipack?: { price: number; savedPercents: number; needAmount: number } | null;
}

export interface NormalizedCartItem {
  productId: number;
  productName: string;
  price: number;
  avgPrice?: number;
  quantity: number;
  imgUrl: string;
  textualAmount: string;
  multipack?: { price: number; savedPercents: number; needAmount: number };
}

export interface NormalizedCart {
  cartId: number;
  totalPrice: number;
  totalSavings: number;
  items: NormalizedCartItem[];
}

export interface RawCart {
  cartId: number;
  totalPrice: number;
  totalSavings?: number;
  items: Record<string, KnusprCartItem>;
}

export interface CartLine {
  productId: number;
  amount: number;
}

export interface CartPrice {
  price: number;
  salePrice?: number;
  effectivePrice: number;
  salePercent?: number;
}

function sessionHeaders(session: string, json = false): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Cookie: `PHPSESSION_de-production=${session}`,
    'x-origin': 'WEB',
    ...(json ? { origin: KNUSPR_BASE } : {}),
  };
}

export async function normalizeCart(userId: string, data: RawCart): Promise<NormalizedCart> {
  const knusprItems = Object.values(data.items);
  const productIds = knusprItems.map((item) => item.productId);

  const avgPrices = await Order.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $unwind: '$items' },
    { $match: { 'items.id': { $in: productIds } } },
    {
      $group: {
        _id: '$items.id',
        avgPrice: { $avg: '$items.priceComposition.unit.amount' },
      },
    },
  ]);

  const priceMap = new Map<number, number>(avgPrices.map((entry) => [entry._id, entry.avgPrice]));

  return {
    cartId: data.cartId,
    totalPrice: data.totalPrice,
    totalSavings: data.totalSavings ?? 0,
    items: knusprItems.map((item) => {
      const normalized: NormalizedCartItem = {
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
    }),
  };
}

/** Raw check-cart call. Returns null when Knuspr does not answer. */
export async function checkCart(session: string): Promise<RawCart | null> {
  try {
    const response = await fetch(`${KNUSPR_BASE}/services/frontend-service/v2/cart-review/check-cart`, {
      headers: sessionHeaders(session),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.data as RawCart;
  } catch (error) {
    console.error('check-cart failed:', error);
    return null;
  }
}

export async function getCart(userId: string, session: string): Promise<NormalizedCart | null> {
  const raw = await checkCart(session);
  return raw ? normalizeCart(userId, raw) : null;
}

/** Add several lines with one session. Failures are reported per line. */
export async function addItems(
  session: string,
  items: CartLine[]
): Promise<{ added: CartLine[]; failed: Array<{ item: CartLine; error: string; status?: number }> }> {
  const added: CartLine[] = [];
  const failed: Array<{ item: CartLine; error: string; status?: number }> = [];

  for (const item of items) {
    try {
      const response = await fetch(`${KNUSPR_BASE}/api/v1/cart/item`, {
        method: 'POST',
        headers: sessionHeaders(session, true),
        body: JSON.stringify({
          amount: item.amount,
          productId: item.productId,
          actionId: null,
          source: 'reorder',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Knuspr add-to-cart error:', response.status, errorText);
        failed.push({ item, error: `Knuspr API error: ${response.status}`, status: response.status });
      } else {
        added.push(item);
      }
    } catch (error) {
      failed.push({ item, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { added, failed };
}

/**
 * Best-effort cart removal. Knuspr's public web API does not document this
 * endpoint; both known shapes are tried and the cart is verified afterwards.
 * Callers fall back to a cart link when it fails.
 */
export async function removeItems(
  userId: string,
  session: string,
  items: CartLine[]
): Promise<{ removed: CartLine[]; failed: Array<{ item: CartLine; error: string }> }> {
  const before = await getCart(userId, session);
  const beforeQty = new Map(before?.items.map((item) => [item.productId, item.quantity]) ?? []);

  const removed: CartLine[] = [];
  const failed: Array<{ item: CartLine; error: string }> = [];

  for (const item of items) {
    try {
      let response = await fetch(`${KNUSPR_BASE}/api/v1/cart/item`, {
        method: 'DELETE',
        headers: sessionHeaders(session, true),
        body: JSON.stringify({ productId: item.productId, amount: item.amount }),
      });

      if (!response.ok) {
        response = await fetch(
          `${KNUSPR_BASE}/api/v1/cart/item/${item.productId}?amount=${item.amount}`,
          { method: 'DELETE', headers: sessionHeaders(session) }
        );
      }

      if (!response.ok) {
        failed.push({ item, error: `Knuspr remove failed: ${response.status}` });
      } else {
        removed.push(item);
      }
    } catch (error) {
      failed.push({ item, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Verify against the cart so a 200 that changed nothing is not reported as success.
  if (removed.length > 0) {
    const after = await getCart(userId, session);
    const afterQty = new Map(after?.items.map((item) => [item.productId, item.quantity]) ?? []);
    const toVerify = removed.slice();
    for (const item of toVerify) {
      const previous = beforeQty.get(item.productId) ?? 0;
      const current = afterQty.get(item.productId) ?? 0;
      if (current >= previous) {
        removed.splice(removed.indexOf(item), 1);
        failed.push({ item, error: 'Knuspr did not change the cart quantity' });
      }
    }
  }

  return { removed, failed };
}

/** Bulk price lookup. Returns an empty map when the session/API is unavailable. */
export async function fetchPrices(session: string, productIds: number[]): Promise<Map<number, CartPrice>> {
  const result = new Map<number, CartPrice>();
  const unique = [...new Set(productIds)];
  const chunkSize = 50;

  for (let index = 0; index < unique.length; index += chunkSize) {
    const chunk = unique.slice(index, index + chunkSize);
    try {
      const query = chunk.map((id) => `products=${id}`).join('&');
      const response = await fetch(`${KNUSPR_BASE}/api/v1/products/prices?${query}`, {
        headers: sessionHeaders(session),
      });
      if (!response.ok) continue;

      const data = await response.json();
      for (const product of data as Array<{
        productId: number;
        price: { amount: number };
        sales?: Array<{ active: boolean; price: { amount: number }; percentage?: number }>;
      }>) {
        const activeSale = product.sales?.find((sale) => sale.active);
        const price = product.price?.amount;
        if (typeof price !== 'number') continue;
        const salePrice = activeSale?.price?.amount;
        const effectivePrice = typeof salePrice === 'number' ? salePrice : price;
        result.set(product.productId, {
          price,
          salePrice: typeof salePrice === 'number' ? salePrice : undefined,
          effectivePrice,
          salePercent: typeof activeSale?.percentage === 'number'
            ? activeSale.percentage
            : typeof salePrice === 'number' && price > 0
              ? Math.round((1 - salePrice / price) * 100)
              : undefined,
        });
      }
    } catch (error) {
      console.error(`Failed to fetch prices for chunk ${index}:`, error);
    }
  }

  return result;
}

export function cartQuantityByProduct(cart: NormalizedCart | null): Map<number, number> {
  return new Map(cart?.items.map((item) => [item.productId, item.quantity]) ?? []);
}
