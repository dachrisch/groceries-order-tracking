import { describe, it, expect } from 'vitest';
import { horizonDaysUntil, resolveDatePhrase } from '../bot/dates';

// Monday 2 November 2026, mid-morning.
const NOW = new Date(2026, 10, 2, 10, 30);
const day = (d: Date | undefined) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;

describe('resolveDatePhrase', () => {
  it.each([
    ['wednesday', '2026-11-04'],
    ['at wednesday', '2026-11-04'],
    ['on Wed', '2026-11-04'],
    ['Mittwoch', '2026-11-04'],
    ['am Mi', '2026-11-04'],
    ['bis Fr', '2026-11-06'],
    ['monday', '2026-11-02'],
    ['sunday', '2026-11-08'],
    ['today', '2026-11-02'],
    ['heute', '2026-11-02'],
    ['tomorrow', '2026-11-03'],
    ['morgen', '2026-11-03'],
    ['day after tomorrow', '2026-11-04'],
    ['übermorgen', '2026-11-04'],
    ['end of the week', '2026-11-08'],
    ['till end of week', '2026-11-08'],
    ['the weekend', '2026-11-08'],
    ['bis Ende der Woche', '2026-11-08'],
    ['Wochenende', '2026-11-08'],
    ['this week', '2026-11-08'],
    ['next week', '2026-11-15'],
    ['nächste Woche', '2026-11-15'],
    ['2026-11-12', '2026-11-12'],
    ['12.11.', '2026-11-12'],
    ['12.11.2026', '2026-11-12'],
  ])('%s → %s', (phrase, expected) => {
    expect(day(resolveDatePhrase(phrase, NOW))).toBe(expected);
  });

  it('returns undefined for phrases it does not understand', () => {
    expect(resolveDatePhrase('soon-ish', NOW)).toBeUndefined();
    expect(resolveDatePhrase('so I need food', NOW)).toBeUndefined();
    expect(resolveDatePhrase('what do you have', NOW)).toBeUndefined();
    expect(resolveDatePhrase('', NOW)).toBeUndefined();
    expect(resolveDatePhrase(undefined, NOW)).toBeUndefined();
  });

  it('rolls a past dd.mm date into next year', () => {
    expect(day(resolveDatePhrase('01.02.', NOW))).toBe('2027-02-01');
  });
});

describe('horizonDaysUntil', () => {
  it('counts today through the target day inclusive', () => {
    expect(horizonDaysUntil(new Date(2026, 10, 8), NOW)).toBe(7);
    expect(horizonDaysUntil(new Date(2026, 10, 4), NOW)).toBe(3);
  });

  it('is at least one day', () => {
    expect(horizonDaysUntil(new Date(2026, 10, 1), NOW)).toBe(1);
    expect(horizonDaysUntil(new Date(2026, 10, 2), NOW)).toBe(1);
  });
});
