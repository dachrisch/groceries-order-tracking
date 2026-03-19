// src/frontend/pages/Inventory.tsx
import { createSignal, onMount, For, Show } from 'solid-js';
import { ShoppingCart, AlertCircle, RefreshCw, Check, ExternalLink } from 'lucide-solid';

interface InventoryItem {
  _id: number;  // MongoDB aggregation returns numeric IDs — use String(_id) when keying addedItems/pendingQtys
  name: string;
  image?: string;
  avgInterval: number;
  daysSinceLast: number;
  avgQuantity: number;
}

interface CartItem {
  productId: number;
  productName: string;
  price: number;
  quantity: number;
  imgUrl: string;
  textualAmount: string;
  multipack?: { price: number; savedPercents: number; needAmount: number };
}

interface Cart {
  cartId: number;
  totalPrice: number;
  totalSavings: number;
  items: CartItem[];
}

const REORDER_THRESHOLD = 0.7;

export function Inventory() {
  const [items, setItems] = createSignal<InventoryItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [cartLoading, setCartLoading] = createSignal(false);
  const [reorderingItem, setReorderingItem] = createSignal<string | null>(null);
  const [addingToCart, setAddingToCart] = createSignal(false);
  const [pendingQtys, setPendingQtys] = createSignal<Map<string, number>>(new Map());
  const [error, setError] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal('running-out');
  const [toast, setToast] = createSignal<{ message: string; type: 'success' | 'error' } | null>(null);
  const [addedItems, setAddedItems] = createSignal<Set<string>>(new Set());
  const [cart, setCart] = createSignal<Cart | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchInventory = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory');
      if (res.ok) {
        setItems(await res.json());
      } else {
        setError('Failed to fetch inventory items. Please try again later.');
      }
    } catch (e) {
      setError('An error occurred while connecting to the server.');
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchCart = async () => {
    setCartLoading(true);
    try {
      const res = await fetch('/api/cart');
      if (res.ok) {
        const data = await res.json();
        if (data.cart) {
          setCart(data.cart);
          setAddedItems(new Set(
            (data.cart as Cart).items.map((i: CartItem) => String(i.productId))
          ));
        }
      }
    } catch {
      // silent fail — cart is best-effort
    } finally {
      setCartLoading(false);
    }
  };

  const reorder = async (productId: string) => {
    if (reorderingItem() || addedItems().has(productId)) return;

    setReorderingItem(productId);
    setAddingToCart(true);
    try {
      const res = await fetch('/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, count: 1 })
      });

      if (res.ok) {
        const data = await res.json();
        setAddedItems(prev => new Set([...prev, productId]));
        if (data.cart) setCart(data.cart);
        showToast('Added to Knuspr cart!');
      } else {
        showToast('Failed to add item to cart.', 'error');
      }
    } catch {
      showToast('Connection error. Could not add to cart.', 'error');
    } finally {
      setReorderingItem(null);
      setAddingToCart(false);
    }
  };

  onMount(() => Promise.all([fetchInventory(), fetchCart()]));

  const filteredItems = () => {
    const all = items();
    if (tab() === 'running-out') {
      return all.filter(i => i.daysSinceLast >= i.avgInterval * REORDER_THRESHOLD && i.daysSinceLast < i.avgInterval);
    }
    if (tab() === 'reorder') {
      return all.filter(i => i.daysSinceLast >= i.avgInterval);
    }
    return all.filter(i => i.daysSinceLast < i.avgInterval * REORDER_THRESHOLD);
  };

  return (
    <div class="space-y-6">
      <div class="flex justify-between items-center">
        <h1 class="text-3xl font-bold">Inventory</h1>
        <button
          class="btn btn-ghost btn-sm gap-2"
          onClick={() => Promise.all([fetchInventory(), fetchCart()])}
          disabled={loading() || cartLoading()}
        >
          <RefreshCw size={16} class={loading() || cartLoading() ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div class="tabs tabs-boxed">
        <button
          class={`tab ${tab() === 'running-out' ? 'tab-active' : ''}`}
          onClick={() => setTab('running-out')}
        >
          Running Out
        </button>
        <button
          class={`tab ${tab() === 'reorder' ? 'tab-active' : ''}`}
          onClick={() => setTab('reorder')}
        >
          Needs Reorder
        </button>
        <button
          class={`tab ${tab() === 'in-shelf' ? 'tab-active' : ''}`}
          onClick={() => setTab('in-shelf')}
        >
          In Shelf
        </button>
      </div>

      <Show when={error()}>
        <div class="alert alert-error">
          <AlertCircle size={20} />
          <span>{error()}</span>
          <button class="btn btn-sm btn-ghost" onClick={fetchInventory}>Retry</button>
        </div>
      </Show>

      <Show when={loading() && items().length === 0}>
        <div class="flex justify-center p-12">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      </Show>

      <Show when={!loading() || items().length > 0}>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <For each={filteredItems()} fallback={
            <div class="col-span-full flex flex-col items-center justify-center p-12 bg-base-100 rounded-xl shadow-sm border border-base-300">
              <div class="text-6xl mb-4">🛒</div>
              <h3 class="text-xl font-bold">No items found</h3>
              <p class="text-base-content/60">All your groceries in this category are well stocked.</p>
            </div>
          }>
            {(item) => (
              <div class="card bg-base-100 shadow-xl border border-base-300 hover:shadow-2xl transition-shadow">
                <div class="card-body">
                  <div class="flex items-center gap-3">
                    <div class="avatar flex-shrink-0">
                      <div class="mask mask-squircle w-12 h-12 bg-base-200">
                        <Show when={item.image} fallback={<div class="flex items-center justify-center h-full text-xs opacity-30">?</div>}>
                          <img src={item.image} alt={item.name} loading="lazy" />
                        </Show>
                      </div>
                    </div>
                    <h2 class="card-title text-lg leading-tight">{item.name}</h2>
                  </div>
                  <div class="space-y-2 mt-2">
                    <progress
                      class={`progress w-full ${
                        item.daysSinceLast >= item.avgInterval ? 'progress-error' :
                        item.daysSinceLast >= item.avgInterval * REORDER_THRESHOLD ? 'progress-warning' :
                        'progress-success'
                      }`}
                      value={item.daysSinceLast}
                      max={item.avgInterval}
                    />
                    <p class="text-xs opacity-60">
                      Last ordered {Math.round(item.daysSinceLast)} days ago (avg. every {Math.round(item.avgInterval)} days)
                    </p>
                  </div>
                  <div class="card-actions justify-end mt-4">
                    <button
                      class={`btn btn-sm gap-2 ${addedItems().has(String(item._id)) ? 'btn-success' : 'btn-primary'}`}
                      onClick={() => reorder(String(item._id))}
                      disabled={reorderingItem() === String(item._id) || addedItems().has(String(item._id))}
                    >
                      <Show when={reorderingItem() === String(item._id)}>
                        <span class="loading loading-spinner loading-xs" />
                      </Show>
                      <Show when={!reorderingItem() && addedItems().has(String(item._id))}>
                        <Check size={16} />
                      </Show>
                      <Show when={!reorderingItem() && !addedItems().has(String(item._id))}>
                        <ShoppingCart size={16} />
                      </Show>
                      {reorderingItem() === String(item._id) ? 'Adding...' : addedItems().has(String(item._id)) ? 'Added' : 'Reorder'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Cart Loading Skeleton */}
      <Show when={cartLoading()}>
        <div class="card bg-base-100 border border-base-300 shadow-xl">
          <div class="card-body">
            <div class="skeleton h-6 w-40 mb-4" />
            <div class="space-y-3">
              <div class="flex items-center gap-3">
                <div class="skeleton w-10 h-10 rounded-lg shrink-0" />
                <div class="flex-1 space-y-2">
                  <div class="skeleton h-4 w-full" />
                  <div class="skeleton h-3 w-24" />
                </div>
                <div class="skeleton h-5 w-14" />
              </div>
              <div class="flex items-center gap-3">
                <div class="skeleton w-10 h-10 rounded-lg shrink-0" />
                <div class="flex-1 space-y-2">
                  <div class="skeleton h-4 w-3/4" />
                  <div class="skeleton h-3 w-20" />
                </div>
                <div class="skeleton h-5 w-14" />
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Cart Summary */}
      <Show when={cart()}>
        {(c) => (
          <div class="card bg-base-100 border border-base-300 shadow-xl">
            <div class="card-body">
              <div class="flex items-center justify-between mb-4">
                <h2 class="card-title text-xl">
                  <ShoppingCart size={20} />
                  Your Knuspr Cart
                  <span class="badge badge-primary">{c().items.length}</span>
                </h2>
                <a
                  href="https://www.knuspr.de/bestellung/mein-warenkorb"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="btn btn-outline btn-sm gap-2"
                >
                  Open on Knuspr
                  <ExternalLink size={14} />
                </a>
              </div>

              <div class="divide-y divide-base-300">
                <For each={c().items}>
                  {(cartItem) => (
                    <div class="flex items-center gap-3 py-3">
                      <div class="avatar flex-shrink-0">
                        <div class="mask mask-squircle w-10 h-10 bg-base-200">
                          <img src={cartItem.imgUrl} alt={cartItem.productName} loading="lazy" />
                        </div>
                      </div>
                      <div class="flex-1 min-w-0">
                        <p class="font-medium truncate">{cartItem.productName}</p>
                        <p class="text-xs opacity-60">{cartItem.textualAmount}</p>
                        <Show when={cartItem.multipack}>
                          {(mp) => (
                            <span class="badge badge-warning badge-xs mt-1">
                              {mp().needAmount} for €{mp().price.toFixed(2)}&nbsp;−{Math.round(mp().savedPercents)}%
                            </span>
                          )}
                        </Show>
                      </div>
                      <div class="text-right flex-shrink-0">
                        <p class="font-semibold">€{cartItem.price.toFixed(2)}</p>
                        <p class="text-xs opacity-60">×{cartItem.quantity}</p>
                      </div>
                    </div>
                  )}
                </For>
              </div>

              <div class="divider my-2" />
              <div class="flex justify-between items-center">
                <span class="text-base-content/60 text-sm">Total</span>
                <span class="text-xl font-bold">€{c().totalPrice.toFixed(2)}</span>
              </div>
              <Show when={c().totalSavings > 0}>
                <div class="flex justify-between items-center text-success text-sm">
                  <span>You save</span>
                  <span>−€{c().totalSavings.toFixed(2)}</span>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Toast Notification */}
      <Show when={toast()}>
        <div class="toast toast-end z-50">
          <div class={`alert ${toast()?.type === 'success' ? 'alert-success' : 'alert-error'} shadow-lg text-white`}>
            <Show when={toast()?.type === 'success'} fallback={<AlertCircle size={20} />}>
              <ShoppingCart size={20} />
            </Show>
            <span>{toast()?.message}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
