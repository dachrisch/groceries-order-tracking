import { Request, Response } from 'express';
import Occasion from '../../models/Occasion';
import { findPurchase, listPurchases, parsePurchaseEventId, toSummary, type PurchaseEvent } from '../../lib/purchases';
import type { Provider } from '../../lib/providers';

/**
 * One timeline: Knuspr deliveries and EDEKA shop runs, newest first.
 *
 * The two collections stay separate (an in-store run is not an order), so this
 * module does the only merging that is safe: at read time, in memory, with the
 * provider attached to every row.
 */

interface OccasionRef {
  id: string;
  name: string;
  servings: number;
}

/** Pull the occasion names for the given events in one query. */
async function resolveOccasions(userId: string, events: PurchaseEvent[]): Promise<Map<string, OccasionRef>> {
  const ids = [...new Set(events.flatMap((event) => event.occasionIds))];
  if (ids.length === 0) return new Map();

  const occasions = await Occasion.find({ _id: { $in: ids }, userId }).select('name basisServings').lean();
  const map = new Map<string, OccasionRef>();
  for (const occasion of occasions) {
    map.set(String(occasion._id), {
      id: String(occasion._id),
      name: occasion.name,
      servings: occasion.basisServings ?? 1,
    });
  }
  return map;
}

function parseProvider(value: unknown): Provider | undefined {
  return value === 'knuspr' || value === 'edeka' ? value : undefined;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** GET /api/activity — deliveries and in-store runs as one stream. */
export async function handleGetActivity(req: Request, res: Response) {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  const provider = parseProvider(req.query.provider);
  const limit = Math.min(Number(req.query.limit) || 100, 300);

  try {
    const events = await listPurchases(req.userId, { from, to, provider, limit });
    const occasions = await resolveOccasions(req.userId, events);

    const totals = { knuspr: 0, edeka: 0 };
    for (const event of events) totals[event.provider] += event.total;

    res.json({
      events: events.map((event) => ({
        ...toSummary(event),
        occasions: event.occasionIds
          .map((id) => occasions.get(id))
          .filter((occasion): occasion is OccasionRef => occasion !== undefined),
      })),
      // Totals cover the events returned, so they always agree with the list
      // above them. Ask for a date range to get a month figure.
      totals: {
        knuspr: Number(totals.knuspr.toFixed(2)),
        edeka: Number(totals.edeka.toFixed(2)),
        all: Number((totals.knuspr + totals.edeka).toFixed(2)),
        count: events.length,
      },
    });
  } catch (error) {
    console.error('activity read failed:', error);
    res.status(500).json({ error: 'failed to read activity' });
  }
}

/** GET /api/activity/:id — one order or receipt with its lines. */
export async function handleGetActivityEntry(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!parsePurchaseEventId(id)) {
    return res.status(400).json({ error: 'id: expected knuspr:<orderId> or edeka:<sessionId>' });
  }

  try {
    const event = await findPurchase(req.userId, id);
    if (!event) return res.status(404).json({ error: 'that entry is not here any more' });

    const occasions = await resolveOccasions(req.userId, [event]);
    res.json({
      ...event,
      occasions: event.occasionIds
        .map((occasionId) => occasions.get(occasionId))
        .filter((occasion): occasion is OccasionRef => occasion !== undefined),
    });
  } catch (error) {
    console.error('activity detail failed:', error);
    res.status(500).json({ error: 'failed to read that entry' });
  }
}
