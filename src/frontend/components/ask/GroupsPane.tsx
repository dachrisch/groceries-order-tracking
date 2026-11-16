/**
 * Product groups, with the merge/split corrections the learning rules cannot
 * make on their own. Extracted from `pages/Bot.tsx` so the Ask hub has one
 * implementation of these calls.
 */
import { createSignal, For, onMount, Show } from 'solid-js';
import { AlertCircle, Layers, Play } from 'lucide-solid';

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

export function GroupsPane() {
  const [groups, setGroups] = createSignal<ProductGroup[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedProducts, setSelectedProducts] = createSignal<Set<number>>(new Set<number>());
  const [busy, setBusy] = createSignal(false);

  const loadGroups = async () => {
    try {
      const res = await fetch('/api/bot/groups');
      if (res.ok) setGroups(await res.json());
    } catch (failure) {
      console.error('Could not load product groups', failure);
      setError('Could not load product groups.');
    }
  };

  onMount(() => {
    void loadGroups().finally(() => setLoading(false));
  });

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
        setSelectedProducts(new Set<number>());
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

  return (
    <div class="space-y-3">
      <Show when={error()}>
        <div class="alert alert-error shadow-sm">
          <AlertCircle size={18} />
          <span class="text-sm font-semibold">{error()}</span>
          <button class="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      </Show>

      <div class="alert alert-info shadow-sm">
        <Layers size={18} />
        <span class="text-xs">
          Groups are rebuilt from rules after every sync. Manual groups survive. Select two or more
          products to merge the misses (e.g. Vollmilch vs Weidemilch).
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          class="btn btn-primary btn-xs gap-1"
          onClick={mergeSelected}
          disabled={selectedProducts().size < 2 || busy()}
        >
          <Play size={13} /> Merge selected ({selectedProducts().size})
        </button>
        <Show when={selectedProducts().size > 0}>
          <button class="btn btn-ghost btn-xs" onClick={() => setSelectedProducts(new Set<number>())}>
            Clear
          </button>
        </Show>
      </div>

      <Show when={loading()}>
        <div class="flex justify-center p-12">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      </Show>

      <Show when={!loading()}>
        <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <For each={groups()}>
            {(group) => (
              <div class="card border border-base-300 bg-base-100 shadow-sm">
                <div class="card-body gap-2 p-4">
                  <div class="flex items-center gap-2">
                    <h3 class="flex-1 truncate text-sm font-black">{group.label}</h3>
                    <Show when={group.manual}>
                      <span class="badge badge-secondary badge-sm">manual</span>
                    </Show>
                    <span class="badge badge-ghost badge-sm">{group.productIds.length}</span>
                  </div>
                  <div class="space-y-1">
                    <For each={group.products}>
                      {(product) => (
                        <label class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-base-200/50">
                          <input
                            type="checkbox"
                            class="checkbox checkbox-xs"
                            checked={selectedProducts().has(product._id)}
                            onChange={() => toggleProduct(product._id)}
                          />
                          <span class="flex-1 truncate">{product.name ?? `#${product._id}`}</span>
                          <Show when={product.textualAmount}>
                            <span class="text-[10px] text-base-content/60">{product.textualAmount}</span>
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
