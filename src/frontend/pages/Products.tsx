import { createSignal, onMount, For, Show, createEffect } from 'solid-js';
import { Line } from 'solid-chartjs';
import { useParams, A, useSearchParams, useNavigate } from '@solidjs/router';
import { ArrowLeft, X, List, TrendingUp } from 'lucide-solid';

// ... (interfaces stay same)

export function Products() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [trends, setTrends] = createSignal<TrendItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchSignal] = createSignal('');
  const [selectedItem, setSelectedItem] = createSignal<TrendItem | null>(null);
  const [orderDetail, setOrderDetail] = createSignal<OrderDetail | null>(null);

  const orderId = () => params.orderId;
  const productId = () => params.productId || searchParams.product;
  const highlightedId = () => searchParams.highlight;

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
  createEffect(() => {
    const id = orderId();
    
    const fetchOrderDetail = async (orderId: string) => {
      try {
        const res = await fetch(`/api/orders/${orderId}`);
        if (res.ok) {
          const json = await res.json();
          setOrderDetail(json);
        }
      } catch (e) {
        console.error('Failed to fetch order detail', e);
      }
    };

    if (id) {
      fetchOrderDetail(id);
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
    
    const detail = orderDetail();
    if (orderId() && detail) {
      const orderItemIds = new Set(detail.items.map((i: { id: number }) => i.id));
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
          borderColor: '#3a7d6e',
          backgroundColor: 'rgba(58, 125, 110, 0.15)',
          tension: 0.3,
          fill: true,
          pointRadius: 5,
          pointHoverRadius: 8,
          pointBackgroundColor: '#3a7d6e',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
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
        backgroundColor: 'rgba(92, 83, 70, 0.9)',
        titleFont: { family: "'DM Sans', sans-serif" },
        bodyFont: { family: "'DM Sans', sans-serif" },
        padding: 12,
        cornerRadius: 8,
        callbacks: {
          label: (context: { parsed: { y: number } }) => `${context.parsed.y.toFixed(2)}€`
        }
      }
    },
    scales: {
      y: {
        beginAtZero: false,
        grid: { color: 'rgba(92, 83, 70, 0.08)' },
        ticks: {
          callback: (value: number) => `${value.toFixed(2)}€`,
          font: { family: "'DM Sans', sans-serif" }
        }
      },
      x: {
        grid: { display: false },
        ticks: {
          font: { family: "'DM Sans', sans-serif" }
        }
      }
    }
  };

  return (
    <div class="space-y-6 max-w-6xl mx-auto">
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div class="animate-fade-in">
            <h1 class="page-title">{orderId() ? `Order Detail` : 'Product Trends'}</h1>
            <p class="text-base-content/60 mt-1">{orderId() ? 'Items in this order' : 'Track price trends across your orders'}</p>
          </div>
          <Show when={orderId()}>
            <div class="flex items-center gap-2 flex-wrap">
              <A href="/orders" class="btn btn-ghost btn-sm px-3 gap-2 rounded-xl">
                <ArrowLeft size={16} /> <span class="hidden sm:inline">Back</span>
              </A>
              <div class="badge badge-primary badge-lg gap-2 py-3 px-4 whitespace-nowrap rounded-xl">
                Order #{orderId()}
                <A href={productId() ? `/products/${productId()}` : "/products"} class="hover:text-error transition-colors ml-1">
                  <X size={14} />
                </A>
              </div>
              <A href={productId() ? `/products/${productId()}` : "/products"} class="btn btn-ghost btn-sm px-3 gap-2 rounded-xl">
                <List size={16} /> <span class="hidden sm:inline">All</span>
              </A>
            </div>
          </Show>
        </div>

        <Show when={orderDetail()}>
          {(detail) => (
            <div class="stats stats-card stats-vertical sm:stats-horizontal rounded-2xl w-full overflow-hidden">
              <div class="stat px-4 py-3">
                <div class="stat-title text-xs">Total Amount</div>
                <div class="stat-value text-primary text-xl">{detail().priceComposition.total.amount.toFixed(2)}€</div>
                <div class="stat-desc">{detail().itemsCount} items total</div>
              </div>
              
              <div class="stat px-4 py-3">
                <div class="stat-title text-xs">Order Date</div>
                <div class="stat-value text-sm font-semibold truncate max-w-[200px]">
                  {new Date(detail().orderTimeDate).toLocaleDateString(undefined, { 
                    month: 'short', day: 'numeric', year: 'numeric'
                  })}
                </div>
                <div class="stat-desc">{new Date(detail().orderTimeDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>

              <div class="stat px-4 py-3">
                <div class="stat-title text-xs">Delivery Address</div>
                <div class="stat-desc text-xs text-base-content font-medium mt-1 whitespace-normal line-clamp-2" title={detail().address}>
                  {detail().address}
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>

      <div class="flex flex-col md:flex-row gap-4 items-center">
        <div class="form-control flex-grow w-full md:max-w-md">
          <input 
            type="text" 
            placeholder="Search products..." 
            class="input input-bordered w-full" 
            onInput={(e) => setSearchSignal(e.currentTarget.value)}
          />
        </div>
      </div>

      <Show when={!loading()} fallback={
        <div class="flex justify-center p-24">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      }>
        <div class="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
          {/* Product List Card - Hidden on mobile if a product is selected */}
          <div class={`card bg-base-100 shadow-xl overflow-hidden border border-base-300 xl:col-span-5 ${productId() ? 'hidden xl:flex' : 'flex'}`}>
            <div class="max-h-[750px] overflow-y-auto">
              <table class="table table-pin-rows table-sm md:table-md">
                <thead>
                  <tr class="bg-base-200/50 text-xs uppercase tracking-wider">
                    <th class="py-4 px-6">Product</th>
                    <th class="text-center py-4">{orderId() ? 'Qty' : '#'}</th>
                    <th class="py-4 px-6 text-right">Price</th>
                  </tr>
                </thead>
                <tbody>
                    <For each={filteredTrends()}>
                      {(item) => {
                        const latestPrice = [...item.prices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                        
                        let orderPrice = latestPrice.unitPrice;
                        let orderAmount: string | number = item.count;
                        
                        const detail = orderDetail();
                        if (orderId() && detail) {
                          const orderItem = detail.items.find((i: { id: number }) => i.id === item._id.id);
                          if (orderItem) {
                            orderPrice = orderItem.priceComposition.unit.amount;
                            orderAmount = orderItem.amount; 
                          }
                        }

                      return (
                        <tr 
                          class={`cursor-pointer transition-all border-b border-base-200 group ${selectedItem()?._id.id === item._id.id || highlightedId() === String(item._id.id) ? 'bg-primary/10 ring-1 ring-inset ring-primary/20' : 'hover:bg-base-200/70'}`}
                          onClick={() => {
                            setSearchParams({ product: item._id.id, highlight: undefined });
                          }}
                        >
                          <td class="px-6 py-4">
                            <div class="flex items-center gap-4">
                              <div class="avatar shrink-0">
                                <div class="mask mask-squircle w-12 h-12 bg-base-200 shadow-sm group-hover:scale-105 transition-transform">
                                  <Show when={item.image} fallback={<div class="flex items-center justify-center h-full text-[10px] text-opacity-30 font-bold">N/A</div>}>
                                    <img src={item.image} alt={item._id.name} loading="lazy" />
                                  </Show>
                                </div>
                              </div>
                              <div class="min-w-0">
                                <div class="font-bold text-sm sm:text-base mb-0.5 leading-tight group-hover:text-primary transition-colors" title={item._id.name}>{item._id.name}</div>
                                <div class="text-[10px] sm:text-xs opacity-50 font-mono">ID: {item._id.id}</div>
                              </div>
                            </div>
                          </td>
                          <td class="text-center font-mono text-sm font-semibold">{orderAmount}</td>
                          <td class="px-6 py-4 font-bold text-primary whitespace-nowrap text-sm sm:text-base text-right">{orderPrice.toFixed(2)}€</td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </div>

          {/* Trend Detail Card - Visible on mobile only if a product is selected */}
          <div class={`space-y-6 xl:col-span-7 ${productId() ? 'block' : 'hidden xl:block'}`}>
            <Show when={selectedItem()} fallback={
              <div class="card bg-base-100 shadow-xl h-full min-h-[400px] flex items-center justify-center p-12 opacity-50 border-2 border-dashed border-base-300">
                <div class="text-center">
                  <div class="bg-base-200 p-6 rounded-full inline-block mb-6 shadow-inner">
                    <TrendingUp size={64} class="opacity-30" />
                  </div>
                  <p class="text-xl font-medium">Select a product to view price history</p>
                  <p class="text-sm opacity-60 mt-2">Click on any item in the list to see its trends</p>
                </div>
              </div>
            }>
              {(item) => (
                <div class="card bg-base-100 shadow-xl border border-base-300 overflow-hidden">
                  <div class="card-body p-6 md:p-10">
                    <div class="flex flex-row gap-6 items-center mb-6">
                      <Show when={item().image}>
                        <div class="w-20 h-20 md:w-24 md:h-24 flex-shrink-0 bg-base-200 rounded-2xl overflow-hidden shadow-md p-1">
                          <img src={item().image} alt={item()._id.name} class="w-full h-full object-contain" />
                        </div>
                      </Show>
                      <div class="flex-grow min-w-0">
                        <h2 class="card-title text-primary text-2xl md:text-3xl line-clamp-2 leading-tight mb-2">{item()._id.name}</h2>
                        <div class="flex items-center gap-3">
                           <span class="badge badge-outline badge-md opacity-60 font-mono px-3">ID: {item()._id.id}</span>
                           <span class="text-xs font-semibold uppercase tracking-widest opacity-40">Price History</span>
                        </div>
                      </div>
                      <button 
                        class="xl:hidden btn btn-ghost btn-circle" 
                        onClick={() => {
                          if (orderId()) {
                            navigate(`/order/${orderId()}`);
                          } else {
                            navigate('/products');
                          }
                        }}
                        aria-label="Back to list"
                      >
                        <X size={24} />
                      </button>
                    </div>
                    
                    <div class="h-[350px] md:h-[450px] mt-4 p-4 bg-base-200/30 rounded-2xl border border-base-200">
                      <Line data={getChartData(item())} options={chartOptions} />
                    </div>

                    <div class="divider text-xs font-bold uppercase tracking-[0.2em] my-8 opacity-30">Purchase History</div>
                    
                    <div class="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-3 overflow-y-auto max-h-[300px] pr-2 custom-scrollbar">
                      <For each={[...item().prices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())}>
                        {(p) => (
                          <A 
                            href={`/order/${p.orderId}?highlight=${item()._id.id}`}
                            class={`flex justify-between items-center w-full p-4 rounded-xl transition-all border ${String(orderId()) === String(p.orderId) ? 'bg-primary/20 border-primary/30 shadow-inner' : 'bg-base-100 border-base-300 hover:bg-base-200 hover:border-base-400 hover:translate-x-1'}`}
                          >
                            <div class="flex flex-col">
                              <span class="text-[10px] opacity-40 font-black uppercase tracking-tighter mb-1">Order #{p.orderId}</span>
                              <span class="text-sm font-bold">{new Date(p.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                            </div>
                            <div class="text-right">
                              <span class="font-black text-primary text-lg">{p.unitPrice.toFixed(2)}€</span>
                            </div>
                          </A>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
