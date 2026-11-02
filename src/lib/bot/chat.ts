import Occasion from '../../models/Occasion';
import { formatShortDate, horizonDaysUntil } from './dates';
import {
  executeCandidates,
  getBotSettings,
  mergeCandidates,
  planWeeklyFill,
  weeklyCandidates,
  type FillCandidate,
  type FillResult,
} from './fill';
import { parsePlan, type BotAction } from './intent';
import {
  loadOccasion,
  matchOccasion,
  matchOccasionWithLlm,
  occasionCandidates,
  occasionPacks,
  removeOccasionItem,
} from './occasions';
import { resolveRecipe, type RecipeChoice } from './recipes';

/**
 * Chat orchestration. A message becomes a plan of actions; the LLM only reads
 * language and names ingredients, every cart action is deterministic backend
 * code. Clear actions run right away; a recipe the bot has not learned yet is
 * shown as a draft and only reaches the cart after one "yes".
 */

export interface BotDraft {
  occasionId: string;
  name: string;
  servings: number;
  date?: string;
  style?: string;
  items: Array<{ name: string; qty: number }>;
  missing: string[];
}

export interface BotMessageResult {
  reply: string;
  status: 'added' | 'requires-confirmation' | 'nothing-to-add' | 'info' | 'error';
  run?: unknown;
  items?: FillResult['items'];
  estimatedTotal?: number;
  drafts?: BotDraft[];
}

/** An action whose occasion is resolved to a confirmed (or about to be) Occasion. */
type ResolvedAction =
  | { type: 'weekly'; until?: Date }
  | { type: 'occasion'; occasionId: string; name: string; servings: number; date?: Date };

interface Pending {
  actions: ResolvedAction[];
  /** Draft occasions that become confirmed on "yes". */
  draftIds: string[];
}

const pendingByUser = new Map<string, Pending>();
const lastOccasionByUser = new Map<string, string>();

const formatEuro = (value: number) => `€${value.toFixed(2)}`;

function actionLabel(action: ResolvedAction, now: Date): string {
  if (action.type === 'weekly') {
    return action.until ? `your usual groceries till ${formatShortDate(action.until, now)}` : 'your usual groceries';
  }
  return `${action.name} ×${action.servings}${action.date ? ` (${formatShortDate(action.date, now)})` : ''}`;
}

/** Plan and execute resolved actions as one cart update and one BotRun. */
async function executeActions(
  userId: string,
  derivedKey: Buffer | undefined,
  actions: ResolvedAction[],
  options: { confirm?: boolean; now?: Date } = {}
): Promise<FillResult> {
  const now = options.now ?? new Date();
  const settings = await getBotSettings(userId);
  const lists: FillCandidate[][] = [];

  for (const action of actions) {
    if (action.type === 'occasion') {
      const occasion = await loadOccasion(userId, action.occasionId);
      lists.push(await occasionCandidates(userId, occasion, action.servings, actionLabel(action, now)));
    }
  }
  // Weekly last: on shared groups the occasion reason reads first.
  for (const action of actions) {
    if (action.type === 'weekly') {
      const horizonDays = action.until ? horizonDaysUntil(action.until, now) : undefined;
      const plan = await planWeeklyFill(userId, settings, { horizonDays });
      lists.push(weeklyCandidates(plan.consumption));
    }
  }

  const summary = actions.map((action) => actionLabel(action, now)).join(' + ');
  const single = actions.length === 1 ? actions[0] : null;
  const intent: FillResult['intent'] =
    single?.type === 'weekly'
      ? { type: 'weekly', summary }
      : single?.type === 'occasion'
        ? { type: 'occasion', occasion: single.name, occasionId: single.occasionId, servings: single.servings, summary }
        : { type: 'plan', summary };

  return executeCandidates(userId, derivedKey, mergeCandidates(lists), intent, settings, { confirm: options.confirm });
}

function fillLine(result: FillResult): string {
  const what = result.intent.summary ?? 'your order';
  if (result.status === 'nothing-to-add') {
    return result.skipped && result.skipped.length > 0
      ? `Nothing to add for ${what}: ${result.skipped.length} item(s) are already in your cart.`
      : `Nothing to add for ${what}: you're stocked.`;
  }
  if (result.status === 'requires-confirmation') {
    return (
      `${what[0].toUpperCase()}${what.slice(1)} would add ${result.items.length} items (${formatEuro(result.estimatedTotal)}), ` +
      `above your limit of ${formatEuro(result.maxEuro)} / ${result.maxItems} items.`
    );
  }
  return `Added ${result.items.length} items (${formatEuro(result.estimatedTotal)}) for ${what}.`;
}

