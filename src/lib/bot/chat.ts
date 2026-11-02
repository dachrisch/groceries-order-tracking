import Occasion from '../../models/Occasion';
import { executeWeeklyFill, getBotSettings, type FillResult } from './fill';
import { parseIntent } from './intent';
import {
  closestOccasionNames,
  fillOccasion,
  matchOccasion,
  matchOccasionWithLlm,
  removeOccasionItem,
} from './occasions';

/**
 * Chat orchestration. The LLM only classifies language; every cart action is
 * deterministic backend code. Jobs are in-memory because replies take 20–90s
 * when opencode is involved and the frontend polls for the result.
 */

export interface BotMessageResult {
  reply: string;
  status: 'added' | 'requires-confirmation' | 'nothing-to-add' | 'info' | 'error';
  run?: unknown;
  items?: FillResult['items'];
  estimatedTotal?: number;
}

type PendingAction =
  | { type: 'weekly' }
  | { type: 'occasion'; occasionId: string; servings: number };

const pendingConfirmations = new Map<string, PendingAction>();
const lastOccasionByUser = new Map<string, string>();

function formatEuro(value: number): string {
  return `€${value.toFixed(2)}`;
}

export async function executeBotMessage(
  userId: string,
  text: string,
  derivedKey: Buffer | undefined
): Promise<BotMessageResult> {
  const settings = await getBotSettings(userId);
  const intent = await parseIntent(text, { useLLM: settings.opencodeEnabled });

  if (intent.type === 'confirm') {
    const pending = pendingConfirmations.get(userId);
    if (!pending) {
      return { reply: 'There is nothing waiting for confirmation.', status: 'info' };
    }
    pendingConfirmations.delete(userId);

    if (pending.type === 'weekly') {
      return summarizeFill(await executeWeeklyFill(userId, derivedKey, { confirm: true }));
    }

    return summarizeFill(
      await fillOccasion(userId, derivedKey, pending.occasionId, pending.servings, { confirm: true })
    );
  }

  if (intent.type === 'weekly') {
    const result = await executeWeeklyFill(userId, derivedKey);
    if (result.status === 'requires-confirmation') {
      pendingConfirmations.set(userId, { type: 'weekly' });
      return confirmationResult(result);
    }
    return summarizeFill(result);
  }

  if (intent.type === 'occasion') {
    const occasions = await Occasion.find({ userId }).select('name aliases').lean();
    let match = matchOccasion(occasions, intent.occasion);

    if (!match && settings.opencodeEnabled) {
      const matchedName = await matchOccasionWithLlm(
        intent.occasion,
        occasions.map((occasion) => occasion.name)
      );
      if (matchedName) match = occasions.find((occasion) => occasion.name === matchedName) ?? null;
    }

    if (!match) {
      const suggestions = closestOccasionNames(occasions, intent.occasion);
      return {
        reply:
          `I haven't seen you shop for “${intent.occasion}” yet.` +
          (suggestions.length > 0
            ? ` Closest occasions I know: ${suggestions.join(', ')}.`
            : ' I do not invent recipes, so I will not guess the products.'),
        status: 'info',
      };
    }

    lastOccasionByUser.set(userId, String(match._id));
    const result = await fillOccasion(userId, derivedKey, String(match._id), intent.servings);
    if (result.status === 'requires-confirmation') {
      pendingConfirmations.set(userId, {
        type: 'occasion',
        occasionId: String(match._id),
        servings: intent.servings,
      });
      return confirmationResult(result);
    }
    return summarizeFill(result);
  }

  if (intent.type === 'correction') {
    const corrected = await removeOccasionItem(
      userId,
      intent.item,
      intent.occasion,
      lastOccasionByUser.get(userId)
    );
    if (!corrected) {
      return {
        reply: `I could not find “${intent.item}” in a learned occasion.`,
        status: 'info',
      };
    }
    return {
      reply: `Done — I removed ${corrected.removed.join(', ')} from “${corrected.occasionName}” for next time.`,
      status: 'info',
    };
  }

  return {
    reply:
      'I can fill your regular weekly inventory ("fill my inventory for this week") ' +
      'or plan an occasion ("pizza for 6").',
    status: 'info',
  };
}

function confirmationResult(result: FillResult): BotMessageResult {
  return {
    reply:
      `This run would add ${result.items.length} items (${formatEuro(result.estimatedTotal)}), ` +
      `above your guardrail of ${formatEuro(result.maxEuro)} / ${result.maxItems} items. ` +
      'Reply "yes" to confirm.',
    status: 'requires-confirmation',
    items: result.items,
    estimatedTotal: result.estimatedTotal,
  };
}

function summarizeFill(result: FillResult): BotMessageResult {
  if (result.status === 'nothing-to-add') {
    return {
      reply:
        result.skipped && result.skipped.length > 0
          ? `Nothing to add — ${result.skipped.length} item(s) are already in your cart.`
          : 'Nothing to add — your inventory is stocked.',
      status: 'nothing-to-add',
    };
  }

  return {
    reply: `Added ${result.items.length} items (${formatEuro(result.estimatedTotal)}).`,
    status: 'added',
    run: result.run,
    items: result.items,
    estimatedTotal: result.estimatedTotal,
  };
}

/** Used by tests and by the settings page to clear an abandoned prompt. */
export function clearPendingConfirmation(userId: string): void {
  pendingConfirmations.delete(userId);
}

export function getLastOccasion(userId: string): string | undefined {
  return lastOccasionByUser.get(userId);
}
