/**
 * Reads and writes the location half of `BotSettings`.
 *
 * Separate from `getBotSettings` in `fill.ts` on purpose: that loader builds the
 * guardrails contract for `/api/bot/settings`, and pulling it in here would drag
 * the whole Knuspr cart pipeline into a read that only needs a city name.
 */
import BotSettings from '../../models/BotSettings';
import type { AwayWindow, LocationSettings } from '../providers';

export interface StoredAwayWindow {
  from?: Date | null;
  to?: Date | null;
  city?: string | null;
}

function cleanWindows(windows: StoredAwayWindow[] | undefined): AwayWindow[] {
  return (windows ?? [])
    .filter((window) => window.from && window.to && window.city)
    .map((window) => ({
      from: new Date(window.from as Date),
      to: new Date(window.to as Date),
      city: String(window.city).trim(),
    }))
    // A window that ends before it starts would silently never apply.
    .filter((window) => window.from.getTime() <= window.to.getTime())
    .sort((a, b) => a.from.getTime() - b.from.getTime());
}

export async function getLocationSettings(userId: string): Promise<LocationSettings> {
  const doc = await BotSettings.findOne({ userId }).lean();
  return {
    homeCity: doc?.homeCity?.trim() ? doc.homeCity.trim() : null,
    homeCountry: (doc?.homeCountry ?? 'DE').toUpperCase(),
    awayWindows: cleanWindows(doc?.awayWindows as StoredAwayWindow[] | undefined),
  };
}

export interface LocationSettingsInput {
  homeCity?: string | null;
  homeCountry?: string | null;
  awayWindows?: Array<{ from: Date; to: Date; city: string }>;
}

/** Upsert, so a user who never opened the bot settings still gets a row. */
export async function setLocationSettings(
  userId: string,
  input: LocationSettingsInput
): Promise<LocationSettings> {
  const update: Record<string, unknown> = {};
  if (input.homeCity !== undefined) {
    update.homeCity = input.homeCity?.trim() || null;
  }
  if (input.homeCountry !== undefined) {
    update.homeCountry = (input.homeCountry ?? 'DE').toUpperCase();
  }
  if (input.awayWindows !== undefined) {
    update.awayWindows = input.awayWindows.map((window) => ({
      from: window.from,
      to: window.to,
      city: window.city.trim(),
    }));
  }

  await BotSettings.findOneAndUpdate(
    { userId },
    { $set: update },
    { upsert: true, returnDocument: 'after' }
  );
  return getLocationSettings(userId);
}
