import { createSignal, onMount, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Bot as BotIcon, ChevronDown, Layers, Play, RefreshCw, Undo2, AlertCircle } from 'lucide-solid';

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
  intent: { type: 'weekly' | 'occasion'; occasion?: string; servings?: number };
  items: BotRunItem[];
  totalPrice: number;
  status: 'in-cart' | 'undone' | 'delivered' | 'partially-delivered';
  matchedOrderId?: number;
  deliveredItemCount?: number;
}

interface GroupProduct {
  _id: number;
  name?: string;
  textualAmount?: string;
  image?: string;
}

interface ProductGroup {
  _id: string;
  key: string;
  label: string;
  productIds: number[];
  manual: boolean;
  products: GroupProduct[];
}

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
  const [groups, setGroups] = createSignal<ProductGroup[]>([]);
  const [occasions, setOccasions] = createSignal<Occasion[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [expandedRun, setExpandedRun] = createSignal<string | null>(null);
  const [selectedProducts, setSelectedProducts] = createSignal<Set<number>>(new Set());
  const [servings, setServings] = createSignal<Record<string, number>>({});
  const [busy, setBusy] = createSignal(false);

  const loadRuns = async () => {
    const res = await fetch('/api/bot/runs');
    if (res.ok) setRuns(await res.json());
  };

  const loadGroups = async () => {
    const res = await fetch('/api/bot/groups');
    if (res.ok) setGroups(await res.json());
  };

  const loadOccasions = async () => {
    const res = await fetch('/api/bot/occasions');
    if (res.ok) setOccasions(await res.json());
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadRuns(), loadGroups(), loadOccasions()]);
    } catch (e) {
      setError('Could not load bot data.');
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  onMount(load);

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

  const toggleProduct = (productId: number) => {
    setSelectedProducts((previous) => {
      const next = new Set(previous);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const mergeSelected = async () => {
    if (selectedProducts().size < 2) return;
    setBusy(true);
    try {
      const res = await fetch('/api/bot/groups/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [...selectedProducts()] }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? 'Merge failed');
      } else {
        setSelectedProducts(new Set());
        await loadGroups();
      }
    } finally {
      setBusy(false);
    }
  };

  const splitProduct = async (group: ProductGroup, productId: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/bot/groups/${group._id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? 'Split failed');
      } else {
        await loadGroups();
      }
    } finally {
      setBusy(false);
    }
  };

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

  const fillOccasion = async (occasion: Occasion) => {
    const count = servings()[occasion._id] ?? occasion.basisServings;
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
        if (!window.confirm(`This adds ${body.items.length} items (~€${Number(body.estimatedTotal).toFixed(2)}). Continue?`)) {
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
        setNotice(`Added ${body.items.length} items for ${occasion.name} (€${Number(body.estimatedTotal).toFixed(2)}).`);
        window.dispatchEvent(new CustomEvent('bot-run-complete'));
      } else if (body.status === 'nothing-to-add') {
        setNotice('Nothing to add — those items are already in your cart.');
      }
      await loadRuns();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="space-y-8 pb-16">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div class="animate-fade-in">
          <h1 class="text-4xl font-extrabold tracking-tight flex items-center gap-3">
            <BotIcon size={34} class="text-primary" /> Bot
          </h1>
          <p class="text-base-content/85 mt-1">What the order bot added, and what it has learned</p>
        </div>
        <button class="btn btn-ghost btn-sm gap-2 rounded-xl" onClick={load} disabled={loading()}>
          <RefreshCw size={18} class={loading() ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div class="tabs tabs-box bg-base-100 p-1 rounded-2xl border border-base-300 shadow-sm w-fit">
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${tab() === 'runs' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'}`}
          onClick={() => setTab('runs')}
        >
          Runs
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${tab() === 'occasions' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'}`}
          onClick={() => setTab('occasions')}
        >
          Occasions
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${tab() === 'groups' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'}`}
          onClick={() => setTab('groups')}
        >
          Product groups
        </button>
      </div>

      <Show when={error()}>
        <div class="alert alert-error shadow-lg">
          <AlertCircle size={22} />
          <span class="font-bold">{error()}</span>
          <button class="btn btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      </Show>

      <Show when={notice()}>
        <div class="alert alert-success shadow-sm">
          <span class="font-semibold">{notice()}</span>
          <button class="btn btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
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
            <div class="card bg-base-100 border border-base-300 p-12 text-center rounded-2xl">
              <h3 class="text-2xl font-black">No bot runs yet</h3>
              <p class="text-base-content/80 mt-2">
                Use the chat panel or the “Fill week” button on the Inventory page.
              </p>
            </div>
          }
        >
          <div class="space-y-4">
            <For each={runs()}>
              {(run) => (
                <div class="card bg-base-100 border border-base-300 shadow-sm rounded-2xl overflow-hidden">
                  <button
                    class="w-full text-left p-5 flex items-center gap-4 hover:bg-base-200/40 transition-colors"
                    onClick={() => setExpandedRun(expandedRun() === run._id ? null : run._id)}
                  >
                    <div class="bg-primary/10 text-primary rounded-xl p-3">
                      <Show when={run.intent.type === 'occasion'} fallback={<BotIcon size={22} />}>
                        <span class="text-xl">🎉</span>
                      </Show>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-black text-lg truncate">
                        {run.intent.type === 'weekly'
                          ? 'Weekly fill'
                          : `${run.intent.occasion ?? 'Occasion'}${run.intent.servings ? ` for ${run.intent.servings}` : ''}`}
                      </div>
                      <div class="text-sm opacity-75">
                        {new Date(run.createdAt).toLocaleString()} · {run.items.length} items · €{run.totalPrice.toFixed(2)}
                      </div>
                    </div>
                    <div class={`badge ${STATUS_CLASSES[run.status]} badge-md font-bold`}>{STATUS_LABELS[run.status]}</div>
                    <ChevronDown size={20} class={`transition-transform ${expandedRun() === run._id ? 'rotate-180' : ''}`} />
                  </button>

                  <Show when={expandedRun() === run._id}>
                    <div class="border-t border-base-200 p-5 space-y-3">
                      <For each={run.items}>
                        {(item) => (
                          <div class="flex items-start gap-3 text-sm">
                            <div class="badge badge-neutral badge-sm font-mono mt-0.5">×{item.qty}</div>
                            <div class="flex-1">
                              <div class="font-semibold">{item.name}</div>
                              <Show when={item.reason}>
                                <div class="opacity-70 text-xs">{item.reason}</div>
                              </Show>
                            </div>
                            <Show when={item.price !== undefined}>
                              <div class="font-mono text-xs opacity-80">€{((item.price ?? 0) * item.qty).toFixed(2)}</div>
                            </Show>
                          </div>
                        )}
                      </For>

                      <div class="flex items-center gap-3 pt-3 border-t border-base-200">
                        <Show when={run.status === 'in-cart'}>
                          <button
                            class="btn btn-sm btn-outline btn-error gap-2"
                            onClick={() => undoRun(run)}
                            disabled={busy()}
                          >
                            <Undo2 size={16} /> Undo
                          </button>
                        </Show>
                        <Show when={run.matchedOrderId}>
                          <A href={`/order/${run.matchedOrderId}`} class="btn btn-sm btn-ghost">
                            Delivered in order #{run.matchedOrderId}
                            <Show when={run.deliveredItemCount !== undefined}>
                              <span class="badge badge-sm">{run.deliveredItemCount}/{run.items.length}</span>
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
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm opacity-75">
            Occasions are learned automatically from baskets that the weekly model cannot explain.
          </p>
          <button class="btn btn-outline btn-sm gap-2" onClick={detectAgain} disabled={busy()}>
            <RefreshCw size={16} class={busy() ? 'animate-spin' : ''} /> Detect again
          </button>
        </div>

        <Show
          when={occasions().length > 0}
          fallback={
            <div class="card bg-base-100 border border-base-300 p-12 text-center rounded-2xl">
              <h3 class="text-2xl font-black">No occasions learned yet</h3>
              <p class="text-base-content/80 mt-2">
                Sync a few orders with repeat occasion baskets (e.g. three pizza nights) and detect again.
              </p>
            </div>
          }
        >
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <For each={occasions()}>
              {(occasion) => (
                <div class="card bg-base-100 border border-base-300 shadow-sm rounded-2xl">
                  <div class="card-body p-5">
                    <div class="flex items-start gap-3">
                      <div class="text-2xl">🎉</div>
                      <div class="flex-1 min-w-0">
                        <h3 class="font-black text-xl truncate">{occasion.name}</h3>
                        <p class="text-xs opacity-70">
                          feeds ~{occasion.basisServings} · seen {occasion.occurrences}×
                          <Show when={occasion.lastSeen}>
                            {' '}· last {new Date(occasion.lastSeen!).toLocaleDateString()}
                          </Show>
                        </p>
                      </div>
                    </div>

                    <div class="mt-3 space-y-1">
                      <For each={occasion.items}>
                        {(item) => (
                          <div class="flex items-center gap-2 text-sm">
                            <span class={`badge badge-xs ${item.core ? 'badge-primary' : 'badge-ghost'}`}>
                              {item.core ? 'core' : 'optional'}
                            </span>
                            <span class="flex-1 truncate">{item.name}</span>
                            <span class="font-mono text-xs opacity-70">
                              {item.qtyPerServing.toFixed(2)} / serving
                            </span>
                          </div>
                        )}
                      </For>
                    </div>

                    <Show when={occasion.aliases.length > 0}>
                      <p class="text-xs opacity-60 mt-2">Also called: {occasion.aliases.join(', ')}</p>
                    </Show>

                    <Show when={occasion.sourceOrders.length > 0}>
                      <div class="flex flex-wrap gap-1 mt-3">
                        <For each={occasion.sourceOrders.slice(0, 5)}>
                          {(source) => (
                            <A href={`/order/${source.orderId}`} class="badge badge-ghost badge-sm">
                              #{source.orderId}
                            </A>
                          )}
                        </For>
                      </div>
                    </Show>

                    <div class="flex items-center gap-2 mt-4 pt-3 border-t border-base-200">
                      <label class="text-xs font-bold uppercase opacity-60">For</label>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        class="input input-bordered input-sm w-20"
                        value={servings()[occasion._id] ?? occasion.basisServings}
                        onInput={(event) =>
                          setServings((previous) => ({
                            ...previous,
                            [occasion._id]: Number(event.currentTarget.value),
                          }))
                        }
                      />
                      <button class="btn btn-primary btn-sm gap-2 flex-1" onClick={() => fillOccasion(occasion)} disabled={busy()}>
                        <Play size={16} /> Fill for {servings()[occasion._id] ?? occasion.basisServings}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={!loading() && tab() === 'groups'}>
        <div class="alert alert-info shadow-sm">
          <Layers size={20} />
          <span>
            Groups are rebuilt from rules after every sync. Manual groups survive. Select two or more products to
            merge the misses (e.g. Vollmilch vs Weidemilch).
          </span>
        </div>

        <div class="flex items-center gap-3">
          <button class="btn btn-primary btn-sm gap-2" onClick={mergeSelected} disabled={selectedProducts().size < 2 || busy()}>
            <Play size={16} /> Merge selected ({selectedProducts().size})
          </button>
          <Show when={selectedProducts().size > 0}>
            <button class="btn btn-ghost btn-sm" onClick={() => setSelectedProducts(new Set())}>Clear</button>
          </Show>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <For each={groups()}>
            {(group) => (
              <div class="card bg-base-100 border border-base-300 shadow-sm rounded-2xl">
                <div class="card-body p-5">
                  <div class="flex items-center gap-2">
                    <h3 class="font-black flex-1 truncate">{group.label}</h3>
                    <Show when={group.manual}>
                      <span class="badge badge-secondary badge-sm">manual</span>
                    </Show>
                    <span class="badge badge-ghost badge-sm">{group.productIds.length}</span>
                  </div>
                  <div class="space-y-1.5 mt-2">
                    <For each={group.products}>
                      {(product) => (
                        <label class="flex items-center gap-2 text-sm cursor-pointer hover:bg-base-200/50 rounded-lg px-2 py-1">
                          <input
                            type="checkbox"
                            class="checkbox checkbox-xs"
                            checked={selectedProducts().has(product._id)}
                            onChange={() => toggleProduct(product._id)}
                          />
                          <span class="flex-1 truncate">{product.name ?? `#${product._id}`}</span>
                          <Show when={product.textualAmount}>
                            <span class="text-xs opacity-60">{product.textualAmount}</span>
                          </Show>
                          <Show when={group.manual}>
                            <button
                              class="btn btn-ghost btn-xs"
                              title="Split out of this manual group"
                              onClick={(event) => {
                                event.preventDefault();
                                splitProduct(group, product._id);
                              }}
                            >
                              Split
                            </button>
                          </Show>
                        </label>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
