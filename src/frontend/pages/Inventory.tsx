// src/frontend/pages/Inventory.tsx
import { createSignal, onMount, For, Show } from 'solid-js';
import { ShoppingCart, AlertCircle, RefreshCw, Check, ExternalLink } from 'lucide-solid';

interface InventoryItem {
  _id: number;
  name: string;
  image?: string;
  categories?: { id: number; name: string; slug: string; level: number }[];
  avgInterval: number;
  daysSinceLast: number;
  avgQuantity: number;
  avgPrice: number;
  currentPrice?: number;
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

  // All interactions with addedItems and pendingQtys use String(item._id) because
  // those Sets/Maps are keyed by string, while InventoryItem._id is numeric from MongoDB.

  const openStepper = (item: InventoryItem) => {
    const id = String(item._id);
    if (addedItems().has(id)) return; // already in cart
    setReorderingItem(id);
    // Intentional: keep qty if stepper was previously opened for this item
    if (!pendingQtys().has(id)) {
      setPendingQtys(prev => new Map(prev).set(id, item.avgQuantity));
    }
  };

  const adjustQty = (itemId: string, delta: number) => {
    const current = pendingQtys().get(itemId) ?? 1;
    const next = Math.max(1, current + delta);
    setPendingQtys(prev => new Map(prev).set(itemId, next));
  };

