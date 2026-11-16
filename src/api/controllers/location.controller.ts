import { Request, Response } from 'express';
import { z } from 'zod';
import Integration, { IntegrationProvider } from '../../models/Integration';
import { getLocationSettings, setLocationSettings } from '../../lib/bot/location-settings';
import {
  availabilityFor,
  derivedDestination,
  destinationReason,
  resolveLocation,
  type LocationSettings,
} from '../../lib/providers';
import { formatZodError } from '../utils';
import '../utils';

/**
 * Where the shopper is and what that makes orderable.
 *
 * The response carries the *reason* next to every decision, because a source that
 * silently disappears when you travel reads as a bug. Nothing here books a
 * delivery or writes to a list: availability is a filter and a default, no more.
 */

const awayWindowSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  city: z.string().min(1).max(80),
});

const locationBodySchema = z.object({
  homeCity: z.string().max(80).nullable().optional(),
  homeCountry: z.string().length(2).nullable().optional(),
  awayWindows: z.array(awayWindowSchema).max(24).optional(),
});

interface ProviderStatus {
  provider: 'knuspr' | 'edeka';
  /** Whether the account is connected at all, which is a different question from reach. */
  connected: boolean;
  lastSyncAt: string | null;
  available: boolean;
  reason: string;
}

async function providerStatuses(userId: string, settings: LocationSettings) {
  const now = new Date();
  const context = resolveLocation(now, settings);
  const integrations = await Integration.find({ userId }).lean();
  const lastSync = new Map<string, Date | null>();
  for (const integration of integrations) {
    if (!integration.encryptedCredentials) continue;
    lastSync.set(integration.provider, integration.lastSyncAt ?? null);
  }

  const statuses: ProviderStatus[] = availabilityFor(context).map((entry) => {
    const providerKey = entry.provider === 'knuspr' ? IntegrationProvider.KNUSPR : IntegrationProvider.EASySHOPPER;
    const syncedAt = lastSync.get(providerKey) ?? null;
    return {
      provider: entry.provider,
      connected: lastSync.has(providerKey),
      lastSyncAt: syncedAt ? syncedAt.toISOString() : null,
      available: entry.available,
      reason: entry.reason,
    };
  });

  return { now, context, statuses };
}

/** GET /api/location — context, per-provider reach and the derived destination. */
export async function handleGetLocation(req: Request, res: Response) {
  try {
    const settings = await getLocationSettings(req.userId);
    const { now, context, statuses } = await providerStatuses(req.userId, settings);
    const destination = derivedDestination(context);
    res.json({
      now: now.toISOString(),
      settings,
      context,
      providers: statuses,
      destination,
      reason: destinationReason(context),
    });
  } catch (error) {
    console.error('location read failed:', error);
    res.status(500).json({ error: 'failed to read location' });
  }
}

/**
 * PUT /api/location — set the home city, country and away windows.
 *
 * Away windows are also derived from the date, so this is a correction surface,
 * not a prerequisite: the app works with an empty list.
 */
export async function handleUpdateLocation(req: Request, res: Response) {
  const parsed = locationBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: formatZodError(parsed.error) });

  const windows = parsed.data.awayWindows;
  if (windows) {
    const bad = windows.find((window) => window.from.getTime() > window.to.getTime());
    if (bad) return res.status(400).json({ error: 'awayWindows: from must not be after to' });
  }

  try {
    const settings = await setLocationSettings(req.userId, {
      homeCity: parsed.data.homeCity,
      homeCountry: parsed.data.homeCountry,
      awayWindows: windows,
    });
    const { now, context, statuses } = await providerStatuses(req.userId, settings);
    const destination = derivedDestination(context);
    res.json({
      now: now.toISOString(),
      settings,
      context,
      providers: statuses,
      destination,
      reason: destinationReason(context),
    });
  } catch (error) {
    console.error('location write failed:', error);
    res.status(500).json({ error: 'failed to save location' });
  }
}
