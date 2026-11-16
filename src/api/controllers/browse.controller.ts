import { Request, Response } from 'express';
import BotSettings, { BOT_SETTINGS_DEFAULTS } from '../../models/BotSettings';
import Integration, { IntegrationProvider } from '../../models/Integration';
import PurchaseSession from '../../models/PurchaseSession';
import { getWeeklyConsumption } from '../../lib/bot/consumption';
import { getLocationSettings } from '../../lib/bot/location-settings';
import { aggregateEdeka, edekaDue, knusprStat } from '../../lib/product-stats';
import { availability, derivedDestination, resolveLocation, type ProductStat } from '../../lib/providers';
import { toCandidate } from '../../lib/easyshopper/match';
import { ensureSession } from './easyshopper.controller';
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

/** GET /api/products — the merged list, one stat row per provider. */
export async function handleGetProducts(req: Request, res: Response) {
  try {
    const now = new Date();
    const [location, settingsDoc, sessions] = await Promise.all([
      getLocationSettings(req.userId),
      BotSettings.findOne({ userId: req.userId }).lean(),
      PurchaseSession.find({ userId: req.userId }).sort({ purchasedAt: 1 }).lean(),
    ]);

    const horizonDays = settingsDoc?.horizonDays ?? BOT_SETTINGS_DEFAULTS.horizonDays;
    const deliveryLeadDays = settingsDoc?.deliveryLeadDays ?? BOT_SETTINGS_DEFAULTS.deliveryLeadDays;

    const context = resolveLocation(now, location);
    const knusprReach = availability('knuspr', context);
    const edekaReach = availability('edeka', context);
    const destination = derivedDestination(context);

    const consumption = await getWeeklyConsumption(req.userId, { now, horizonDays, deliveryLeadDays });
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

    for (const item of consumption.items) {
      const stat = knusprStat(item);
      items.push({
        id: `knuspr:${item.groupKey}`,
        name: item.name,
        groupLabel: item.groupLabel,
        image: item.image ?? null,
        statsByProvider: { knuspr: stat },
        offers: [{
          provider: 'knuspr',
          available: knusprReach.available,
          reason: knusprReach.reason,
          price: stat.avgPrice,
          productId: item.productId,
        }],
        due: item.due && knusprReach.available,
        stockDays: Math.round(item.stockDays * 10) / 10,
      });
    }

    for (const stat of edekaStats.values()) {
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
    const [location, sessions, consumption] = await Promise.all([
      getLocationSettings(req.userId),
      PurchaseSession.find({ userId: req.userId }).sort({ purchasedAt: 1 }).lean(),
      getWeeklyConsumption(req.userId),
    ]);

    const context = resolveLocation(new Date(), location);
    const knusprReach = availability('knuspr', context);
    const edekaReach = availability('edeka', context);

    // History is free and instant, so it never waits on a remote call.
    const history: SearchHistoryEntry[] = [];
    for (const item of consumption.items) {
      if (!`${item.name} ${item.groupLabel}`.toLowerCase().includes(needle)) continue;
      history.push({
        id: `knuspr:${item.groupKey}`,
        name: item.name,
        provider: 'knuspr',
        lastBought: item.lastPurchase ? item.lastPurchase.toISOString() : null,
        purchases: item.purchaseCount,
        price: Number.isFinite(item.avgPrice) ? Number(item.avgPrice.toFixed(2)) : null,
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
