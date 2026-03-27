import { createSignal, onMount, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Calendar, ShoppingBag, ChevronRight } from 'lucide-solid';

interface OrderSummary {
  id: number;
  priceComposition: { total: { amount: number } };
  orderTimeDate: string;
  itemsCount: number;
  state: string;
}

export function Orders() {
  const [orders, setOrders] = createSignal<OrderSummary[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const res = await fetch('/api/orders');
      if (res.ok) {
        const json = await res.json();
        setOrders(json);
      }
    } catch (e) {
      console.error('Failed to fetch orders', e);
    } finally {
      setLoading(false);
    }
  });

  return (
    <div class="space-y-8 max-w-6xl mx-auto">
      <div class="animate-fade-in">
        <h1 class="page-title">Your Orders</h1>
        <p class="text-base-content/60 mt-1">Browse and manage your order history</p>
      </div>

      <Show when={!loading()} fallback={
        <div class="flex justify-center items-center py-20">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      }>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <For each={orders()}>
            {(order) => (
              <div class="card bg-base-100 shadow-md hover:shadow-xl transition-all duration-300 border border-base-200/50 hover:border-primary/20 rounded-2xl hover-lift group">
                <div class="card-body p-6">
                  <div class="flex justify-between items-start mb-4">
                    <div class="bg-primary/10 p-3 rounded-xl text-primary group-hover:bg-primary group-hover:text-primary-content transition-colors">
                      <ShoppingBag size={22} />
                    </div>
                    <div class="text-right">
                      <div class="text-xs opacity-40 font-mono">#{order.id}</div>
                      <div class="font-bold text-xl text-primary">{order.priceComposition.total.amount.toFixed(2)}€</div>
                    </div>
                  </div>
                  
                  <div class="flex items-center gap-2 text-sm text-base-content/70 mb-4">
                    <Calendar size={16} class="text-secondary/60" />
                    <span>{new Date(order.orderTimeDate).toLocaleDateString(undefined, { 
                      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
                    })}</span>
                  </div>

                  <div class="flex justify-between items-center text-sm text-base-content/60 mb-6">
                    <span class="font-medium">{order.itemsCount} items</span>
                    <span class="px-3 py-1 rounded-full bg-base-200/60 text-xs font-medium capitalize">{order.state}</span>
                  </div>

                  <div class="card-actions justify-end">
                    <A href={`/order/${order.id}`} class="btn btn-primary btn-sm gap-2 rounded-xl">
                      View Items <ChevronRight size={16} />
                    </A>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
        
        <Show when={orders().length === 0}>
          <div class="card bg-base-100 shadow-md border border-base-200/50 p-12 text-center">
            <div class="flex flex-col items-center gap-4">
              <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary/40">
                <ShoppingBag size={32} />
              </div>
              <div>
                <h3 class="text-lg font-semibold text-neutral">No orders yet</h3>
                <p class="text-base-content/60">Use the Import page to fetch your data.</p>
              </div>
              <A href="/settings" class="btn btn-primary btn-sm rounded-xl">Connect Knuspr</A>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
