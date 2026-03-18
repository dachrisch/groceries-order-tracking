import { createSignal, onMount, For, Show } from 'solid-js';
import { ShoppingCart, Check, RefreshCw } from 'lucide-solid';

export function Inventory() {
  const [items, setItems] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [tab, setTab] = createSignal('running-out');

  const fetchInventory = async () => {
    try {
      const res = await fetch('/api/inventory');
      if (res.ok) setItems(await res.json());
    } finally {
      setLoading(false);
    }
  };

  const reorder = async (productId: string) => {
    // Implement reorder logic with toast notification
    const res = await fetch('/api/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, count: 1 })
    });
    if (res.ok) alert('Added to Knuspr cart!');
    else alert('Failed to add to cart.');
  };

  onMount(fetchInventory);

  const filteredItems = () => {
    const all = items();
    if (tab() === 'running-out') return all.filter(i => i.daysSinceLast >= i.avgInterval * 0.7 && i.daysSinceLast < i.avgInterval);
    if (tab() === 'reorder') return all.filter(i => i.daysSinceLast >= i.avgInterval);
    return all.filter(i => i.daysSinceLast < i.avgInterval * 0.7);
  };

  return (
    <div class="space-y-6">
      <div class="tabs tabs-boxed">
        <a class={`tab ${tab() === 'running-out' ? 'tab-active' : ''}`} onClick={() => setTab('running-out')}>Running Out</a>
        <a class={`tab ${tab() === 'reorder' ? 'tab-active' : ''}`} onClick={() => setTab('reorder')}>Needs Reorder</a>
        <a class={`tab ${tab() === 'in-shelf' ? 'tab-active' : ''}`} onClick={() => setTab('in-shelf')}>In Shelf</a>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <For each={filteredItems()}>
          {(item) => (
            <div class="card bg-base-100 shadow-xl">
              <div class="card-body">
                <h2 class="card-title">{item.name}</h2>
                <progress class="progress progress-primary w-56" value={item.daysSinceLast} max={item.avgInterval}></progress>
                <div class="card-actions justify-end">
                  <button class="btn btn-primary btn-sm" onClick={() => reorder(item._id)}>
                    <ShoppingCart size={16} /> Reorder
                  </button>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
