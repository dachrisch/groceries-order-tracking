/**
 * The desktop chat drawer.
 *
 * Chat itself lives in `ask/ChatPane` so this panel and the Ask hub cannot
 * disagree about job polling, undo or `bot-run-complete`. On a phone the centre
 * tab opens the Ask hub instead, so the floating launcher is desktop-only.
 */
import { createSignal } from 'solid-js';
import { Bot as BotIcon, X } from 'lucide-solid';
import { ChatPane } from './ask/ChatPane';
import { openAsk } from '../lib/overlays';

export function BotPanel() {
  const [open, setOpen] = createSignal(false);

  const openOccasions = () => {
    setOpen(false);
    openAsk('occasions');
  };

  return (
    <>
      <button
        class="btn btn-primary btn-circle btn-lg fixed bottom-6 right-6 z-30 hidden shadow-2xl lg:flex"
        title="Order bot"
        onClick={() => setOpen(true)}
      >
        <BotIcon size={26} />
      </button>

      <div
        class={`${open() ? 'fixed' : 'hidden'} inset-0 z-40 bg-black/20`}
        onClick={() => setOpen(false)}
      />
      <aside
        class={`${open() ? 'flex' : 'hidden'} fixed right-0 top-0 z-50 h-full w-full max-w-md flex-col bg-base-100 shadow-2xl`}
      >
        <header class="flex items-center gap-3 border-b border-base-300 bg-base-100 p-4">
          <div class="rounded-xl bg-primary/10 p-2 text-primary">
            <BotIcon size={22} />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-black leading-tight">Order bot</h2>
            <p class="text-xs opacity-70">Weekly fills and learned occasions</p>
          </div>
          <button class="btn btn-ghost btn-sm btn-square" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </header>

        <div class="min-h-0 flex-1">
          <ChatPane onEditOccasions={openOccasions} />
        </div>
      </aside>
    </>
  );
}
