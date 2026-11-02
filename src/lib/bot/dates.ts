/**
 * Deterministic date phrases for the chat ("wednesday", "end of the week",
 * "Mittwoch", "12.11."). The LLM returns the user's own words; this module
 * turns them into dates, so dates are testable and never hallucinated.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// getDay() numbering: 0 = Sunday.
const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(?:sunday|sun|sonntag)\b/, 0],
  [/\b(?:monday|mon|montag)\b/, 1],
  [/\b(?:tuesday|tue|tues|dienstag)\b/, 2],
  [/\b(?:wednesday|wed|mittwoch)\b/, 3],
  [/\b(?:thursday|thu|thur|thurs|donnerstag)\b/, 4],
  [/\b(?:friday|fri|freitag)\b/, 5],
  [/\b(?:saturday|sat|samstag|sonnabend)\b/, 6],
];

// German two-letter abbreviations ("Mi", "Do") are also English words ("do",
// "so"), so they only count when they are the whole phrase ("am Do").
const SHORT_WEEKDAYS: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** The given weekday on or after `from`. */
function nextWeekday(from: Date, weekday: number): Date {
  return addDays(from, (weekday - from.getDay() + 7) % 7);
}

function normalize(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a date phrase relative to `now`. Unknown phrases → undefined. */
export function resolveDatePhrase(phrase: string | undefined | null, now: Date = new Date()): Date | undefined {
  if (!phrase) return undefined;
  const text = normalize(phrase);
  if (!text) return undefined;
  const today = startOfDay(now);

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const dotted = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (dotted) {
    const year = dotted[3] ? Number(dotted[3]) : today.getFullYear();
    let date = new Date(year, Number(dotted[2]) - 1, Number(dotted[1]));
    if (!dotted[3] && date < today) date = new Date(year + 1, Number(dotted[2]) - 1, Number(dotted[1]));
    return date;
  }

  if (/\b(?:day after tomorrow|uebermorgen)\b/.test(text)) return addDays(today, 2);
  if (/\b(?:tomorrow|morgen)\b/.test(text)) return addDays(today, 1);
  if (/\b(?:today|tonight|heute)\b/.test(text)) return today;

  if (/\b(?:next week|naechste[nr]? woche|kommende[nr]? woche)\b/.test(text)) {
    return addDays(nextWeekday(today, 0), 7);
  }
  if (/\b(?:end of (?:the )?week|weekend|wochenende|ende der woche|this week|diese[rn]? woche)\b/.test(text)) {
    return nextWeekday(today, 0);
  }

  for (const [pattern, weekday] of WEEKDAYS) {
    if (pattern.test(text)) return nextWeekday(today, weekday);
  }

  const bare = text.replace(/^(?:am|an|on|at|bis|until|till|by|for|fuer)\s+/, '').replace(/\.$/, '');
  if (bare in SHORT_WEEKDAYS) return nextWeekday(today, SHORT_WEEKDAYS[bare]);

  return undefined;
}

/** Days from today through `target`, inclusive; at least 1. */
export function horizonDaysUntil(target: Date, now: Date = new Date()): number {
  const days = Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / DAY_MS) + 1;
  return Math.max(1, days);
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Short label for replies: "Wed" within the next week, else "12.11.". */
export function formatShortDate(date: Date, now: Date = new Date()): string {
  const days = horizonDaysUntil(date, now) - 1;
  if (days >= 0 && days < 7) return WEEKDAY_NAMES[date.getDay()];
  return `${date.getDate()}.${date.getMonth() + 1}.`;
}