  const addToCart = async (productId: string) => {
    if (addingToCart()) return;
    const qty = pendingQtys().get(productId) ?? 1;

    setAddingToCart(true);
    try {
      const res = await fetch('/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, count: qty })
      });

      if (res.ok) {
        const data = await res.json();
        setAddedItems(prev => new Set([...prev, productId]));
        if (data.cart) setCart(data.cart);
        showToast('Added to Knuspr cart!');
        setReorderingItem(null);  // collapse stepper only on success
      } else {
        showToast('Failed to add item to cart.', 'error');
        // stepper stays open so user can retry with same qty
      }
    } catch {
      showToast('Connection error. Could not add to cart.', 'error');
      // stepper stays open so user can retry
    } finally {
      setAddingToCart(false);
    }
  };

  onMount(() => Promise.all([fetchInventory(), fetchCart()]));

  const filteredItems = () => {
    const all = items();
    if (tab() === 'running-out') {
      return all.filter(i => i.daysSinceLast >= i.avgInterval * REORDER_THRESHOLD && i.daysSinceLast < i.avgInterval);
    } else if (tab() === 'reorder') {
      return all.filter(i => i.daysSinceLast >= i.avgInterval);
    } else {
      return all.filter(i => i.daysSinceLast < i.avgInterval * REORDER_THRESHOLD);
    }
  };


  return (
    <div class="space-y-6 pb-48">

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
            {(item) => {
              const id = String(item._id);
              return (
              <div class="card bg-base-100 shadow-xl border border-base-300 hover:shadow-2xl transition-shadow">
                <div class="card-body p-5">
                    <div class="flex items-start gap-3">
                      <div class="avatar flex-shrink-0">
                        <div class="mask mask-squircle w-12 h-12 bg-base-200">
                          <Show when={item.image} fallback={<div class="flex items-center justify-center h-full text-xs opacity-30">?</div>}>
                            <img src={item.image?.replace('https://www.knuspr.de', 'https://cdn.knuspr.de')} alt={item.name} loading="lazy" />
                          </Show>
                        </div>
                      </div>
                      <div class="flex-1 min-w-0">
                        <h2 class="font-bold text-sm leading-tight line-clamp-2 h-9" title={item.name}>{item.name}</h2>
                        <Show when={item.categories?.length}>
                          <div class="flex flex-wrap gap-1 mt-1">
                            <For each={item.categories?.slice(-2)}>
                              {(cat) => (
                                <span class="badge badge-ghost badge-xs opacity-70 text-[9px] uppercase font-semibold">{cat.name}</span>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                      <div class="text-right flex-shrink-0">
                        <Show when={item.currentPrice} fallback={
                          <div class="text-sm font-bold opacity-20">€--</div>
                        }>
                           <div class="text-sm font-bold">€{item.currentPrice?.toFixed(2)}</div>
                           <Show when={Math.abs((item.currentPrice ?? 0) - item.avgPrice) >= 0.01}>
                             <div class={`text-[10px] font-bold ${(item.currentPrice ?? 0) - item.avgPrice > 0 ? 'text-error' : 'text-success'}`}>
                               {(item.currentPrice ?? 0) - item.avgPrice > 0 ? '↑' : '↓'} {Math.abs((item.currentPrice ?? 0) - item.avgPrice).toFixed(2)}€
                             </div>
                           </Show>
                        </Show>
                      </div>
                    </div>

                  <div class="space-y-2 mt-4">
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
                    <Show
                      when={reorderingItem() === id}
                      fallback={
                        <button
                          class={`btn btn-sm gap-2 ${addedItems().has(id) ? 'btn-success' : 'btn-primary'}`}
                          onClick={() => openStepper(item)}
                          disabled={addedItems().has(id)}
                        >
                          <Show when={addedItems().has(id)} fallback={<ShoppingCart size={16} />}>
                            <Check size={16} />
                          </Show>
                          {addedItems().has(id) ? 'Added' : 'Reorder'}
                        </button>
                      }
                    >
                      <div class="flex items-center gap-1">
                        <button
                          class="btn btn-sm btn-ghost btn-square"
                          onClick={() => adjustQty(id, -1)}
                          disabled={addingToCart()}
                        >−</button>
                        <span class="w-8 text-center font-mono text-sm">
                          {pendingQtys().get(id) ?? item.avgQuantity}
                        </span>
                        <button
                          class="btn btn-sm btn-ghost btn-square"
                          onClick={() => adjustQty(id, 1)}
                          disabled={addingToCart()}
                        >+</button>
                        <button
                          class="btn btn-sm btn-primary gap-1"
                          onClick={() => addToCart(id)}
                          disabled={addingToCart()}
                        >
                          <Show when={addingToCart()}>
                            <span class="loading loading-spinner loading-xs" />
                          </Show>
                          Add
                        </button>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Sticky Bottom Cart Container */}
      <Show when={cart() || cartLoading()}>
        <div class="fixed bottom-0 left-0 right-0 z-40 px-4 pb-4 pointer-events-none">
          <div class="max-w-7xl mx-auto flex justify-end">
            <div class="card bg-base-100 border border-base-300 shadow-2xl w-full md:w-96 pointer-events-auto overflow-hidden">
              <div class="card-body p-0">
                {/* Header (Expandable maybe? For now just summary) */}
                <div class="bg-primary text-primary-content p-4 flex items-center justify-between cursor-pointer" onClick={() => {
                  const el = document.getElementById('cart-items-drawer');
                  if (el) el.classList.toggle('hidden');
                }}>
                  <div class="flex items-center gap-2 font-bold">
                    <ShoppingCart size={20} />
                    <span>€{cart()?.totalPrice.toFixed(2) ?? '0.00'}</span>
                    <span class="badge badge-sm badge-ghost">{(cart()?.items.length ?? 0)}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <Show when={cartLoading()}>
                      <span class="loading loading-spinner loading-xs" />
                    </Show>
                    <a
                      href="https://www.knuspr.de/bestellung/mein-warenkorb"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="btn btn-xs btn-outline btn-ghost border-white/20 hover:border-white/40 text-white gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open <ExternalLink size={12} />
                    </a>
                  </div>
                </div>

                {/* Collapsible item list */}
                <div id="cart-items-drawer" class="max-h-80 overflow-y-auto divide-y divide-base-300 bg-base-100 hidden">
                  <For each={cart()?.items}>
                    {(cartItem) => {
                      const invItem = items().find(i => String(i._id) === String(cartItem.productId));
                      const diff = invItem ? cartItem.price - invItem.avgPrice : 0;

                      return (
                        <div class="flex items-center gap-3 p-3">
                          <div class="avatar flex-shrink-0">
                            <div class="mask mask-squircle w-8 h-8 bg-base-200">
                              <img src={cartItem.imgUrl} alt={cartItem.productName} loading="lazy" />
                            </div>
                          </div>
                          <div class="flex-1 min-w-0">
                            <p class="text-xs font-medium truncate">{cartItem.productName}</p>
                            <p class="text-[10px] opacity-60">
                              €{cartItem.price.toFixed(2)}
                              <Show when={invItem && Math.abs(diff) > 0.01}>
                                <span class={`ml-2 ${diff > 0 ? 'text-error' : 'text-success'}`}>
                                  {diff > 0 ? '+' : ''}{diff.toFixed(2)}€
                                </span>
                              </Show>
                            </p>
                          </div>
                          <div class="text-right flex-shrink-0 text-xs font-semibold">
                            ×{cartItem.quantity}
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </div>
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
