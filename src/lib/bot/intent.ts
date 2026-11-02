import { isOpencodeConfigured, runPrompt } from '../opencode-client';
import { resolveDatePhrase } from './dates';

/**
 * Chat message → plan of actions. One message can hold several requests
 * ("pizza for 6 on Wednesday and food till the end of the week").
 *
 * Common phrasings are parsed by regex (instant, no LLM). Everything else goes
 * to opencode, which returns actions with dates as the user's own words; the
 * dates are resolved here, never by the model.
 */

export type BotAction =
  | { type: 'weekly'; until?: Date }
  | { type: 'occasion'; occasion: string; servings: number; date?: Date }
  | { type: 'correction'; action: 'remove'; item: string; occasion?: string }
  | { type: 'confirm' }
  | { type: 'unknown'; text: string };

export interface BotPlan {
  actions: BotAction[];
}

export interface ParsePlanOptions {
  /** Pass false to skip the LLM even when opencode is configured. */
  useLLM?: boolean;
  knownOccasions?: string[];
  now?: Date;
}

const CONFIRM_PATTERN = /^(?:yes|yep|yeah|ok|okay|sure|confirm|go ahead|do it|ja|los|sicher|add it|add)[.!]?$/i;
const REMOVE_NEXT_TIME_PATTERN = /^(?:no|ohne|remove|drop|skip)\s+(.+?)\s+next\s+time[.!]?$/i;
const REMOVE_FROM_PATTERN = /^(?:remove|drop|skip|no)\s+(.+?)\s+(?:from|in|bei)\s+(.+?)[.!]?$/i;

const WEEKLY_PATTERN =
  /(?:fill|refill|restock|stock up|order).*(?:week|inventory|weekly|basics|usual)|(?:this|next)\s+week|^weekly$|^fill$|^restock\b/i;
/** Words that mean "my regular groceries" when combined with a time limit. */
const WEEKLY_WORDS =
  /\b(?:food|groceries|grocery|stuff|basics|usual|inventory|essen|lebensmittel|einkauf|vorrat|vorraete|sachen)\b/i;
const UNTIL_PATTERN = /\b(?:till|until|til|bis|through|thru|by)\s+(.+)$/i;
const END_OF_WEEK_PATTERN = /\b(?:end of (?:the )?week|weekend|wochenende|ende der woche)\b/i;

const OCCASION_PATTERN =
  /^(.*?)\s+(?:for|für|fuer)\s+(\d{1,3})\b(?:\s+(?:people|persons|person|personen|leute|gäste|gaeste|guests|pax))?(.*)$/i;
const OCCASION_LEADING_FILLER =
  /^(?:(?:i|we|ich|wir)\s+(?:have|has|had|want|wants|need|needs|plan|make|do|host|habe|haben|brauche|brauchen|mache|machen)\s+)?(?:(?:a|an|the|my|our|some|ein|eine|einen)\s+)?(?:(?:order|get|buy|make|plan|cook)\s+)?/i;
const OCCASION_TRAILING_FILLER =
  /\s+(?:event|party|night|evening|dinner|abend|feier|essen|treffen)$/i;
const SPLIT_PATTERN = /\s*(?:[,;&]|\band\b|\bund\b|\bplus\b|\balso\b)\s*/i;

function cleanOccasionName(raw: string): string | null {
  let name = raw.trim().replace(OCCASION_LEADING_FILLER, '').trim();
  name = name.replace(OCCASION_TRAILING_FILLER, '').trim();
  if (!name || name.split(/\s+/).length > 3) return null;
  return name.toLowerCase();
}

function parseOccasionSegment(segment: string, now: Date): BotAction | null {
  const match = segment.match(OCCASION_PATTERN);
  if (!match) return null;
  const servings = Number(match[2]);
  if (!Number.isFinite(servings) || servings <= 0 || servings > 100) return null;
  const occasion = cleanOccasionName(match[1]);
  if (!occasion) return null;

  const rest = match[3].trim().replace(/[.!]+$/, '');
  if (!rest) return { type: 'occasion', occasion, servings };
  const date = resolveDatePhrase(rest, now);
  // An unexplained tail ("for 6 with my in-laws who are vegan") is for the LLM.
  if (!date) return null;
  return { type: 'occasion', occasion, servings, date };
}

