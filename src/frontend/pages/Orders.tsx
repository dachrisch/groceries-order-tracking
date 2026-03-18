import { createSignal, onMount, For, Show } from 'solid-js';
import { useNavigate, A } from '@solidjs/router';
import { Calendar, ShoppingBag, ChevronRight } from 'lucide-solid';

export function Orders() {
  const [orders, setOrders] = createSignal<any[]>([]);
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
    <div class="space-y-8">
      <h1 class="text-3xl font-bold">Your Orders</h1>

      <Show when={!loading()} fallback={<span class="loading loading-spinner loading-lg"></span>}>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <For each={orders()}>
            {(order) => (
              <div class="card bg-base-100 shadow-xl hover:shadow-2xl transition-shadow border border-base-300">
                <div class="card-body p-6">
                  <div class="flex justify-between items-start mb-4">
                    <div class="bg-primary/10 p-3 rounded-lg text-primary">
                      <ShoppingBag size={24} />
                    </div>
                    <div class="text-right">
                      <div class="text-xs opacity-50 font-mono">#{order.id}</div>
                      <div class="font-bold text-lg">{order.priceComposition.total.amount.toFixed(2)}€</div>
                    </div>
                  </div>
                  
                  <div class="flex items-center gap-2 text-sm mb-4">
                    <Calendar size={16} class="opacity-50" />
                    <span>{new Date(order.orderTimeDate).toLocaleDateString(undefined, { 
                      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' 
                    })}</span>
                  </div>

                  <div class="flex justify-between items-center text-sm opacity-70 mb-6">
                    <span>{order.itemsCount} items</span>
                    <span>{order.state}</span>
                  </div>

                  <div class="card-actions justify-end">
                    <A href={`/products?orderId=${order.id}`} class="btn btn-primary btn-sm gap-2">
                      View Items <ChevronRight size={16} />
                    </A>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
        
        <Show when={orders().length === 0}>
          <div class="alert alert-info">
            <span>No orders found. Use the Import page to fetch your data.</span>
          </div>
        </Show>
      </Show>
    </div>
  );
}