function styleSentence(name: string, choice: RecipeChoice): string {
  const evidence = choice.evidence
    .slice(0, 4)
    .map((group) => `${group.label} (${group.purchaseCount}×)`)
    .join(', ');
  if (choice.style === 'homemade' && choice.confident) {
    return `You make ${name.toLowerCase()} yourself: you've bought ${evidence}.`;
  }
  if (choice.style === 'ready-made' && choice.confident) {
    return `You usually buy ${name.toLowerCase()} ready-made: ${evidence}.`;
  }
  return `I put this together from products you have bought before.`;
}

function draftFor(
  occasion: { _id: unknown; name: string; items: Array<{ name: string; qtyPerServing: number; packSize: number; core: boolean }>; missing?: string[]; style?: string },
  servings: number,
  date: Date | undefined,
  now: Date
): BotDraft {
  return {
    occasionId: String(occasion._id),
    name: occasion.name,
    servings,
    date: date ? formatShortDate(date, now) : undefined,
    style: occasion.style,
    items: occasion.items
      .filter((item) => item.core)
      .map((item) => ({ name: item.name, qty: occasionPacks(item.qtyPerServing, servings, item.packSize) })),
    missing: occasion.missing ?? [],
  };
}

function draftLine(draft: BotDraft, intro: string): string {
  const items = draft.items.map((item) => `${item.name} ×${item.qty}`).join(', ');
  const missing = draft.missing.length > 0 ? ` Not in your history (add yourself): ${draft.missing.join(', ')}.` : '';
  const when = draft.date ? ` (${draft.date})` : '';
  return `${draft.name} ×${draft.servings}${when} is new to me. ${intro} Draft: ${items}.${missing}`;
}

export async function executeBotMessage(
  userId: string,
  text: string,
  derivedKey: Buffer | undefined,
  options: { now?: Date } = {}
): Promise<BotMessageResult> {
  const now = options.now ?? new Date();
  const settings = await getBotSettings(userId);
  const occasions = await Occasion.find({ userId }).select('name aliases status').lean<
    Array<{ _id: unknown; name: string; aliases?: string[]; status?: string }>
  >();

  const plan = await parsePlan(text, {
    useLLM: settings.opencodeEnabled,
    knownOccasions: occasions.map((occasion) => occasion.name),
    now,
  });

  if (plan.actions.some((action) => action.type === 'confirm')) {
    return confirmPending(userId, derivedKey, now);
  }

  const lines: string[] = [];
  const resolved: ResolvedAction[] = [];
  const drafts: BotDraft[] = [];
  const draftActions: ResolvedAction[] = [];
  let understood = false;

  for (const action of plan.actions) {
    if (action.type === 'weekly') {
      understood = true;
      resolved.push(action.until ? { type: 'weekly', until: action.until } : { type: 'weekly' });
    } else if (action.type === 'correction') {
      understood = true;
      lines.push(await applyCorrection(userId, action));
    } else if (action.type === 'occasion') {
      understood = true;
      const outcome = await resolveOccasionAction(userId, action, occasions, settings.opencodeEnabled, now);
      if (outcome.kind === 'ready') resolved.push(outcome.action);
      if (outcome.kind === 'draft') {
        drafts.push(outcome.draft);
        draftActions.push(outcome.action);
        lines.push(outcome.line);
      }
      if (outcome.kind === 'none') lines.push(outcome.line);
    }
  }

  if (!understood) {
    return {
      reply:
        'I can fill your usual groceries ("food till Sunday") and plan dishes ("pizza for 6 on Wednesday"), ' +
        'also both in one message.',
      status: 'info',
    };
  }

  let fill: FillResult | null = null;
  if (resolved.length > 0) {
    fill = await executeActions(userId, derivedKey, resolved, { now });
    lines.unshift(fillLine(fill));
  }

  const guardrailWaiting = fill?.status === 'requires-confirmation';
  if (drafts.length > 0 || guardrailWaiting) {
    pendingByUser.set(userId, {
      actions: [...(guardrailWaiting ? resolved : []), ...draftActions],
      draftIds: drafts.map((draft) => draft.occasionId),
    });
    lines.push(
      drafts.length > 0 && guardrailWaiting
        ? 'Reply "yes" to add the draft and confirm the order above.'
        : drafts.length > 0
          ? 'Reply "yes" to add it, or edit it on the Bot › Occasions page.'
          : 'Reply "yes" to confirm.'
    );
  } else {
    pendingByUser.delete(userId);
  }

  return {
    reply: lines.join('\n\n'),
    status: guardrailWaiting || drafts.length > 0 ? 'requires-confirmation' : fill?.status ?? 'info',
    run: fill?.run,
    items: fill?.items,
    estimatedTotal: fill?.estimatedTotal,
    drafts: drafts.length > 0 ? drafts : undefined,
  };
}

