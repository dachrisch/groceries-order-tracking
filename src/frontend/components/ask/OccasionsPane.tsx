/**
 * Learned occasions and recipe drafts.
 *
 * Moved out of `pages/Bot.tsx` so the Ask hub and the legacy bot page share one
 * set of API calls. Self-contained: it owns its loading, error and fill state.
 */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { AlertCircle, Check, ChefHat, Play, RefreshCw, Sparkles, Trash2 } from 'lucide-solid';

interface OccasionItem {
  productId: number;
  name: string;
  groupKey?: string;
  qtyPerServing: number;
  packSize: number;
  core: boolean;
}

interface Occasion {
  _id: string;
  name: string;
  aliases: string[];
  items: OccasionItem[];
  basisServings: number;
  occurrences: number;
  lastSeen?: string;
  sourceOrders: Array<{ orderId: number; productIds: number[] }>;
  source?: 'detected' | 'recipe' | 'discovered';
  status?: 'draft' | 'confirmed';
  style?: 'homemade' | 'ready-made';
  missing?: string[];
  evidence?: Array<{ label: string; purchaseCount: number }>;
}

interface DetectionStats {
  at?: string;
  ordersScanned?: number;
  candidateBaskets?: number;
  clusters?: number;
  kept?: number;
}

const isDraft = (occasion: Occasion) => occasion.status === 'draft';
/** Recipes store amounts per person; detected occasions have a learned group size. */
const defaultServings = (occasion: Occasion) =>
  occasion.source && occasion.source !== 'detected' ? 4 : occasion.basisServings;