function parseWeeklySegment(segment: string, now: Date): BotAction | null {
  const isWeekly = WEEKLY_PATTERN.test(segment) || WEEKLY_WORDS.test(segment) || END_OF_WEEK_PATTERN.test(segment);
  if (!isWeekly) return null;

  const until = segment.match(UNTIL_PATTERN);
  if (until) {
    const date = resolveDatePhrase(until[1], now);
    return date ? { type: 'weekly', until: date } : null;
  }
  if (END_OF_WEEK_PATTERN.test(segment)) {
    const date = resolveDatePhrase(segment, now);
    return date ? { type: 'weekly', until: date } : null;
  }
  // "food for the week" / "fill my inventory for this week": default horizon.
  return WEEKLY_PATTERN.test(segment) || /\bweek\b|\bwoche\b/i.test(segment) ? { type: 'weekly' } : null;
}

/** Merge duplicate weekly actions (keep the latest `until`). */
function dedupe(actions: BotAction[]): BotAction[] {
  const result: BotAction[] = [];
  let weekly: Extract<BotAction, { type: 'weekly' }> | null = null;
  for (const action of actions) {
    if (action.type !== 'weekly') {
      result.push(action);
      continue;
    }
    if (!weekly) {
      weekly = { type: 'weekly' };
      result.push(weekly);
    }
    if (action.until && (!weekly.until || action.until > weekly.until)) weekly.until = action.until;
  }
  return result;
}

/** Fast, deterministic parser. Returns null when any part is unclear. */
export function parsePlanFast(text: string, now: Date = new Date()): BotPlan | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (CONFIRM_PATTERN.test(trimmed)) return { actions: [{ type: 'confirm' }] };

  const removeNextTime = trimmed.match(REMOVE_NEXT_TIME_PATTERN);
  if (removeNextTime) {
    return { actions: [{ type: 'correction', action: 'remove', item: removeNextTime[1].trim() }] };
  }
  const removeFrom = trimmed.match(REMOVE_FROM_PATTERN);
  if (removeFrom) {
    return {
      actions: [{ type: 'correction', action: 'remove', item: removeFrom[1].trim(), occasion: removeFrom[2].trim() }],
    };
  }

  const segments = trimmed.split(SPLIT_PATTERN).map((part) => part.trim()).filter(Boolean);
  const actions: BotAction[] = [];
  for (const segment of segments) {
    const action = parseOccasionSegment(segment, now) ?? parseWeeklySegment(segment, now);
    if (!action) return null;
    actions.push(action);
  }
  return actions.length > 0 ? { actions: dedupe(actions) } : null;
}

function buildPlanPrompt(text: string, knownOccasions: string[]): string {
  return [
    'Turn a grocery order-bot chat message into a list of actions. Respond with only JSON, no prose.',
    'Shape: {"actions":[ ...one or more of the following... ]}',
    '{"type":"weekly","until":string|null} — the usual/regular groceries. "until" is the end date in the user\'s own words ("end of the week", "friday") or null.',
    '{"type":"occasion","occasion":string,"servings":number,"date":string|null} — a dish or event for N people, e.g. pizza for 6. "occasion" is the dish in one or two lowercase words. "date" is when, in the user\'s own words, or null.',
    '{"type":"correction","item":string,"occasion":string|null} — the user does not want an item next time.',
    '{"type":"unknown"} — nothing above applies.',
    'Copy date words exactly as written; never compute calendar dates.',
    knownOccasions.length > 0 ? `Known occasions and recipes: ${knownOccasions.join(', ')}.` : '',
    `Message: ${JSON.stringify(text)}`,
  ].filter(Boolean).join('\n');
}

interface LlmAction {
  type?: unknown;
  occasion?: unknown;
  servings?: unknown;
  date?: unknown;
  until?: unknown;
  item?: unknown;
}

