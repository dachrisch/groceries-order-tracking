import { executeWeeklyFill, getBotSettings, type FillResult } from './fill';
import { parseIntent } from './intent';

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

interface PendingAction {
  type: 'weekly';
}

const pendingConfirmations = new Map<string, PendingAction>();

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
    const result = await executeWeeklyFill(userId, derivedKey, { confirm: true });
    return summarizeFill(result);
  }

  if (intent.type === 'weekly') {
    const result = await executeWeeklyFill(userId, derivedKey);
    if (result.status === 'requires-confirmation') {
      pendingConfirmations.set(userId, { type: 'weekly' });
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
    return summarizeFill(result);
  }

  if (intent.type === 'occasion') {
    return {
      reply: `I haven't learned an occasion called “${intent.occasion}” yet.`,
      status: 'info',
    };
  }

  if (intent.type === 'correction') {
    return {
      reply: `I don't have an occasion to remove “${intent.item}” from yet.`,
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
