/**
 * The chat half of Ask.
 *
 * Extracted from BotPanel so the floating drawer and the Ask hub run the same
 * job polling, undo and message state. Keep the polling here: a second chat
 * surface must not grow its own copy of the protocol.
 */
import { createSignal, For, Show } from 'solid-js';
import { Send, Sparkles, Undo2 } from 'lucide-solid';

interface ChatRun {
  _id: string;
  items: Array<{ productId: number; name: string; qty: number; reason?: string }>;
  totalPrice: number;
}

interface ChatDraft {
  occasionId: string;
  name: string;
  servings: number;
  date?: string;
  style?: string;
  items: Array<{ name: string; qty: number }>;
  missing: string[];
}

interface ChatMessage {
  role: 'user' | 'bot';
  text: string;
  run?: ChatRun;
  requiresConfirmation?: boolean;
  drafts?: ChatDraft[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GREETING = 'Hi! Try “pizza for 6 on Wednesday and food till Sunday”.';

export function ChatPane(props: { onEditOccasions?: () => void; class?: string }) {
  const [input, setInput] = createSignal('');
  const [messages, setMessages] = createSignal<ChatMessage[]>([{ role: 'bot', text: GREETING }]);
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal('');
  const [undoing, setUndoing] = createSignal<string | null>(null);

  const addMessage = (message: ChatMessage) => setMessages((previous) => [...previous, message]);

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input()).trim();
    if (!text || busy()) return;

    addMessage({ role: 'user', text });
    setInput('');
    setBusy(true);
    setProgress('Thinking…');

    try {
      const start = await fetch('/api/bot/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const startBody = await start.json();
      if (!start.ok) {
        addMessage({ role: 'bot', text: startBody.error ?? 'Could not start the bot.' });
        return;
      }

      const deadline = Date.now() + 140_000;
      while (Date.now() < deadline) {
        await sleep(1000);
        const response = await fetch(`/api/bot/jobs/${startBody.jobId}`);
        if (!response.ok) continue;
        const job = await response.json();

        if (job.status === 'done') {
          const result = job.result ?? {};
          addMessage({
            role: 'bot',
            text: result.reply ?? 'Done.',
            run: result.run,
            requiresConfirmation: result.status === 'requires-confirmation',
            drafts: result.drafts,
          });
          if (result.run || result.status === 'added') {
            // Inventory and the cart drawer refresh on this event
            // (Inventory.tsx listens). Dispatch it here, not in a panel, so
            // every chat surface that can create a run announces one.
            window.dispatchEvent(new CustomEvent('bot-run-complete'));
          }
          return;
        }

        if (job.status === 'error') {
          addMessage({ role: 'bot', text: job.error ?? 'The bot failed.' });
          return;
        }

        setProgress(job.status === 'running' ? 'Working on it…' : 'Queued…');
      }

      addMessage({ role: 'bot', text: 'That took too long. Check Activity in a moment.' });
    } catch {
      addMessage({ role: 'bot', text: 'Connection error. Please try again.' });
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const undo = async (run: ChatRun) => {
    setUndoing(run._id);
    try {
      const response = await fetch(`/api/bot/runs/${run._id}/undo`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) {
        addMessage({ role: 'bot', text: body.error ?? 'Undo failed.' });
        if (body.cartUrl) window.open(body.cartUrl, '_blank', 'noopener,noreferrer');
      } else {
        addMessage({ role: 'bot', text: 'Undone — those items were removed from your cart.' });
        // Same reason as above: undo is a run-shaped change too.
        window.dispatchEvent(new CustomEvent('bot-run-complete'));
      }
    } catch {
      addMessage({ role: 'bot', text: 'Undo failed.' });
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div class={`flex h-full min-h-0 flex-col ${props.class ?? ''}`}>
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto bg-base-200/40 p-4">
        <For each={messages()}>
          {(message) => (
            <div class={`chat ${message.role === 'user' ? 'chat-end' : 'chat-start'}`}>
              <div
                class={`chat-bubble ${
                  message.role === 'user' ? 'chat-bubble-primary' : 'chat-bubble-neutral'
                }`}
              >
                <p class="whitespace-pre-wrap">{message.text}</p>

                <Show when={message.run}>
                  {(run) => (
                    <div class="mt-3 space-y-2 border-t border-white/20 pt-3">
                      <div class="flex items-center justify-between text-xs font-bold">
                        <span>{run().items.length} items</span>
                        <span>€{run().totalPrice.toFixed(2)}</span>
                      </div>
                      <button
                        class="btn btn-xs btn-outline gap-1"
                        onClick={() => undo(run())}
                        disabled={undoing() === run()._id}
                      >
                        <Show when={undoing() === run()._id} fallback={<Undo2 size={14} />}>
                          <span class="loading loading-spinner loading-xs" />
                        </Show>
                        Undo
                      </button>
                    </div>
                  )}
                </Show>

                <For each={message.drafts ?? []}>
                  {(draft) => (
                    <div class="mt-3 space-y-1 border-t border-white/20 pt-3">
                      <div class="text-xs font-bold">
                        {draft.name} ×{draft.servings}
                        {draft.date ? ` · ${draft.date}` : ''}
                        {draft.style ? ` · ${draft.style}` : ''}
                      </div>
                      <ul class="space-y-0.5 text-xs">
                        <For each={draft.items}>
                          {(item) => (
                            <li class="flex justify-between gap-3">
                              <span class="truncate">{item.name}</span>
                              <span class="font-mono">×{item.qty}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                      <Show when={draft.missing.length > 0}>
                        <p class="text-xs opacity-80">Add yourself: {draft.missing.join(', ')}</p>
                      </Show>
                    </div>
                  )}
                </For>

                <Show when={message.requiresConfirmation}>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button class="btn btn-xs btn-warning gap-1" onClick={() => send('yes')} disabled={busy()}>
                      <Sparkles size={14} /> {message.drafts?.length ? 'Add' : 'Confirm'}
                    </button>
                    <Show when={message.drafts?.length && props.onEditOccasions}>
                      <button class="btn btn-xs btn-ghost" onClick={() => props.onEditOccasions?.()}>
                        Edit in Occasions
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </For>

        <Show when={busy()}>
          <div class="chat chat-start">
            <div class="chat-bubble chat-bubble-neutral">
              <span class="loading loading-dots loading-sm" />
              <span class="ml-2 text-xs">{progress()}</span>
            </div>
          </div>
        </Show>
      </div>

      <form
        class="flex items-center gap-2 border-t border-base-300 bg-base-100 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <input
          class="input input-bordered flex-1"
          placeholder="e.g. fill my inventory for this week"
          value={input()}
          onInput={(event) => setInput(event.currentTarget.value)}
          disabled={busy()}
        />
        <button class="btn btn-primary btn-square" type="submit" disabled={busy() || !input().trim()}>
          <Send size={20} />
        </button>
      </form>
    </div>
  );
}
