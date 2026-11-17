import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import BotSettings, { BOT_SETTINGS_DEFAULTS } from '../../models/BotSettings';
import Integration, { IntegrationProvider } from '../../models/Integration';
import Order from '../../models/Order';
import ProductLink from '../../models/ProductLink';
import PurchaseSession from '../../models/PurchaseSession';
import { getWeeklyConsumption } from '../../lib/bot/consumption';
import { getLocationSettings } from '../../lib/bot/location-settings';
import { aggregateEdeka, edekaDue, edekaStat } from '../../lib/product-stats';
import { getProductGroupMap } from '../../lib/bot/product-groups';
import { resolveLinks, type ProductLinkSource } from '../../lib/product-links';
import { availability, derivedDestination, resolveLocation, type ProductStat } from '../../lib/providers';
import { toCandidate } from '../../lib/easyshopper/match';
import { ensureSession } from './easyshopper.controller';
import { formatZodError } from '../utils';
import '../utils';

/**
 * The shopping surface: one list over both sources, and one search box.
 *
 * Rates stay per provider (§2 D1), so an item carries `statsByProvider` rather
 * than a single number. A character with data from one shop simply has one key,
 * and no code path here can average the two.
 */

type SourceFilter = 'knuspr' | 'edeka' | 'both';

interface BrowseOffer {
  provider: 'knuspr' | 'edeka';
  available: boolean;
  reason: string;
  price: number | null;
  productId?: number;
  textKey?: string;
}

interface BrowseItem {
  id: string;
  name: string;
  /** Knuspr group label, so the UI can group variants without re-deriving it. */
  groupLabel: string | null;
  image: string | null;
  statsByProvider: { knuspr?: ProductStat; edeka?: ProductStat };
  offers: BrowseOffer[];
  due: boolean;
  /** Knuspr only: estimated days of stock left. */
  stockDays: number | null;
  /**
   * True when the last purchase is older than the consumption window, so this
   * row has a name and a price but no rate, stock or due date. The UI shows
   * "last bought <date>" instead of a cadence for these.
   */
  outsideWindow: boolean;
  /**
   * Set when an EDEKA bucket was folded into this row. Display only: no number on
   * this item is derived from the EDEKA side, and the shopper can unlink it.
   */
  linked?: { confidence: number; source: ProductLinkSource };
}

/** A receipt row as the model stores it; annotated so `lean()` arrays stay typed. */
interface SessionItem {
  brand?: string | null;
  name: string;
  quantity?: number | null;
  unitPrice?: number | null;
  lineTotal?: number | null;
  isCredit?: boolean;
}

function parseSource(value: unknown): SourceFilter {
  return value === 'knuspr' || value === 'edeka' ? value : 'both';
}

function isDueOnly(value: unknown): boolean {
  return value === '1' || value === 'true';
}

interface LifetimeGroup {
  groupKey: string;
  groupLabel: string;
  name: string;
  image: string | null;
  productId: number;
  /** Every product id of the group, so a manual link survives an id rotation. */
  productIds: number[];
  /** Every purchase ever, not just the ones inside the rate window. */
  purchases: number;
  qty: number;
  lastBought: Date;
  avgPrice: number | null;
}

/**
 * Every Knuspr product group the shopper has ever bought.
 *
 * `getWeeklyConsumption` deliberately looks at the last 26 weeks — that is what
 * a rate means. Browsing is a different question: a product bought eight months
 * ago should still be listed, and its count should be the real one. So this
 * reads all orders and groups them with the same product-group map the learning
 * uses, without touching any rate.
 */
async function loadKnusprLifetime(userId: string): Promise<LifetimeGroup[]> {
  const rows = await Order.aggregate<{
    _id: number;
    name: string;
    image: string | null;
    qty: number;
    purchases: number;
    lastBought: Date;
    avgPrice: number | null;
  }>([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.id',
        name: { $last: '$items.name' },
        image: { $last: { $arrayElemAt: ['$items.images', 0] } },
        qty: { $sum: '$items.amount' },
        purchases: { $sum: 1 },
        lastBought: { $max: '$orderTimeDate' },
        avgPrice: { $avg: '$items.priceComposition.unit.amount' },
      },
    },
  ]);

  const groupMap = await getProductGroupMap(userId);
  const byGroup = new Map<string, LifetimeGroup>();

  for (const row of rows) {
    const group = groupMap.get(row._id);
    const groupKey = group?.key ?? `product:${row._id}`;
    const existing = byGroup.get(groupKey);

    if (!existing) {
      byGroup.set(groupKey, {
        groupKey,
        groupLabel: group?.label ?? row.name,
        name: row.name,
        image: row.image ?? null,
        productId: row._id,
        productIds: group?.productIds?.length ? [...group.productIds] : [row._id],
        purchases: row.purchases,
        qty: row.qty,
        lastBought: row.lastBought,
        avgPrice: row.avgPrice === null ? null : Number(row.avgPrice.toFixed(2)),
      });
      continue;
    }

    existing.purchases += row.purchases;
    existing.qty += row.qty;
    if (!existing.productIds.includes(row._id)) existing.productIds.push(row._id);
    if (row.avgPrice !== null) {
      existing.avgPrice = existing.avgPrice === null
        ? Number(row.avgPrice.toFixed(2))
        : Number(((existing.avgPrice + row.avgPrice) / 2).toFixed(2));
    }
    // The newest product of the group supplies the name and image the row shows.
    if (row.lastBought > existing.lastBought) {
      existing.lastBought = row.lastBought;
      existing.name = row.name;
      existing.image = row.image ?? existing.image;
      existing.productId = row._id;
    }
  }

  return [...byGroup.values()];
}

