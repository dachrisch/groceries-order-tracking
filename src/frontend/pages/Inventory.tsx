// src/frontend/pages/Inventory.tsx
import { createSignal, onMount, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
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
  priceValidUntil?: string;
  availabilityStatus?: string;
  availabilityReason?: string;
}


interface CartItem {
  productId: number;
  productName: string;
  price: number;
  avgPrice?: number;
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
  const navigate = useNavigate();
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

  const openStepper = (item: InventoryItem) => {
    const id = String(item._id);
    if (addedItems().has(id)) return;
    setReorderingItem(id);
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
        setReorderingItem(null);
      } else {
        showToast('Failed to add item to cart.', 'error');
      }
    } catch {
      showToast('Connection error. Could not add to cart.', 'error');
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
    <div class="space-y-8 pb-48">

      <div class="flex justify-between items-center">
        <div class="animate-fade-in">
          <h1 class="text-4xl font-extrabold tracking-tight">Inventory</h1>
          <p class="text-base-content/85 mt-1">Track your grocery stock levels</p>
        </div>
        <button
          class="btn btn-ghost btn-sm gap-2 rounded-xl"
          onClick={() => Promise.all([fetchInventory(), fetchCart()])}
          disabled={loading() || cartLoading()}
        >
          <RefreshCw size={18} class={loading() || cartLoading() ? 'animate-spin' : ''} />
          <span class="font-bold">Refresh</span>
        </button>
      </div>

      <div class="tabs tabs-box bg-base-100 p-1 rounded-2xl border border-base-300 shadow-sm w-fit">
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${tab() === 'running-out' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'}`}
          onClick={() => setTab('running-out')}
        >
          Running Out
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${tab() === 'reorder' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'}`}
          onClick={() => setTab('reorder')}
        >
          Needs Reorder
        </button>
        <button
          class={`btn btn-sm border-none rounded-xl px-6 ${tab() === 'in-shelf' ? 'btn-primary shadow-md' : 'btn-ghost opacity-85'}`}
          onClick={() => setTab('in-shelf')}
        >
          In Shelf
        </button>
      </div>

      <Show when={error()}>
        <div class="alert alert-error shadow-lg">
          <AlertCircle size={24} />
          <span class="font-bold">{error()}</span>
          <button class="btn btn-sm bg-white/20 border-none hover:bg-white/85" onClick={fetchInventory}>Retry</button>
        </div>
      </Show>

      <Show when={loading() && items().length === 0}>
        <div class="flex justify-center p-24">
          <span class="loading loading-spinner loading-lg text-primary scale-150" />
        </div>
      </Show>

      <Show when={!loading() || items().length > 0}>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          <For each={filteredItems()} fallback={
            <div class="col-span-full flex flex-col items-center justify-center p-20 bg-base-100 rounded-3xl shadow-sm border border-base-300">
              <div class="text-8xl mb-8 opacity-20">🛒</div>
              <h3 class="text-3xl font-black">All stocked up!</h3>
              <p class="text-base-content/75 text-xl mt-2 font-medium">Nothing needs your attention in this category.</p>
            </div>
          }>
            {(item) => {
              const id = String(item._id);
              return (
              <div 
                class={`card bg-base-100 shadow-lg border border-base-300 hover:shadow-2xl transition-all group cursor-pointer hover-lift ${item.availabilityStatus === 'UNAVAILABLE' ? 'opacity-60 grayscale-[0.5]' : ''}`}
                onClick={(e) => {
                  // Only navigate if we didn't click an action element
                  if (!(e.target as HTMLElement).closest('.card-actions')) {
                    navigate(`/products/${item._id}`);
                  }
                }}
              >
                <div class="card-body p-8 flex flex-col h-full relative">
                    <Show when={item.availabilityStatus === 'UNAVAILABLE'}>
                      <div class="absolute top-4 right-4 z-10">
                        <div class="badge badge-error gap-1 font-black py-3 shadow-md uppercase tracking-tighter">
                          Out of Stock
                        </div>
                        <Show when={item.availabilityReason}>
                          <div class="text-[10px] text-right font-black mt-1 text-error uppercase tracking-tighter bg-base-100/80 px-1 rounded">
                            {item.availabilityReason}
                          </div>
                        </Show>
                      </div>
                    </Show>

                    {/* Header: Image + Title Side-by-Side */}
                    <div class="flex items-start gap-5 mb-4">
                      <div class="avatar flex-shrink-0">
                        <div class="mask mask-squircle w-20 h-20 bg-base-200 shadow-md group-hover:scale-110 transition-transform duration-300">
                          <Show when={item.image} fallback={<div class="flex items-center justify-center h-full text-xl opacity-20 font-black">?</div>}>
                            <img src={item.image?.replace('https://www.knuspr.de', 'https://cdn.knuspr.de')} alt={item.name} loading="lazy" />
                          </Show>
                        </div>
                      </div>
                      <div class="min-w-0 flex-1">
                        <h2 class="font-black text-lg leading-tight line-clamp-3 h-20 group-hover:text-primary transition-colors" title={item.name}>
                          {item.name}
                        </h2>
                      </div>
                    </div>

                  {/* Middle: Usage visualization */}
                  <div class="space-y-4 flex-grow mt-2">
                    <Show when={item.categories?.length}>
                      <div class="flex flex-wrap gap-1.5 mt-2">
                        <For each={item.categories?.slice(-1)}>
                          {(cat) => (
                            <span class="badge badge-neutral badge-xs opacity-75 text-[9px] uppercase font-black tracking-widest py-2 px-2">{cat.name}</span>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="relative">
                       <progress
                        class={`progress w-full h-4 rounded-full shadow-inner ${
                          item.daysSinceLast >= item.avgInterval ? 'progress-error' :
                          item.daysSinceLast >= item.avgInterval * REORDER_THRESHOLD ? 'progress-warning' :
                          'progress-success'
                        }`}
                        value={item.daysSinceLast}
                        max={item.avgInterval}
                      />
                    </div>
                    <div class="flex justify-between items-end">
                      <div class="flex flex-col">
                        <span class="text-[10px] font-black uppercase opacity-85 tracking-tighter mb-0.5">Last Refill</span>
                        <span class="text-sm font-bold opacity-95">{Math.round(item.daysSinceLast)}d ago</span>
                      </div>
                      <div class="flex flex-col text-right">
                        <span class="text-[10px] font-black uppercase opacity-85 tracking-tighter mb-0.5">Cycle</span>
                        <span class="text-xs font-medium opacity-90">~{Math.round(item.avgInterval)}d</span>
                      </div>
                    </div>
                  </div>

                  {/* Footer: Action + Price Next to Each Other */}
                  <div class="card-actions items-center gap-3 mt-8 pt-6 border-t border-base-200" onClick={(e) => e.stopPropagation()}>
                    <div class="flex-grow">
                      <Show
                        when={reorderingItem() === id}
                        fallback={
                          <button
                            class={`btn btn-md gap-2 w-full shadow-sm ${addedItems().has(id) ? 'btn-success text-white' : 'btn-primary'}`}
                            onClick={(e) => { e.stopPropagation(); openStepper(item); }}
                            disabled={addedItems().has(id) || item.availabilityStatus === 'UNAVAILABLE'}
                          >
                            <Show when={addedItems().has(id)} fallback={<ShoppingCart size={18} />}>
                              <Check size={18} />
                            </Show>
                            <span class="font-bold">{addedItems().has(id) ? 'In Cart' : 'Reorder'}</span>
                          </button>
                        }
                      >
                        <div class="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
                          <div class="join flex-grow shadow-sm">
                            <button
                              class="btn btn-sm btn-ghost join-item border border-base-300 px-3"
                              onClick={() => adjustQty(id, -1)}
                              disabled={addingToCart()}
                            >−</button>
                            <div class="btn btn-sm btn-ghost no-animation join-item border-y border-base-300 font-mono text-base min-w-[2.5rem]">
                              {pendingQtys().get(id) ?? item.avgQuantity}
                            </div>
                            <button
                              class="btn btn-sm btn-ghost join-item border border-base-300 px-3"
                              onClick={() => adjustQty(id, 1)}
                              disabled={addingToCart()}
                            >+</button>
                          </div>
                          <button
                            class="btn btn-sm btn-primary gap-1 shadow-sm px-4"
                            onClick={() => addToCart(id)}
                            disabled={addingToCart() || item.availabilityStatus === 'UNAVAILABLE'}
                          >
                            <Show when={addingToCart()}>
                              <span class="loading loading-spinner loading-xs" />
                            </Show>
                            <span class="font-bold">Add</span>
                          </button>
                        </div>
                      </Show>
                    </div>

                    <div class="text-right flex-shrink-0 min-w-[70px]">
                      <Show when={item.currentPrice} fallback={
                        <div class="text-lg font-black opacity-10">€--</div>
                      }>
                         <div class="text-xl font-black text-primary leading-none">€{Number(item.currentPrice).toFixed(2)}</div>
                         <Show when={item.priceValidUntil}>
                           <div class="text-[9px] font-bold opacity-60 mt-1 leading-tight">
                             Order by {new Date(item.priceValidUntil!).toLocaleDateString()}
                           </div>
                         </Show>
                         <Show when={Math.abs(Number(item.currentPrice) - item.avgPrice) >= 0.01}>
                           <div class={`text-[10px] font-black flex items-center justify-end gap-0.5 mt-1 ${Number(item.currentPrice) - item.avgPrice > 0 ? 'text-error' : 'text-success'}`}>
                             {Number(item.currentPrice) - item.avgPrice > 0 ? '↑' : '↓'} {Math.abs(Number(item.currentPrice) - item.avgPrice).toFixed(2)}€
                           </div>
                         </Show>
                      </Show>
                    </div>
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
                      return (
                        <div class="flex items-center gap-3 p-3">
                          <div class="avatar flex-shrink-0">
                            <div class="mask mask-squircle w-8 h-8 bg-base-200">
                              <img src={cartItem.imgUrl} alt={cartItem.productName} loading="lazy" />
                            </div>
                          </div>
                          <div class="flex-1 min-w-0">
                            <p class="text-xs font-medium truncate">{cartItem.productName}</p>
                            <p class="text-[10px] opacity-85">
                              €{cartItem.price.toFixed(2)}
                              <Show when={cartItem.avgPrice && Math.abs(cartItem.price - cartItem.avgPrice) > 0.01}>
                                <span class={`ml-2 ${(cartItem.price - cartItem.avgPrice!) > 0 ? 'text-error' : 'text-success'}`}>
                                  {(cartItem.price - cartItem.avgPrice!) > 0 ? '+' : ''}{(cartItem.price - cartItem.avgPrice!).toFixed(2)}€
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
