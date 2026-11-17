/**
 * Ask is one destination with three panes, not three destinations.
 *
 * Chat is the same job-based conversation as the floating panel; Occasions and
 * Groups are the learning surfaces that used to live on their own page (T5).
 * The panes are imported, never reimplemented, so a run started here still
 * dispatches `bot-run-complete` exactly as before.
 */
import { For, Show } from 'solid-js';
import { Bot, ChefHat, Layers } from 'lucide-solid';
import { Sheet } from './Sheet';
import { ChatPane } from './ask/ChatPane';
import { OccasionsPane } from './ask/OccasionsPane';
import { GroupsPane } from './ask/GroupsPane';
import { askHubOpen, askTab, closeAsk, setAskTab, type AskTab } from '../lib/overlays';

const SEGMENTS: Array<{ id: AskTab; label: string; icon: typeof Bot }> = [
  { id: 'chat', label: 'Chat', icon: Bot },
  { id: 'occasions', label: 'Occasions', icon: ChefHat },
  { id: 'groups', label: 'Groups', icon: Layers },
];

export function AskHub() {
  return (
    <Sheet
      open={askHubOpen()}
      onClose={closeAsk}
      title="Ask"
      subtitle="Chat, learned occasions and product groups"
      width="lg"
      keepMounted
      bodyClass="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div class="flex shrink-0 gap-2 border-b border-base-300 p-3">
        <div class="grid w-full grid-cols-3 gap-1 rounded-xl bg-base-200 p-1">
          <For each={SEGMENTS}>
            {(segment) => (
              <button
                class={`btn btn-sm gap-1.5 border-none rounded-lg ${
                  askTab() === segment.id ? 'btn-primary shadow-sm' : 'btn-ghost opacity-80'
                }`}
                onClick={() => setAskTab(segment.id)}
              >
                <segment.icon size={15} />
                {segment.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="min-h-0 flex-1 md:min-h-[26rem]">
        {/* Chat stays mounted so switching panes cannot discard a run in flight. */}
        <div class={askTab() === 'chat' ? 'h-full' : 'hidden'}>
          <ChatPane onEditOccasions={() => setAskTab('occasions')} />
        </div>
        <Show when={askTab() === 'occasions'}>
          <div class="h-full overflow-y-auto p-4">
            <OccasionsPane />
          </div>
        </Show>
        <Show when={askTab() === 'groups'}>
          <div class="h-full overflow-y-auto p-4">
            <GroupsPane />
          </div>
        </Show>
      </div>
    </Sheet>
  );
}
