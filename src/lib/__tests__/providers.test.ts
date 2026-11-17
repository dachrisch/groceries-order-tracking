import { describe, it, expect } from 'vitest';
import {
  availability,
  derivedDestination,
  destinationReason,
  isKnusprCity,
  normalizeCity,
  resolveLocation,
  type LocationSettings,
} from '../providers';

const HOME: LocationSettings = { homeCity: 'Munich', homeCountry: 'DE', awayWindows: [] };
const NOW = new Date('2026-11-16T09:00:00.000Z');

function withAway(settings: Partial<LocationSettings>): LocationSettings {
  return { ...HOME, ...settings };
}

describe('normalizeCity', () => {
  it('folds umlauts and punctuation into one key', () => {
    expect(normalizeCity('München')).toBe('muenchen');
    expect(normalizeCity('Munich')).toBe('munich');
    expect(normalizeCity('  Köln ')).toBe('koeln');
  });
});

describe('resolveLocation', () => {
  it('is home when no window covers today', () => {
    const context = resolveLocation(NOW, HOME);
    expect(context).toMatchObject({ source: 'home', city: 'Munich', country: 'DE' });
  });

  it('is away while a window covers today, without needing the window to be declared', () => {
    const context = resolveLocation(NOW, withAway({
      awayWindows: [
        { from: new Date('2026-11-20'), to: new Date('2026-11-27'), city: 'Berlin' },
        { from: new Date('2026-11-10'), to: new Date('2026-11-18'), city: 'Berlin' },
      ],
    }));
    expect(context.source).toBe('away');
    expect(context.city).toBe('Berlin');
    expect(context.awayWindow?.city).toBe('Berlin');
  });

  it('counts the last day of a window as away', () => {
    const context = resolveLocation(new Date('2026-11-27T23:30:00.000Z'), withAway({
      awayWindows: [{ from: new Date('2026-11-20'), to: new Date('2026-11-27'), city: 'Berlin' }],
    }));
    expect(context.source).toBe('away');
  });

  it('is unknown when no home city was ever set', () => {
    expect(resolveLocation(NOW, { homeCity: null, homeCountry: 'DE', awayWindows: [] }).source).toBe('unknown');
  });
});

describe('availability', () => {
  it('offers Knuspr inside Munich', () => {
    expect(availability('knuspr', resolveLocation(NOW, HOME))).toEqual({
      provider: 'knuspr',
      available: true,
      reason: 'Delivers here',
    });
    expect(isKnusprCity('München')).toBe(true);
  });

  it('refuses Knuspr away from Munich but keeps EDEKA', () => {
    const context = resolveLocation(NOW, withAway({ homeCity: 'Berlin' }));
    expect(availability('knuspr', context).available).toBe(false);
    expect(availability('knuspr', context).reason).toContain('Munich only');
    expect(availability('edeka', context).available).toBe(true);
  });

  it('refuses both abroad', () => {
    const context = { source: 'away' as const, city: 'Rome', country: 'IT' };
    expect(availability('knuspr', context).available).toBe(false);
    expect(availability('edeka', context).available).toBe(false);
    expect(availability('edeka', context).reason).toContain('Germany only');
  });

  it('never hides a source because the location is unknown', () => {
    const context = resolveLocation(NOW, { homeCity: null, homeCountry: 'DE', awayWindows: [] });
    for (const provider of ['knuspr', 'edeka'] as const) {
      const reach = availability(provider, context);
      expect(reach.available).toBe(true);
      expect(reach.reason).toMatch(/not set/i);
    }
  });
});

describe('derivedDestination', () => {
  it('prefers the cart in Munich', () => {
    expect(derivedDestination(resolveLocation(NOW, HOME))).toBe('knuspr-cart');
  });

  it('writes a list elsewhere in Germany', () => {
    expect(derivedDestination(resolveLocation(NOW, withAway({ homeCity: 'Berlin' })))).toBe('edeka-list');
  });

  it('falls back to a checklist abroad so nothing is lost', () => {
    expect(derivedDestination({ source: 'away', city: 'Rome', country: 'IT' })).toBe('checklist');
    expect(destinationReason({ source: 'away', city: 'Rome', country: 'IT' })).toContain('checklist');
  });

  it('always explains itself', () => {
    for (const context of [
      resolveLocation(NOW, HOME),
      resolveLocation(NOW, withAway({ homeCity: 'Berlin' })),
      { source: 'away' as const, city: 'Rome', country: 'IT' },
    ]) {
      expect(destinationReason(context).length).toBeGreaterThan(10);
    }
  });
});
