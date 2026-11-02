import { Request, Response } from 'express';
import { getKnusprSession } from '../../lib/knuspr-auth';
import { getWeeklyConsumption } from '../../lib/bot/consumption';
import '../utils';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /api/inventory
 *
 * Learns a regular consumption rate per product group (see
 * `lib/bot/consumption.ts`) and estimates current stock. One-off purchases and
 * occasion baskets are excluded, so the list reflects what you actually
 * rebuy.
 */
export async function handleGetInventory(req: Request, res: Response) {
  const userId = req.userId;
  const now = new Date();

  try {
    const { items } = await getWeeklyConsumption(userId);

    interface InventoryRow {
      _id: number;
      groupKey: string;
      productIds: number[];
      name: string;
      image?: string;
      categories?: { id?: number; name?: string; slug?: string; level?: number }[];
      avgInterval: number;
      daysSinceLast: number;
      avgQuantity: number;
      avgPrice: number;
      stock: number;
      stockDays: number | null;
      qty: number;
      due: boolean;
      reason: string;
      confidence: string;
      ratePerDay: number;
      packSize: number;
      currentPrice?: number;
    }

    const inventory: InventoryRow[] = items.map((item) => ({
      _id: item.productId,
      groupKey: item.groupKey,
      productIds: item.productIds,
      name: item.name,
      image: item.image,
      categories: item.categories,
      // Legacy fields kept for the existing UI and API consumers.
      avgInterval: item.intervalDays,
      daysSinceLast: Math.max(0, (now.getTime() - item.lastPurchase.getTime()) / DAY_MS),
      avgQuantity: item.modeAmount,
      avgPrice: item.avgPrice,
      // New stock-aware fields.
      stock: item.stock,
      stockDays: Number.isFinite(item.stockDays) ? item.stockDays : null,
      qty: item.qty,
      due: item.due,
      reason: item.reason,
      confidence: item.confidence,
      ratePerDay: item.ratePerDay,
      packSize: item.packSize,
    }));

    // Fetch current prices from Knuspr if a session is available.
    let session: string | null = null;
    try {
      session = await getKnusprSession(userId, req.derivedKey);
    } catch (e) {
      console.warn('Failed to get Knuspr session for inventory prices:', e);
    }

    if (session) {
      const productIds = inventory.map((item) => item._id);
      const chunkSize = 50;

      for (let i = 0; i < productIds.length; i += chunkSize) {
        const chunk = productIds.slice(i, i + chunkSize);
        try {
          const queryString = chunk.map((id) => `products=${id}`).join('&');
          const priceResponse = await fetch(`https://www.knuspr.de/api/v1/products/prices?${queryString}`, {
            headers: {
              Cookie: `PHPSESSION_de-production=${session}`,
              'x-origin': 'WEB',
            },
          });

          if (priceResponse.ok) {
            const priceData = await priceResponse.json();
            priceData.forEach((p: { productId: number; price: { amount: number }; sales?: { active: boolean; price: { amount: number } }[] }) => {
              const item = inventory.find((entry) => entry._id === p.productId);
              if (item) {
                const activeSale = p.sales?.find((sale: { active: boolean }) => sale.active);
                item.currentPrice = activeSale ? activeSale.price.amount : p.price.amount;
              }
            });
          }
        } catch (e) {
          console.error(`Failed to fetch bulk pricing for chunk ${i}:`, e);
        }
      }
    }

    res.json(inventory);
  } catch (error: unknown) {
    console.error('Error in handleGetInventory:', error);
    res.status(500).json({ error: 'Failed to aggregate inventory data' });
  }
}