export function OccasionsPane() {
  const [occasions, setOccasions] = createSignal<Occasion[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [servings, setServings] = createSignal<Record<string, number>>({});
  const [detection, setDetection] = createSignal<DetectionStats | null>(null);
  const [busy, setBusy] = createSignal(false);

  const loadOccasions = async () => {
    try {
      const [res, diagnostics] = await Promise.all([
        fetch('/api/bot/occasions'),
        fetch('/api/bot/occasions/diagnostics'),
      ]);
      if (res.ok) setOccasions(await res.json());
      if (diagnostics.ok) setDetection((await diagnostics.json()).lastDetection ?? null);
    } catch (failure) {
      console.error('Could not load occasions', failure);
      setError('Could not load occasions.');
    }
  };

  onMount(() => {
    setLoading(true);
    void loadOccasions().finally(() => setLoading(false));
    // A chat run can create a draft, so the list follows the same event the
    // inventory uses instead of requiring a manual refresh.
    const reload = () => void loadOccasions();
    window.addEventListener('bot-run-complete', reload);
    onCleanup(() => window.removeEventListener('bot-run-complete', reload));
  });

  const detectAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/bot/occasions/detect', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? 'Detection failed');
      } else {
        setOccasions(await res.json());
        setNotice('Occasions re-detected from your order history.');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmOccasion = async (occasion: Occasion) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bot/occasions/${occasion._id}/confirm`, { method: 'POST' });
      if (!res.ok) setError((await res.json()).error ?? 'Could not confirm');
      else {
        setNotice(`${occasion.name} saved. Asking for it in chat now goes straight into the cart.`);
        await loadOccasions();
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteOccasion = async (occasion: Occasion) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bot/occasions/${occasion._id}`, { method: 'DELETE' });
      if (!res.ok) setError((await res.json()).error ?? 'Could not delete');
      else {
        setNotice(`${occasion.name} removed.`);
        await loadOccasions();
      }
    } finally {
      setBusy(false);
    }
  };

  const discoverRecipes = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/bot/occasions/discover', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Recipe discovery failed');
      else {
        setOccasions(body.occasions);
        setNotice(
          body.found > 0
            ? `Found ${body.found} recipe(s) your groceries point to.`
            : 'No new recipes found in your groceries.'
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const fillOccasion = async (occasion: Occasion) => {
    const count = servings()[occasion._id] ?? defaultServings(occasion);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let res = await fetch(`/api/bot/occasions/${occasion._id}/fill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servings: count }),
      });
      let body = await res.json();

      if (res.ok && body.status === 'requires-confirmation') {
        if (
          !window.confirm(
            `This adds ${body.items.length} items (~€${Number(body.estimatedTotal).toFixed(2)}). Continue?`
          )
        ) {
          return;
        }
        res = await fetch(`/api/bot/occasions/${occasion._id}/fill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ servings: count, confirm: true }),
        });
        body = await res.json();
      }

      if (!res.ok) {
        setError(body.error ?? 'Occasion fill failed');
        return;
      }

      if (body.status === 'added') {
        setNotice(
          `Added ${body.items.length} items for ${occasion.name} (€${Number(body.estimatedTotal).toFixed(2)}).`
        );
        window.dispatchEvent(new CustomEvent('bot-run-complete'));
      } else if (body.status === 'nothing-to-add') {
        setNotice('Nothing to add — those items are already in your cart.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="space-y-4">
      <Show when={error()}>
        <div class="alert alert-error shadow-sm">
          <AlertCircle size={20} />
          <span class="text-sm font-semibold">{error()}</span>
          <button class="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      </Show>

      <Show when={notice()}>
        <div class="alert alert-success shadow-sm">
          <span class="text-sm font-semibold">{notice()}</span>
          <button class="btn btn-sm" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      </Show>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="max-w-xl text-xs text-base-content/70">
          Occasions come from repeated special baskets in your orders. Recipes are built from
          products you already buy, so the bot knows whether you cook from scratch or buy it
          ready-made.
        </p>
        <div class="flex gap-2">
          <button class="btn btn-outline btn-xs gap-1" onClick={discoverRecipes} disabled={busy()}>
            <ChefHat size={14} /> Find recipes
          </button>
          <button class="btn btn-outline btn-xs gap-1" onClick={detectAgain} disabled={busy()}>
            <RefreshCw size={14} class={busy() ? 'animate-spin' : ''} /> Detect again
          </button>
        </div>
      </div>

      <Show when={loading()}>
        <div class="flex justify-center p-12">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      </Show>

      <Show when={!loading()}>
        <Show when={occasions().filter((occasion) => !isDraft(occasion)).length === 0}>
          <div class="card border border-base-300 bg-base-100 p-6 text-center">
            <h3 class="text-lg font-black">No occasions learned yet</h3>
            <Show
              when={detection()?.at}
              fallback={
                <p class="mt-1 text-sm text-base-content/75">
                  Detection has not run yet. Sync your orders or press “Detect again”.
                </p>
              }
            >
              <p class="mt-1 text-sm text-base-content/75">
                Looked at {detection()!.ordersScanned ?? 0} orders: {detection()!.candidateBaskets ?? 0}{' '}
                special baskets, {detection()!.clusters ?? 0} repeated at least twice,{' '}
                {detection()!.kept ?? 0} kept.
              </p>
            </Show>
            <p class="mt-1 text-xs text-base-content/60">
              Ask the bot for a dish (“pizza for 6”) or press “Find recipes”.
            </p>
          </div>
        </Show>

        <For
          each={[
            {
              title: 'Drafts and suggested recipes',
              hint: 'Shown once before they reach the cart.',
              list: occasions().filter(isDraft),
            },
            { title: 'Confirmed', hint: '', list: occasions().filter((occasion) => !isDraft(occasion)) },
          ]}
        >
          {(section) => (
            <Show when={section.list.length > 0}>
              <div class="flex items-baseline gap-2">
                <h3 class="text-sm font-black">{section.title}</h3>
                <span class="text-[11px] text-base-content/50">{section.hint}</span>
              </div>
              <div class="grid grid-cols-1 gap-3">
                <For each={section.list}>
                  {(occasion) => (
                    <div
                      class={`card border bg-base-100 shadow-sm ${
                        isDraft(occasion) ? 'border-warning/60' : 'border-base-300'
                      }`}
                    >
                      <div class="card-body gap-2 p-4">
                        <div class="flex items-start gap-2">
                          <div class="flex-1 min-w-0">
                            <div class="flex flex-wrap items-center gap-2">
                              <h3 class="truncate text-base font-black">{occasion.name}</h3>
                              <Show when={occasion.style}>
                                <span class="badge badge-sm badge-outline">
                                  {occasion.style === 'homemade' ? 'homemade' : 'ready-made'}
                                </span>
                              </Show>
                              <Show when={occasion.source === 'discovered'}>
                                <span class="badge badge-sm badge-info gap-1">
                                  <Sparkles size={11} /> suggested
                                </span>
                              </Show>
                            </div>
                            <p class="text-[11px] text-base-content/60">
                              <Show
                                when={occasion.source && occasion.source !== 'detected'}
                                fallback={
                                  <>
                                    feeds ~{occasion.basisServings} · seen {occasion.occurrences}×
                                  </>
                                }
                              >
                                amounts per person
                              </Show>
                              <Show when={occasion.lastSeen}>
                                {' '}
                                · last {new Date(occasion.lastSeen!).toLocaleDateString()}
                              </Show>
                            </p>
                          </div>
                        </div>

                        <Show when={(occasion.evidence ?? []).length > 0}>
                          <p class="text-[11px] text-base-content/65">
                            Because you buy:{' '}
                            {occasion
                              .evidence!.map((entry) => `${entry.label} (${entry.purchaseCount}×)`)
                              .join(', ')}
                          </p>
                        </Show>

                        <div class="space-y-0.5">
                          <For each={occasion.items}>
                            {(item) => (
                              <div class="flex items-center gap-2 text-xs">
                                <span class={`badge badge-xs ${item.core ? 'badge-primary' : 'badge-ghost'}`}>
                                  {item.core ? 'core' : 'optional'}
                                </span>
                                <span class="flex-1 truncate">{item.name}</span>
                                <span class="font-mono text-[10px] text-base-content/60">
                                  {item.qtyPerServing < 10
                                    ? item.qtyPerServing.toFixed(2)
                                    : Math.round(item.qtyPerServing)}{' '}
                                  / person
                                </span>
                              </div>
                            )}
                          </For>
                        </div>

                        <Show when={(occasion.missing ?? []).length > 0}>
                          <p class="text-[11px] text-warning">
                            Not in your history (add yourself): {occasion.missing!.join(', ')}
                          </p>
                        </Show>

                        <Show when={occasion.aliases.length > 0}>
                          <p class="text-[11px] text-base-content/55">
                            Also called: {occasion.aliases.join(', ')}
                          </p>
                        </Show>

                        <Show when={occasion.sourceOrders.length > 0}>
                          <div class="flex flex-wrap gap-1">
                            <For each={occasion.sourceOrders.slice(0, 5)}>
                              {(source) => (
                                <A href={`/order/${source.orderId}`} class="badge badge-ghost badge-sm">
                                  #{source.orderId}
                                </A>
                              )}
                            </For>
                          </div>
                        </Show>

                        <div class="flex flex-wrap items-center gap-2 border-t border-base-200 pt-3">
                          <label class="text-[10px] font-bold uppercase text-base-content/50">For</label>
                          <input
                            type="number"
                            min="1"
                            max="100"
                            class="input input-bordered input-sm w-20"
                            value={servings()[occasion._id] ?? defaultServings(occasion)}
                            onInput={(event) =>
                              setServings((previous) => ({
                                ...previous,
                                [occasion._id]: Number(event.currentTarget.value),
                              }))
                            }
                          />
                          <button
                            class="btn btn-primary btn-sm flex-1 gap-1"
                            onClick={() => fillOccasion(occasion)}
                            disabled={busy()}
                          >
                            <Play size={14} /> Fill for{' '}
                            {servings()[occasion._id] ?? defaultServings(occasion)}
                          </button>
                          <Show when={isDraft(occasion)}>
                            <button
                              class="btn btn-success btn-sm gap-1"
                              onClick={() => confirmOccasion(occasion)}
                              disabled={busy()}
                            >
                              <Check size={14} /> Save
                            </button>
                          </Show>
                          <Show when={occasion.source && occasion.source !== 'detected'}>
                            <button
                              class="btn btn-ghost btn-sm btn-square"
                              title={`Delete ${occasion.name}`}
                              aria-label={`Delete ${occasion.name}`}
                              onClick={() => deleteOccasion(occasion)}
                              disabled={busy()}
                            >
                              <Trash2 size={14} />
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </For>
      </Show>
    </div>
  );
}
