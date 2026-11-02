import { createSignal, For, Show } from 'solid-js';
import { Bot as BotIcon, Send, Sparkles, Undo2, X } from 'lucide-solid';

interface ChatRun {
  _id: string;
  items: Array<{ productId: number; name: string; qty: number; reason?: string }>;
  totalPrice: number;
}

interface ChatMessage {
  role: 'user' | 'bot';
  text: string;
  run?: ChatRun;
  requiresConfirmation?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function BotPanel() {
  const [open, setOpen] = createSignal(false);
  const [input, setInput] = createSignal('');
  const [messages, setMessages] = createSignal<ChatMessage[]>([
    {
      role: 'bot',
      text: 'Hi! Ask me to “fill my inventory for this week” or “pizza for 6”.',
    },
  ]);
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
          });
          if (result.run || result.status === 'added') {
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

      addMessage({ role: 'bot', text: 'That took too long. Check the Bot page in a moment.' });
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
        window.dispatchEvent(new CustomEvent('bot-run-complete'));
      }
    } catch {
      addMessage({ role: 'bot', text: 'Undo failed.' });
    } finally {
      setUndoing(null);
    }
  };

  return (
    <>
      <button
        class="btn btn-primary btn-circle btn-lg fixed bottom-6 right-6 z-30 shadow-2xl"
        title="Order bot"
        onClick={() => setOpen(true)}
      >
        <BotIcon size={26} />
      </button>

      <Show when={open()}>
        <div class="fixed inset-0 bg-black/20 z-40" onClick={() => setOpen(false)} />
        <aside class="fixed right-0 top-0 h-full w-full max-w-md bg-base-100 shadow-2xl z-50 flex flex-col">
          <header class="flex items-center gap-3 p-4 border-b border-base-300 bg-base-100">
            <div class="bg-primary/10 text-primary rounded-xl p-2">
              <BotIcon size={22} />
            </div>
            <div class="flex-1">
              <h2 class="font-black text-lg leading-tight">Order bot</h2>
              <p class="text-xs opacity-70">Weekly fills and learned occasions</p>
            </div>
            <button class="btn btn-ghost btn-sm btn-square" onClick={() => setOpen(false)}>
              <X size={20} />
            </button>
          </header>

          <div class="flex-1 overflow-y-auto p-4 space-y-4 bg-base-200/40">
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
                        <div class="mt-3 pt-3 border-t border-white/20 space-y-2">
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

                    <Show when={message.requiresConfirmation}>
                      <button class="btn btn-xs btn-warning mt-2 gap-1" onClick={() => send('yes')} disabled={busy()}>
                        <Sparkles size={14} /> Confirm
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>

            <Show when={busy()}>
              <div class="chat chat-start">
                <div class="chat-bubble chat-bubble-neutral">
                  <span class="loading loading-dots loading-sm" />
                  <span class="text-xs ml-2">{progress()}</span>
                </div>
              </div>
            </Show>
          </div>

          <form
            class="p-3 border-t border-base-300 flex items-center gap-2 bg-base-100"
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
        </aside>
      </Show>
    </>
  );
}
