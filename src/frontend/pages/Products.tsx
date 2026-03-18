import { createSignal, onMount, For, Show, createEffect } from 'solid-js';
import { Chart, Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController } from 'chart.js';
import { Line } from 'solid-chartjs';
import { useSearchParams, A } from '@solidjs/router';
import { ArrowLeft, ExternalLink, X } from 'lucide-solid';

export function Products() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [trends, setTrends] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchSignal] = createSignal('');
  const [selectedItem, setSelectedItem] = createSignal<any>(null);
  const [orderDetail, setOrderDetail] = createSignal<any>(null);

  const orderId = () => searchParams.orderId;

  onMount(async () => {
    try {
      const [trendsRes, orderRes] = await Promise.all([
        fetch('/api/product-trends'),
        orderId() ? fetch(`/api/orders/${orderId()}`) : Promise.resolve(null)
      ]);

      if (trendsRes.ok) {
        const json = await trendsRes.json();
        setTrends(json);
      }

      if (orderRes && orderRes.ok) {
        const json = await orderRes.json();
        setOrderDetail(json);
      }
    } catch (e) {
      console.error('Failed to fetch data', e);
    } finally {
      setLoading(false);
    }
  });

  const filteredTrends = () => {
    let items = trends();
    
    if (orderId() && orderDetail()) {
      const orderItemIds = new Set(orderDetail().items.map((i: any) => i.id));
      items = items.filter(item => orderItemIds.has(item._id.id));
    }

    const term = searchTerm().toLowerCase();
    if (term) {
      items = items.filter(item => 
        item._id.name.toLowerCase().includes(term) || 
        String(item._id.id).includes(term)
      );
    }
    return items;
  };

  const getChartData = (item: any) => {
    const sortedPrices = [...item.prices].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    return {
      labels: sortedPrices.map(p => new Date(p.date).toLocaleDateString()),
      datasets: [
        {
          label: 'Unit Price (EUR)',
          data: sortedPrices.map(p => p.unitPrice),
          borderColor: 'rgb(54, 162, 235)',
          tension: 0.1,
          pointRadius: 5,
          pointHoverRadius: 8,
        }
      ]
    };
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (context: any) => `${context.parsed.y.toFixed(2)}€`
        }
      }
    },
    scales: {
      y: {
        beginAtZero: false,
        ticks: {
          callback: (value: any) => `${value.toFixed(2)}€`
        }
      }
    }
  };

  return (
    <div class="space-y-8">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h1 class="text-3xl font-bold">{orderId() ? `Order Detail` : 'Product Trends'}</h1>
        
        <Show when={orderId()}>
          <div class="flex items-center gap-4">
            <A href="/orders" class="btn btn-ghost btn-sm gap-2">
              <ArrowLeft size={16} /> Back to Orders
            </A>
            <div class="badge badge-primary badge-lg gap-2 py-4">
              Order #{orderId()}
              <button onClick={() => setSearchParams({ orderId: undefined })} class="hover:text-error transition-colors">
                <X size={14} />
              </button>
            </div>
          </div>
        </Show>
      </div>

      <Show when={orderId() && orderDetail()}>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="stats shadow bg-base-100 border border-base-300">
            <div class="stat">
              <div class="stat-title">Total Amount</div>
              <div class="stat-value text-primary">{orderDetail().priceComposition.total.amount.toFixed(2)}€</div>
              <div class="stat-desc">{orderDetail().itemsCount} items total</div>
            </div>
          </div>
          
          <div class="stats shadow bg-base-100 border border-base-300">
            <div class="stat">
              <div class="stat-title">Order Date</div>
              <div class="stat-value text-sm whitespace-normal">
                {new Date(orderDetail().orderTimeDate).toLocaleDateString(undefined, { 
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
                })}
              </div>
              <div class="stat-desc">{new Date(orderDetail().orderTimeDate).toLocaleTimeString()}</div>
            </div>
          </div>

          <div class="stats shadow bg-base-100 border border-base-300">
            <div class="stat">
              <div class="stat-title">Delivery Address</div>
              <div class="stat-desc whitespace-normal text-base-content font-medium mt-1">
                {orderDetail().address}
              </div>
            </div>
          </div>
        </div>
      </Show>

      <div class="form-control">
        <input 
          type="text" 
          placeholder="Search products..." 
          class="input input-bordered w-full max-w-md" 
          onInput={(e) => setSearchSignal(e.currentTarget.value)}
        />
      </div>

      <Show when={!loading()} fallback={<span class="loading loading-spinner loading-lg"></span>}>
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div class="card bg-base-100 shadow-xl overflow-hidden">
            <div class="max-h-[600px] overflow-y-auto">
              <table class="table table-pin-rows">
                <thead>
                  <tr>
                    <th>Product</th>
                    <Show when={orderId()} fallback={<th>Purchases</th>}>
                      <th>Amount</th>
                    </Show>
                    <th>{orderId() ? 'Order Price' : 'Latest Price'}</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredTrends()}>
                    {(item) => {
                      const latestPrice = [...item.prices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                      
                      // Find specific price in this order if orderId is set
                      let orderPrice = latestPrice.unitPrice;
                      let orderAmount: string | number = item.count;
                      
                      if (orderId() && orderDetail()) {
                        const orderItem = orderDetail().items.find((i: any) => i.id === item._id.id);
                        if (orderItem) {
                          orderPrice = orderItem.priceComposition.unit.amount;
                          orderAmount = `${orderItem.amount}${orderItem.textualAmount ? ` (${orderItem.textualAmount})` : ''}`;
                        }
                      }

                      return (
                        <tr class={selectedItem()?._id.id === item._id.id ? 'bg-base-200' : ''}>
                          <td>
                            <div class="flex items-center gap-3">
                              <div class="avatar">
                                <div class="mask mask-squircle w-12 h-12 bg-base-200">
                                  <Show when={item.image} fallback={<div class="flex items-center justify-center h-full text-xs text-opacity-30">No Image</div>}>
                                    <img src={item.image} alt={item._id.name} loading="lazy" />
                                  </Show>
                                </div>
                              </div>
                              <div>
                                <div class="font-bold max-w-[150px] md:max-w-[200px] truncate">{item._id.name}</div>
                                <div class="text-xs opacity-50">ID: {item._id.id}</div>
                              </div>
                            </div>
                          </td>
                          <td>{orderAmount}</td>
                          <td>{orderPrice.toFixed(2)}€</td>
                          <td>
                            <button 
                              class="btn btn-ghost btn-xs text-primary"
                              onClick={() => setSelectedItem(item)}
                            >
                              View Trend
                            </button>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </div>

          <div class="space-y-6">
            <Show when={selectedItem()} fallback={
              <div class="card bg-base-100 shadow-xl h-full flex items-center justify-center p-8 opacity-50 border-2 border-dashed">
                <p>Select a product to view price history</p>
              </div>
            }>
              <div class="card bg-base-100 shadow-xl">
                <div class="card-body">
                  <div class="flex flex-col md:flex-row gap-6 items-start">
                    <Show when={selectedItem().image}>
                      <div class="w-24 md:w-32 aspect-square flex-shrink-0 bg-base-200 rounded-xl overflow-hidden shadow-inner">
                        <img src={selectedItem().image} alt={selectedItem()._id.name} class="w-full h-full object-contain" />
                      </div>
                    </Show>
                    <div class="flex-grow">
                      <h2 class="card-title text-primary text-2xl mb-1">{selectedItem()._id.name}</h2>
                      <p class="text-sm opacity-70">Price history over time • ID: {selectedItem()._id.id}</p>
                    </div>
                  </div>
                  
                  <div class="h-64 mt-4">
                    <Line data={getChartData(selectedItem())} options={chartOptions} />
                  </div>

                  <div class="divider">Purchase History</div>
                  
                  <div class="space-y-2 max-h-48 overflow-y-auto pr-2">
                    <For each={[...selectedItem().prices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())}>
                      {(p) => (
                        <div class="flex justify-between items-center bg-base-200 p-2 rounded">
                          <span class="text-sm">{new Date(p.date).toLocaleDateString()}</span>
                          <span class="font-bold">{p.unitPrice.toFixed(2)}€</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
