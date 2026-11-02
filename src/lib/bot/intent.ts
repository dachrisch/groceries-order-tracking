import { isOpencodeConfigured, runPrompt } from '../opencode-client';

export type BotIntent =
  | { type: 'weekly' }
  | { type: 'occasion'; occasion: string; servings: number }
  | { type: 'correction'; action: 'remove'; item: string; occasion?: string }
  | { type: 'confirm' }
  | { type: 'unknown'; text: string };

export interface ParseIntentOptions {
  /** Pass false to skip the LLM even when opencode is configured. */
  useLLM?: boolean;
  knownOccasions?: string[];
}

const CONFIRM_PATTERN = /^(?:yes|yep|yeah|ok|okay|sure|confirm|go ahead|do it|ja|los|sicher)[.!]?$/i;
const WEEKLY_PATTERN =
  /(?:fill|refill|restock|stock up|order).*(?:week|inventory|weekly)|(?:this|next)\s+week|^weekly$|^fill$/i;
const OCCASION_PATTERN =
  /^(?:order|get|buy|make|plan)?\s*(.+?)\s+for\s+(\d+)(?:\s+(?:people|persons|personen|leute|gäste|gaeste))?[.!]?$/i;
const REMOVE_NEXT_TIME_PATTERN = /^(?:no|ohne|remove|drop|skip)\s+(.+?)\s+next\s+time[.!]?$/i;
const REMOVE_FROM_PATTERN = /^(?:remove|drop|skip|no)\s+(.+?)\s+(?:from|in|bei)\s+(.+?)[.!]?$/i;

/** Fast, deterministic parser for the common commands. No LLM needed. */
export function parseIntentFast(text: string): BotIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (CONFIRM_PATTERN.test(trimmed)) return { type: 'confirm' };

  const removeNextTime = trimmed.match(REMOVE_NEXT_TIME_PATTERN);
  if (removeNextTime) {
    return { type: 'correction', action: 'remove', item: removeNextTime[1].trim() };
  }

  const removeFrom = trimmed.match(REMOVE_FROM_PATTERN);
  if (removeFrom) {
    return {
      type: 'correction',
      action: 'remove',
      item: removeFrom[1].trim(),
      occasion: removeFrom[2].trim(),
    };
  }

  if (WEEKLY_PATTERN.test(trimmed)) return { type: 'weekly' };

  const occasion = trimmed.match(OCCASION_PATTERN);
  if (occasion) {
    const servings = Number(occasion[2]);
    if (Number.isFinite(servings) && servings > 0 && servings <= 100) {
      return { type: 'occasion', occasion: occasion[1].trim(), servings };
    }
  }

  return null;
}

interface LlmIntent {
  type?: string;
  occasion?: string;
  servings?: number;
  item?: string;
  action?: string;
}

function buildIntentPrompt(text: string, knownOccasions: string[]): string {
  return [
    'Classify a grocery order-bot chat message. Respond with only JSON, no prose.',
    'Allowed shapes:',
    '{"type":"weekly"} — fill the regular weekly inventory.',
    '{"type":"occasion","occasion":string,"servings":number} — an occasion like pizza for 6 people.',
    '{"type":"correction","action":"remove","item":string,"occasion":string|null} — the user does not want an item next time.',
    '{"type":"unknown"} — anything else.',
    knownOccasions.length > 0 ? `Known occasions: ${knownOccasions.join(', ')}.` : 'No occasions are known yet.',
    `Message: ${JSON.stringify(text)}`,
  ].join('\n');
}

function normalizeLlmIntent(value: unknown, text: string): BotIntent {
  if (!value || typeof value !== 'object') return { type: 'unknown', text };
  const intent = value as LlmIntent;

  if (intent.type === 'weekly') return { type: 'weekly' };

  if (intent.type === 'occasion') {
    const occasion = typeof intent.occasion === 'string' ? intent.occasion.trim() : '';
    const servings = Number(intent.servings);
    if (!occasion || !Number.isFinite(servings) || servings <= 0 || servings > 100) {
      return { type: 'unknown', text };
    }
    return { type: 'occasion', occasion, servings };
  }

  if (intent.type === 'correction') {
    const item = typeof intent.item === 'string' ? intent.item.trim() : '';
    if (!item) return { type: 'unknown', text };
    return {
      type: 'correction',
      action: 'remove',
      item,
      occasion: typeof intent.occasion === 'string' ? intent.occasion : undefined,
    };
  }

  return { type: 'unknown', text };
}

/**
 * Parse a chat message. Simple commands never touch the LLM; everything else
 * falls back to opencode when it is configured and enabled.
 */
export async function parseIntent(text: string, options: ParseIntentOptions = {}): Promise<BotIntent> {
  const fast = parseIntentFast(text);
  if (fast) return fast;

  const useLLM = options.useLLM ?? true;
  if (!useLLM || !isOpencodeConfigured()) {
    return { type: 'unknown', text };
  }

  try {
    const response = await runPrompt<unknown>(buildIntentPrompt(text, options.knownOccasions ?? []), {
      timeoutMs: 45_000,
    });
    return normalizeLlmIntent(response, text);
  } catch (error) {
    console.error('opencode intent parsing failed:', error);
    return { type: 'unknown', text };
  }
}