type OccasionOutcome =
  | { kind: 'ready'; action: ResolvedAction }
  | { kind: 'draft'; action: ResolvedAction; draft: BotDraft; line: string }
  | { kind: 'none'; line: string };

async function resolveOccasionAction(
  userId: string,
  action: Extract<BotAction, { type: 'occasion' }>,
  occasions: Array<{ _id: unknown; name: string; aliases?: string[]; status?: string }>,
  useLLM: boolean,
  now: Date
): Promise<OccasionOutcome> {
  let match = matchOccasion(occasions, action.occasion);
  if (!match && useLLM && occasions.length > 0) {
    const name = await matchOccasionWithLlm(action.occasion, occasions.map((occasion) => occasion.name));
    if (name) match = occasions.find((occasion) => occasion.name === name) ?? null;
  }

  if (match && match.status !== 'draft') {
    lastOccasionByUser.set(userId, String(match._id));
    return {
      kind: 'ready',
      action: { type: 'occasion', occasionId: String(match._id), name: match.name, servings: action.servings, date: action.date },
    };
  }

  if (match) {
    // A suggested or earlier draft recipe: show it once before it reaches the cart.
    const occasion = await loadOccasion(userId, String(match._id));
    lastOccasionByUser.set(userId, String(match._id));
    const draft = draftFor(occasion, action.servings, action.date, now);
    return {
      kind: 'draft',
      action: { type: 'occasion', occasionId: draft.occasionId, name: occasion.name, servings: action.servings, date: action.date },
      draft,
      line: draftLine(draft, 'I found a recipe that matches what you buy.'),
    };
  }

  if (!useLLM) {
    return { kind: 'none', line: `I haven't learned “${action.occasion}” yet, and the AI is switched off in Settings, so I can't build a recipe.` };
  }

  const recipe = await resolveRecipe(userId, action.occasion, action.servings);
  if (!recipe) {
    return {
      kind: 'none',
      line: `I couldn't build “${action.occasion}” from your products: none of its ingredients are in your order history yet.`,
    };
  }

  const occasion = await loadOccasion(userId, String(recipe.occasion._id));
  lastOccasionByUser.set(userId, String(occasion._id));
  const draft = draftFor(occasion, action.servings, action.date, now);
  return {
    kind: 'draft',
    action: { type: 'occasion', occasionId: draft.occasionId, name: occasion.name, servings: action.servings, date: action.date },
    draft,
    line: draftLine(draft, styleSentence(occasion.name, recipe.choice)),
  };
}

async function applyCorrection(userId: string, action: Extract<BotAction, { type: 'correction' }>): Promise<string> {
  const corrected = await removeOccasionItem(userId, action.item, action.occasion, lastOccasionByUser.get(userId));
  return corrected
    ? `Done: I removed ${corrected.removed.join(', ')} from “${corrected.occasionName}” for next time.`
    : `I could not find “${action.item}” in a learned occasion.`;
}

async function confirmPending(userId: string, derivedKey: Buffer | undefined, now: Date): Promise<BotMessageResult> {
  const pending = pendingByUser.get(userId);
  if (!pending) return { reply: 'There is nothing waiting for confirmation.', status: 'info' };
  pendingByUser.delete(userId);

  if (pending.draftIds.length > 0) {
    await Occasion.updateMany({ userId, _id: { $in: pending.draftIds } }, { $set: { status: 'confirmed' } });
  }
  if (pending.actions.length === 0) {
    return { reply: 'Saved. Next time this goes straight into the cart.', status: 'info' };
  }

  const result = await executeActions(userId, derivedKey, pending.actions, { confirm: true, now });
  const learned = pending.draftIds.length > 0 ? ' Saved the recipe; next time it goes straight into the cart.' : '';
  return {
    reply: fillLine(result) + learned,
    status: result.status,
    run: result.run,
    items: result.items,
    estimatedTotal: result.estimatedTotal,
  };
}

/** Used by tests and by the settings page to clear an abandoned prompt. */
export function clearPendingConfirmation(userId: string): void {
  pendingByUser.delete(userId);
}

export function getLastOccasion(userId: string): string | undefined {
  return lastOccasionByUser.get(userId);
}
