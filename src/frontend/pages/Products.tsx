import { createSignal, onMount, For, Show, createEffect } from 'solid-js';
import { Chart, Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController } from 'chart.js';
import { Line } from 'solid-chartjs';
import { useParams, A, useNavigate, useSearchParams } from '@solidjs/router';
import { ArrowLeft, ExternalLink, X, List } from 'lucide-solid';

export function Products() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [trends, setTrends] = createSignal<unknown[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchSignal] = createSignal('');
  const [selectedItem, setSelectedItem] = createSignal<unknown>(null);
  const [orderDetail, setOrderDetail] = createSignal<unknown>(null);

  const orderId = () => params.orderId;
  const productId = () => params.productId || searchParams.product;

  onMount(async () => {
    try {
      const trendsRes = await fetch('/api/product-trends');
      if (trendsRes.ok) {
        const json = await trendsRes.json();
        setTrends(json);
      }
    } catch (e) {
      console.error('Failed to fetch trends', e);
    } finally {
      setLoading(false);
    }
  });

  // Handle order detail fetching when orderId changes
  createEffect(async () => {
    const id = orderId();
    if (id) {
      try {
        const res = await fetch(`/api/orders/${id}`);
        if (res.ok) {
          const json = await res.json();
          setOrderDetail(json);
        }
      } catch (e) {
        console.error('Failed to fetch order detail', e);
      }
    } else {
      setOrderDetail(null);
    }
  });

  // Handle product selection when productId param changes or trends load
  createEffect(() => {
    const pId = productId();
    const currentTrends = trends();
    if (pId && currentTrends.length > 0) {
      const item = currentTrends.find(t => String(t._id.id) === String(pId));
      if (item) setSelectedItem(item);
    }
  });

  const filteredTrends = () => {
    let items = trends();
    
    if (orderId() && orderDetail()) {
      const orderItemIds = new Set(orderDetail().items.map((i: { id: number }) => i.id));
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

  const getChartData = (item: { prices: Array<{ date: string, unitPrice: number }> }) => {
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
          label: (context: { parsed: { y: number } }) => `${context.parsed.y.toFixed(2)}€`
        }
      }
    },
    scales: {
      y: {
        beginAtZero: false,
        ticks: {
          callback: (value: number) => `${value.toFixed(2)}€`
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
              <A href={productId() ? `/products/${productId()}` : "/products"} class="hover:text-error transition-colors ml-2">
                <X size={14} />
              </A>
            </div>
            <A href={productId() ? `/products/${productId()}` : "/products"} class="btn btn-ghost btn-sm gap-2">
              <List size={16} /> Show All Products
            </A>
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

      <Show when={!loading()} fallback={<span class="loading loading-spinner loading-lg" />}>
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
                        const orderItem = orderDetail().items.find((i: { id: number }) => i.id === item._id.id);
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
                            <A 
                              href={orderId() ? `/order/${orderId()}?product=${item._id.id}` : `/products/${item._id.id}`}
                              class="btn btn-ghost btn-xs text-primary"
                            >
                              View Trend
                            </A>
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
                        <A 
                          href={`/order/${p.orderId}?product=${selectedItem()._id.id}`}
                          class={`flex justify-between items-center w-full p-2 rounded transition-colors text-left ${String(orderId()) === String(p.orderId) ? 'bg-primary/20 ring-1 ring-primary/30' : 'bg-base-200 hover:bg-base-300'}`}
                        >
                          <div class="flex flex-col">
                            <span class="text-xs opacity-50 font-mono">Order #{p.orderId}</span>
                            <span class="text-sm font-medium">{new Date(p.date).toLocaleDateString()}</span>
                          </div>
                          <span class="font-bold text-primary">{p.unitPrice.toFixed(2)}€</span>
                        </A>
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