/** GET /api/products — the merged list, one stat row per provider. */
export async function handleGetProducts(req: Request, res: Response) {
  try {
    const now = new Date();
    const [location, settingsDoc, sessions, manualLinks] = await Promise.all([
      getLocationSettings(req.userId),
      BotSettings.findOne({ userId: req.userId }).lean(),
      PurchaseSession.find({ userId: req.userId }).sort({ purchasedAt: 1 }).lean(),
      ProductLink.find({ userId: req.userId }).lean(),
    ]);

    const horizonDays = settingsDoc?.horizonDays ?? BOT_SETTINGS_DEFAULTS.horizonDays;
    const deliveryLeadDays = settingsDoc?.deliveryLeadDays ?? BOT_SETTINGS_DEFAULTS.deliveryLeadDays;

    const context = resolveLocation(now, location);
    const knusprReach = availability('knuspr', context);
    const edekaReach = availability('edeka', context);
    const destination = derivedDestination(context);

    // Two questions, two sources: the rate comes from the window, the list from
    // every purchase ever. Neither feeds the other.
    const [consumption, lifetime] = await Promise.all([
      getWeeklyConsumption(req.userId, { now, horizonDays, deliveryLeadDays }),
      loadKnusprLifetime(req.userId),
    ]);
    const windowDays = Math.round(
      (consumption.referenceNow.getTime() - consumption.windowStart.getTime()) / (24 * 60 * 60 * 1000)
    );
    const inWindow = new Map(consumption.items.map((item) => [item.groupKey, item]));
    const edekaStats = aggregateEdeka(
      sessions.map((session) => ({
        purchasedAt: session.purchasedAt,
        store: session.store,
        total: session.total,
        items: ((session.items ?? []) as SessionItem[]).map((item) => ({
          brand: item.brand ?? null,
          name: item.name,
          quantity: item.quantity ?? 1,
          unitPrice: item.unitPrice ?? null,
          lineTotal: item.lineTotal ?? null,
          isCredit: item.isCredit ?? false,
        })),
      }))
    );

    const items: BrowseItem[] = [];

    // Manual corrections and automatic name matches, resolved on every read. A
    // manual row beats the matcher (confidence 1); an automatic one is never
    // stored, so it disappears with the receipts that justified it.
    const links = resolveLinks(
      lifetime.map((group) => ({
        productId: group.productId,
        productIds: group.productIds,
        name: group.name,
      })),
      edekaStats.values(),
      manualLinks.map((link) => ({
        knusprProductId: link.knusprProductId,
        edekaTextKey: link.edekaTextKey,
        confidence: link.confidence,
      }))
    );

    // An EDEKA bucket that backs a linked row is shown there instead of standing
    // alone; every other bucket keeps its own row exactly as before.
    const mergedTextKeys = new Set<string>();

    for (const group of lifetime) {
      const rate = inWindow.get(group.groupKey);
      const stat: ProductStat = {
        provider: 'knuspr',
        // The count the shopper sees is the lifetime one; the cadence is only
        // claimed when the window has enough purchases to support it.
        purchases: group.purchases,
        cadenceDays: rate && rate.purchaseCount >= 3 ? Math.round(rate.intervalDays) : null,
        lastBought: group.lastBought,
        avgPrice: rate ? Number(rate.avgPrice.toFixed(2)) : group.avgPrice,
      };
      const link = links.get(group.productId) ?? null;
      const linkedBucket = link ? edekaStats.get(link.edekaTextKey) ?? null : null;

      const browseItem: BrowseItem = {
        id: `knuspr:${group.groupKey}`,
        name: group.name,
        groupLabel: group.groupLabel,
        image: group.image,
        statsByProvider: { knuspr: stat },
        offers: [{
          provider: 'knuspr',
          available: knusprReach.available,
          reason: knusprReach.reason,
          price: stat.avgPrice,
          productId: group.productId,
        }],
        /* `due` and `stockDays` stay Knuspr-only: an EDEKA cadence describes a
           different shop run and must never make a delivery look due. */
        due: Boolean(rate?.due) && knusprReach.available,
        stockDays: rate ? Math.round(rate.stockDays * 10) / 10 : null,
        outsideWindow: rate === undefined,
      };

      if (link && linkedBucket) {
        mergedTextKeys.add(linkedBucket.textKey);
        browseItem.statsByProvider.edeka = edekaStat(linkedBucket);
        browseItem.offers.push({
          provider: 'edeka',
          available: edekaReach.available,
          reason: edekaReach.reason,
          price: linkedBucket.lastPrice ?? linkedBucket.avgPrice,
          textKey: linkedBucket.textKey,
        });
        browseItem.linked = { confidence: link.confidence, source: link.source };
      }

      items.push(browseItem);
    }

    for (const stat of edekaStats.values()) {
      if (mergedTextKeys.has(stat.textKey)) continue;
      items.push({
        id: `edeka:${stat.textKey}`,
        name: stat.brand ? `${stat.brand} ${stat.name}` : stat.name,
        groupLabel: null,
        image: null,
        statsByProvider: { edeka: stat },
        offers: [{
          provider: 'edeka',
          available: edekaReach.available,
          reason: edekaReach.reason,
          price: stat.lastPrice ?? stat.avgPrice,
          textKey: stat.textKey,
        }],
        due: edekaDue(stat, now) && edekaReach.available,
        stockDays: null,
        outsideWindow: false,
      });
    }

    const source = parseSource(req.query.source);
    const dueOnly = isDueOnly(req.query.due);
    const filtered = items
      .filter((item) => source === 'both'
        || (source === 'knuspr' ? item.statsByProvider.knuspr : item.statsByProvider.edeka))
      .filter((item) => !dueOnly || item.due)
      .sort((a, b) => {
        if (a.due !== b.due) return a.due ? -1 : 1;
        const aStock = a.stockDays ?? Number.POSITIVE_INFINITY;
        const bStock = b.stockDays ?? Number.POSITIVE_INFINITY;
        if (aStock !== bStock) return aStock - bStock;
        return a.name.localeCompare(b.name, 'de');
      });

    res.json({
      now: now.toISOString(),
      horizonDays,
      /** Length of the rate window; rows outside it carry no cadence. */
      windowDays,
      location: { context, destination },
      counts: {
        total: items.length,
        due: items.filter((item) => item.due).length,
        empty: items.filter((item) => item.stockDays !== null && item.stockDays <= 0).length,
      },
      items: filtered,
    });
  } catch (error) {
    console.error('product list failed:', error);
    res.status(500).json({ error: 'failed to read products' });
  }
}

