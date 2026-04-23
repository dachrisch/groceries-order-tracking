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
    <div class="space-y-10">
      <div class="flex flex-col gap-2 animate-fade-in">
        <h1 class="text-4xl font-extrabold tracking-tight">Your Orders</h1>
        <p class="text-base-content/85 text-lg">Detailed history of all synced Knuspr orders</p>
      </div>

      <Show when={!loading()} fallback={
        <div class="flex justify-center p-24">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      }>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-8">
          <For each={orders()}>
            {(order) => (
              <div class="card bg-base-100 shadow-md border border-base-300 hover:shadow-2xl transition-all hover:-translate-y-1 overflow-hidden hover-lift group">
                <div class="card-body p-8">
                  <div class="flex justify-between items-start mb-6">
                    <div class="bg-primary/10 p-4 rounded-2xl text-primary shadow-sm ring-1 ring-primary/20 group-hover:bg-primary group-hover:text-primary-content transition-colors">
                      <ShoppingBag size={28} />
                    </div>
                    <div class="text-right">
                      <div class="text-[10px] font-black opacity-85 uppercase tracking-widest mb-1">Order ID</div>
                      <div class="text-xs font-mono font-bold opacity-85">#{order.id}</div>
                    </div>
                  </div>
                  
                  <div class="space-y-4">
                    <div class="flex flex-col">
                      <div class="text-3xl font-black text-primary mb-1">{order.priceComposition.total.amount.toFixed(2)}€</div>
                      <div class="flex items-center gap-2 text-xs font-semibold opacity-85">
                        <Calendar size={14} />
                        <span>{new Date(order.orderTimeDate).toLocaleDateString(undefined, { 
                          year: 'numeric', month: 'short', day: 'numeric'
                        })}</span>
                      </div>
                    </div>

                    <div class="divider my-0 opacity-10" />

                    <div class="flex justify-between items-center text-sm font-medium">
                      <div class="flex flex-col">
                        <span class="text-[10px] uppercase opacity-40 font-bold tracking-tighter">Items</span>
                        <span>{order.itemsCount} products</span>
                      </div>
                      <div class="flex flex-col text-right">
                        <span class="text-[10px] uppercase opacity-40 font-bold tracking-tighter">Status</span>
                        <span class="badge badge-outline badge-sm font-bold uppercase py-2 tracking-wider text-[9px]">{order.state}</span>
                      </div>
                    </div>
                  </div>

                  <div class="card-actions justify-end mt-8 pt-4 border-t border-base-200">
                    <A href={`/order/${order.id}`} class="btn btn-primary btn-md gap-3 flex-grow shadow-md rounded-xl">
                      View Order Details <ChevronRight size={20} />
                    </A>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
        
        <Show when={orders().length === 0}>
          <div class="card bg-base-100 shadow-md border border-base-300 p-12 text-center rounded-2xl">
            <div class="flex flex-col items-center gap-4">
              <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary/40">
                <ShoppingBag size={32} />
              </div>
              <div>
                <h3 class="text-2xl font-black text-neutral">No orders yet</h3>
                <p class="text-base-content/85 text-lg">Use the Import page to fetch your data.</p>
              </div>
              <A href="/settings" class="btn btn-primary btn-md rounded-xl px-8 mt-2">Connect Knuspr</A>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
