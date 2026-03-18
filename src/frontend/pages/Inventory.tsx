// src/frontend/pages/Inventory.tsx
import { createSignal, onMount, For, Show } from 'solid-js';
import { ShoppingCart, AlertCircle, RefreshCw } from 'lucide-solid';

interface InventoryItem {
  _id: string;
  name: string;
  avgInterval: number;
  daysSinceLast: number;
}

const REORDER_THRESHOLD = 0.7;

export function Inventory() {
  const [items, setItems] = createSignal<InventoryItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [reordering, setReordering] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal('running-out');
  const [toast, setToast] = createSignal<{ message: string; type: 'success' | 'error' } | null>(null);

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

  const reorder = async (productId: string) => {
    if (reordering()) return;
    
    setReordering(productId);
    try {
      const res = await fetch('/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, count: 1 })
      });
      
      if (res.ok) {
        showToast('Successfully added to Knuspr cart!');
      } else {
        showToast('Failed to add item to cart.', 'error');
      }
    } catch {
      showToast('Connection error. Could not add to cart.', 'error');
    } finally {
      setReordering(null);
    }
  };

  onMount(fetchInventory);

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
          onClick={fetchInventory}
          disabled={loading()}
        >
          <RefreshCw size={16} class={loading() ? 'animate-spin' : ''} />
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
                  <h2 class="card-title text-lg">{item.name}</h2>
                  <div class="space-y-2 mt-2">
                    <div class="flex justify-between text-xs opacity-60">
                      <span>Usage</span>
                      <span>{Math.round((item.daysSinceLast / item.avgInterval) * 100)}%</span>
                    </div>
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
                      Last ordered {item.daysSinceLast} days ago (avg. every {Math.round(item.avgInterval)} days)
                    </p>
                  </div>
                  <div class="card-actions justify-end mt-4">
                    <button 
                      class="btn btn-primary btn-sm gap-2" 
                      onClick={() => reorder(item._id)}
                      disabled={reordering() === item._id}
                    >
                      <Show when={reordering() === item._id} fallback={<ShoppingCart size={16} />}>
                        <span class="loading loading-spinner loading-xs" />
                      </Show>
                      {reordering() === item._id ? 'Adding...' : 'Reorder'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
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