function normalizeAction(raw: LlmAction, now: Date): BotAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const phrase = (value: unknown) => (typeof value === 'string' ? resolveDatePhrase(value, now) : undefined);

  if (raw.type === 'weekly') {
    const until = phrase(raw.until);
    return until ? { type: 'weekly', until } : { type: 'weekly' };
  }
  if (raw.type === 'occasion') {
    const occasion = typeof raw.occasion === 'string' ? raw.occasion.trim().toLowerCase() : '';
    const servings = Number(raw.servings);
    if (!occasion || !Number.isFinite(servings) || servings <= 0 || servings > 100) return null;
    const date = phrase(raw.date);
    return date
      ? { type: 'occasion', occasion, servings: Math.round(servings), date }
      : { type: 'occasion', occasion, servings: Math.round(servings) };
  }
  if (raw.type === 'correction') {
    const item = typeof raw.item === 'string' ? raw.item.trim() : '';
    if (!item) return null;
    const occasion = typeof raw.occasion === 'string' && raw.occasion.trim() ? raw.occasion.trim() : undefined;
    return occasion
      ? { type: 'correction', action: 'remove', item, occasion }
      : { type: 'correction', action: 'remove', item };
  }
  return null;
}

/** Validate an LLM reply. Invalid actions are dropped, never guessed. */
export function normalizeLlmPlan(value: unknown, text: string, now: Date = new Date()): BotPlan {
  const unknown: BotPlan = { actions: [{ type: 'unknown', text }] };
  if (!value || typeof value !== 'object') return unknown;
  const body = value as { actions?: unknown };
  const rawActions: unknown[] = Array.isArray(body.actions) ? body.actions : [value];
  const actions = rawActions
    .map((raw) => normalizeAction(raw as LlmAction, now))
    .filter((action): action is BotAction => action !== null);
  return actions.length > 0 ? { actions: dedupe(actions) } : unknown;
}

/** Parse a chat message into a plan. Simple phrasings never touch the LLM. */
export async function parsePlan(text: string, options: ParsePlanOptions = {}): Promise<BotPlan> {
  const now = options.now ?? new Date();
  const fast = parsePlanFast(text, now);
  if (fast) return fast;

  const useLLM = options.useLLM ?? true;
  if (!useLLM || !isOpencodeConfigured()) return { actions: [{ type: 'unknown', text }] };
  return parsePlanWithLlm(text, { ...options, now });
}

/** LLM path only (no regex fast path). Exported for `npm run bot:eval`. */
export async function parsePlanWithLlm(text: string, options: ParsePlanOptions = {}): Promise<BotPlan> {
  const now = options.now ?? new Date();
  try {
    const response = await runPrompt<unknown>(buildPlanPrompt(text, options.knownOccasions ?? []), {
      timeoutMs: 45_000,
    });
    return normalizeLlmPlan(response, text, now);
  } catch (error) {
    console.error('opencode plan parsing failed:', error);
    return { actions: [{ type: 'unknown', text }] };
  }
}

/** Expected action shape in the eval fixture (dates as YYYY-MM-DD). */
export interface ExpectedAction {
  type: string;
  occasion?: string;
  servings?: number;
  date?: string;
  until?: string;
  item?: string;
}

function isoDay(date: Date | undefined): string | undefined {
  if (!date) return undefined;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Compare a plan with fixture expectations; used by the tests and `npm run bot:eval`. */
export function comparePlan(plan: BotPlan, expected: ExpectedAction[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (plan.actions.length !== expected.length) {
    problems.push(`expected ${expected.length} action(s), got ${plan.actions.length}: ${JSON.stringify(plan.actions)}`);
  }
  expected.forEach((want, index) => {
    const got = plan.actions[index] as Record<string, unknown> | undefined;
    if (!got) return;
    if (got.type !== want.type) {
      problems.push(`#${index}: type ${String(got.type)} ≠ ${want.type}`);
      return;
    }
    if (want.occasion !== undefined && !String(got.occasion ?? '').includes(want.occasion)) {
      problems.push(`#${index}: occasion ${String(got.occasion)} ≠ ${want.occasion}`);
    }
    if (want.servings !== undefined && got.servings !== want.servings) {
      problems.push(`#${index}: servings ${String(got.servings)} ≠ ${want.servings}`);
    }
    if (want.type === 'occasion' && isoDay(got.date as Date | undefined) !== want.date) {
      problems.push(`#${index}: date ${isoDay(got.date as Date | undefined)} ≠ ${want.date}`);
    }
    if (want.type === 'weekly' && isoDay(got.until as Date | undefined) !== want.until) {
      problems.push(`#${index}: until ${isoDay(got.until as Date | undefined)} ≠ ${want.until}`);
    }
    if (want.item !== undefined && got.item !== want.item) {
      problems.push(`#${index}: item ${String(got.item)} ≠ ${want.item}`);
    }
  });
  return { ok: problems.length === 0, problems };
}
