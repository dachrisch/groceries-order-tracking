import { createSignal, Show } from 'solid-js';
import { Orders } from './Orders';
import { InStore } from './InStore';

/**
 * Activity is where Orders and In-Store collapse into one stream.
 *
 * Placeholder for Phase 4: the page pass replaces this with the merged
 * `GET /api/activity` timeline. Until then the two existing pages stay
 * reachable behind a local switch.
 */
export function Activity() {
  const [pane, setPane] = createSignal<'deliveries' | 'in-store'>('deliveries');

  return (
    <div class="space-y-6">
      <div class="tabs tabs-box w-fit rounded-2xl border border-base-300 bg-base-100 p-1 shadow-sm">
        <button
          class={`btn btn-sm border-none rounded-xl px-5 ${
            pane() === 'deliveries' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setPane('deliveries')}
        >
          Deliveries
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-5 ${
            pane() === 'in-store' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setPane('in-store')}
        >
          In-store
        </button>
      </div>

      <Show when={pane() === 'deliveries'}>
        <Orders />
      </Show>
      <Show when={pane() === 'in-store'}>
        <InStore />
      </Show>
    </div>
  );
}