const productLinkBodySchema = z.object({
  knusprProductId: z.number().int().positive(),
  /** `null` removes the correction, so the row falls back to the name matcher. */
  edekaTextKey: z.string().trim().min(1).max(200).nullable(),
});

/**
 * PUT /api/product-links — record or clear a manual cross-store correction.
 *
 * This is the "matched by name · change" action. It only ever writes the display
 * link: no rate, stock or "due" flag reads `ProductLink`, and the learning code
 * is lint-forbidden from importing it.
 */
export async function handleUpdateProductLink(req: Request, res: Response) {
  const parsed = productLinkBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });

  const { knusprProductId, edekaTextKey } = parsed.data;

  try {
    if (edekaTextKey === null) {
      await ProductLink.deleteOne({ userId: req.userId, knusprProductId });
      return res.json({ knusprProductId, link: null });
    }

    await ProductLink.findOneAndUpdate(
      { userId: req.userId, knusprProductId },
      { $set: { edekaTextKey, confidence: 1, source: 'manual' } },
      { upsert: true }
    );

    return res.json({
      knusprProductId,
      link: { edekaTextKey, confidence: 1, source: 'manual' as const },
    });
  } catch (error) {
    console.error('product link write failed:', error);
    return res.status(500).json({ error: 'failed to save the product link' });
  }
}

interface SearchHistoryEntry {
  id: string;
  name: string;
  provider: 'knuspr' | 'edeka';
  lastBought: string | null;
  purchases: number;
  price: number | null;
}

