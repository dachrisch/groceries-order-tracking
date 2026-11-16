/**
 * The legacy `/bot` page.
 *
 * `/bot` now opens the Ask hub, but the file stays because its Runs list is
 * still the only full history view. Occasions and Groups are the shared panes
 * from `components/ask`, so this page adds no second implementation of those
 * calls.
 */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Bot as BotIcon, ChevronDown, RefreshCw, Undo2, AlertCircle } from 'lucide-solid';
import { OccasionsPane } from '../components/ask/OccasionsPane';
import { GroupsPane } from '../components/ask/GroupsPane';

interface BotRunItem {
  productId: number;
  name: string;
  qty: number;
  reason?: string;
  groupKey?: string;
  price?: number;
}

interface BotRun {
  _id: string;
  createdAt: string;
  intent: {
    type: 'weekly' | 'occasion' | 'plan';
    occasion?: string;
    servings?: number;
    summary?: string;
  };
  items: BotRunItem[];
  totalPrice: number;
  status: 'in-cart' | 'undone' | 'delivered' | 'partially-delivered';
  matchedOrderId?: number;
  deliveredItemCount?: number;
}

function runTitle(run: BotRun): string {
  if (run.intent.type === 'plan' && run.intent.summary) {
    return run.intent.summary[0].toUpperCase() + run.intent.summary.slice(1);
  }
  if (run.intent.type === 'weekly') return 'Weekly fill';
  return `${run.intent.occasion ?? 'Occasion'}${
    run.intent.servings ? ` for ${run.intent.servings}` : ''
  }`;
}

const STATUS_LABELS: Record<BotRun['status'], string> = {
  'in-cart': 'In cart',
  undone: 'Undone',
  delivered: 'Delivered',
  'partially-delivered': 'Partially delivered',
};

const STATUS_CLASSES: Record<BotRun['status'], string> = {
  'in-cart': 'badge-primary',
  undone: 'badge-ghost',
  delivered: 'badge-success',
  'partially-delivered': 'badge-warning',
};

export function Bot() {
  const [tab, setTab] = createSignal<'runs' | 'occasions' | 'groups'>('runs');
  const [runs, setRuns] = createSignal<BotRun[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [expandedRun, setExpandedRun] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const loadRuns = async () => {
    try {
      const res = await fetch('/api/bot/runs');
      if (res.ok) setRuns(await res.json());
    } catch (failure) {
      console.error('Could not load bot runs', failure);
      setError('Could not load bot runs.');
    }
  };

  onMount(() => {
    void loadRuns().finally(() => setLoading(false));
    // Occasions and chat are separate panes now; a run started in either one
    // should still show up in the history without a manual refresh.
    const reload = () => void loadRuns();
    window.addEventListener('bot-run-complete', reload);
    onCleanup(() => window.removeEventListener('bot-run-complete', reload));
  });

  const undoRun = async (run: BotRun) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/bot/runs/${run._id}/undo`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Undo failed');
        if (body.cartUrl) window.open(body.cartUrl, '_blank', 'noopener,noreferrer');
      } else {
        await loadRuns();
      }
    } catch {
      setError('Undo failed.');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    await loadRuns();
    setLoading(false);
  };

  return (
    <div class="space-y-8 pb-16">
      <div class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div class="animate-fade-in">
          <h1 class="flex items-center gap-3 text-4xl font-extrabold tracking-tight">
            <BotIcon size={34} class="text-primary" /> Bot
          </h1>
          <p class="mt-1 text-base-content/85">What the order bot added, and what it has learned</p>
        </div>
        <button class="btn btn-ghost btn-sm gap-2 rounded-xl" onClick={refresh} disabled={loading()}>
          <RefreshCw size={18} class={loading() ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div class="tabs tabs-box w-fit rounded-2xl border border-base-300 bg-base-100 p-1 shadow-sm">
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${
            tab() === 'runs' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setTab('runs')}
        >
          Runs
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${
            tab() === 'occasions' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setTab('occasions')}
        >
          Occasions
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${
            tab() === 'groups' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'
          }`}
          onClick={() => setTab('groups')}
        >
          Product groups
        </button>
      </div>

      <Show when={error()}>
        <div class="alert alert-error shadow-lg">
          <AlertCircle size={22} />
          <span class="font-bold">{error()}</span>
          <button class="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="flex justify-center p-24">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      </Show>

      <Show when={!loading() && tab() === 'runs'}>
        <Show
          when={runs().length > 0}
          fallback={
            <div class="card rounded-2xl border border-base-300 bg-base-100 p-12 text-center">
              <h3 class="text-2xl font-black">No bot runs yet</h3>
              <p class="mt-2 text-base-content/80">
                Use Ask or the “Fill week” button on Groceries.
              </p>
            </div>
          }
        >
          <div class="space-y-4">
            <For each={runs()}>
              {(run) => (
                <div class="card overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm">
                  <button
                    class="flex w-full items-center gap-4 p-5 text-left transition-colors hover:bg-base-200/40"
                    onClick={() => setExpandedRun(expandedRun() === run._id ? null : run._id)}
                  >
                    <div class="rounded-xl bg-primary/10 p-3 text-primary">
                      <Show
                        when={run.intent.type === 'occasion'}
                        fallback={<BotIcon size={22} />}
                      >
                        <span class="text-xl">🎉</span>
                      </Show>
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-lg font-black">{runTitle(run)}</div>
                      <div class="text-sm opacity-75">
                        {new Date(run.createdAt).toLocaleString()} · {run.items.length} items · €
                        {run.totalPrice.toFixed(2)}
                      </div>
                    </div>
                    <div class={`badge ${STATUS_CLASSES[run.status]} badge-md font-bold`}>
                      {STATUS_LABELS[run.status]}
                    </div>
                    <ChevronDown
                      size={20}
                      class={`transition-transform ${
                        expandedRun() === run._id ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  <Show when={expandedRun() === run._id}>
                    <div class="space-y-3 border-t border-base-200 p-5">
                      <For each={run.items}>
                        {(item) => (
                          <div class="flex items-start gap-3 text-sm">
                            <div class="badge badge-neutral badge-sm mt-0.5 font-mono">
                              ×{item.qty}
                            </div>
                            <div class="flex-1">
                              <div class="font-semibold">{item.name}</div>
                              <Show when={item.reason}>
                                <div class="text-xs opacity-70">{item.reason}</div>
                              </Show>
                            </div>
                            <Show when={item.price !== undefined}>
                              <div class="font-mono text-xs opacity-80">
                                €{((item.price ?? 0) * item.qty).toFixed(2)}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>

                      <div class="flex items-center gap-3 border-t border-base-200 pt-3">
                        <Show when={run.status === 'in-cart'}>
                          <button
                            class="btn btn-error btn-outline btn-sm gap-2"
                            onClick={() => undoRun(run)}
                            disabled={busy()}
                          >
                            <Undo2 size={16} /> Undo
                          </button>
                        </Show>
                        <Show when={run.matchedOrderId}>
                          <A href={`/order/${run.matchedOrderId}`} class="btn btn-ghost btn-sm">
                            Delivered in order #{run.matchedOrderId}
                            <Show when={run.deliveredItemCount !== undefined}>
                              <span class="badge badge-sm">
                                {run.deliveredItemCount}/{run.items.length}
                              </span>
                            </Show>
                          </A>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={!loading() && tab() === 'occasions'}>
        <OccasionsPane />
      </Show>

      <Show when={!loading() && tab() === 'groups'}>
        <GroupsPane />
      </Show>
    </div>
  );
}