/** GET /api/search — your own history first, then the EDEKA catalogue. */
export async function handleSearch(req: Request, res: Response) {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 2) {
    return res.status(400).json({ error: 'q: search needs at least 2 characters' });
  }
  const needle = query.toLowerCase();

  try {
    const [location, sessions, lifetime] = await Promise.all([
      getLocationSettings(req.userId),
      PurchaseSession.find({ userId: req.userId }).sort({ purchasedAt: 1 }).lean(),
      loadKnusprLifetime(req.userId),
    ]);

    const context = resolveLocation(new Date(), location);
    const knusprReach = availability('knuspr', context);
    const edekaReach = availability('edeka', context);

    // History is free and instant, so it never waits on a remote call.
    const history: SearchHistoryEntry[] = [];
    // History means "did I ever buy this", so it is not limited to the rate
    // window — a product from eight months ago is still part of your history.
    for (const group of lifetime) {
      if (!`${group.name} ${group.groupLabel}`.toLowerCase().includes(needle)) continue;
      history.push({
        id: `knuspr:${group.groupKey}`,
        name: group.name,
        provider: 'knuspr',
        lastBought: group.lastBought.toISOString(),
        purchases: group.purchases,
        price: group.avgPrice,
      });
    }

    const edekaStats = aggregateEdeka(
      sessions.map((session) => ({
        purchasedAt: session.purchasedAt,
        store: session.store,
        total: session.total,
        items: ((session.items ?? []) as SessionItem[]).map((item) => ({
          brand: item.brand ?? null,
          name: item.name,
          quantity: item.quantity ?? 1,
          unitPrice: item.unitPrice ?? null,
          lineTotal: item.lineTotal ?? null,
          isCredit: item.isCredit ?? false,
        })),
      }))
    );

    for (const stat of edekaStats.values()) {
      const label = stat.brand ? `${stat.brand} ${stat.name}` : stat.name;
      if (!label.toLowerCase().includes(needle)) continue;
      history.push({
        id: `edeka:${stat.textKey}`,
        name: label,
        provider: 'edeka',
        lastBought: stat.lastBought ? new Date(stat.lastBought).toISOString() : null,
        purchases: stat.purchases,
        price: stat.lastPrice ?? stat.avgPrice,
      });
    }

    history.sort((a, b) => (b.lastBought ?? '').localeCompare(a.lastBought ?? ''));

    const edeka = await searchEdekaCatalogue(req, query, edekaReach.available, edekaReach.reason);

    res.json({
      query,
      history: history.slice(0, 8),
      edeka,
      // Knuspr has no catalogue search endpoint wired yet; saying so is better
      // than a section that is always empty.
      knuspr: {
        state: 'later' as const,
        available: knusprReach.available,
        reason: 'Knuspr catalogue search is not connected yet',
      },
    });
  } catch (error) {
    console.error('search failed:', error);
    res.status(500).json({ error: 'failed to search' });
  }
}

async function searchEdekaCatalogue(
  req: Request,
  query: string,
  available: boolean,
  unavailableReason: string
) {
  if (!available) {
    return { state: 'unavailable' as const, reason: unavailableReason, items: [], truncated: false };
  }
  if (!req.derivedKey) {
    return {
      state: 'unavailable' as const,
      reason: 'EDEKA is not connected — connect it in Settings',
      items: [],
      truncated: false,
    };
  }

  // Searching must not create an account as a side effect: `ensureSession`
  // signs one up when none exists, which is right for writing a list and wrong
  // for typing a query.
  const integration = await Integration.findOne({
    userId: req.userId,
    provider: IntegrationProvider.EASySHOPPER,
  }).lean();
  if (!integration?.encryptedCredentials) {
    return {
      state: 'unavailable' as const,
      reason: 'EDEKA is not connected — connect it in Settings',
      items: [],
      truncated: false,
    };
  }

  try {
    const { client, session, storeGuid } = await ensureSession(req.userId, req.derivedKey);
    const response = await client.searchProducts(session.token, {
      queryText: query,
      storeGuid,
      // The app caps this server-side at 25; ask for exactly that so `truncated`
      // means "there are more" rather than "we stopped early".
      limit: 25,
    });
    const items = response.items
      .map((raw) => toCandidate(raw as Record<string, unknown>))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .slice(0, 25)
      .map((candidate) => ({
        name: candidate.name,
        brand: candidate.brand ?? null,
        price: candidate.price ?? null,
        id: candidate.id ?? null,
      }));

    return {
      state: 'ok' as const,
      items,
      truncated: response.count > items.length,
      reason: items.length === 0 ? 'Nothing in the catalogue for that' : '',
    };
  } catch (error) {
    console.error('EDEKA catalogue search failed:', error);
    return {
      state: 'error' as const,
      reason: 'The EDEKA catalogue did not answer — try again',
      items: [],
      truncated: false,
    };
  }
}
