import { createSignal, onMount, For, Show, createEffect } from 'solid-js';
import { Line } from 'solid-chartjs';
import { useParams, A, useSearchParams } from '@solidjs/router';
import { ArrowLeft, X, List, TrendingUp } from 'lucide-solid';

interface TrendItem {
  _id: { id: number; name: string };
  prices: Array<{ date: string; unitPrice: number; orderId: number }>;
  count: number;
  image?: string;
  categories?: Array<{ id: number; name: string; slug: string; level: number }>;
}

interface OrderDetail {
  id: number;
  itemsCount: number;
  priceComposition: {
    total: { amount: number };
  };
  orderTimeDate: string;
  address: string;
  items: Array<{
    id: number;
    amount: number;
    textualAmount?: string;
    priceComposition: {
      unit: { amount: number };
    };
  }>;
}

export function Products() {
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
    <div class="space-y-6">
      <div class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <h1 class="text-2xl md:text-3xl font-bold">{orderId() ? `Order Detail` : 'Product Trends'}</h1>
          <Show when={orderId()}>
            <div class="flex items-center gap-2 flex-wrap">
              <A href="/orders" class="btn btn-ghost btn-sm px-2 gap-2">
                <ArrowLeft size={16} /> <span class="hidden sm:inline">Back</span>
              </A>
              <div class="badge badge-primary badge-lg gap-2 py-4 whitespace-nowrap">
                Order #{orderId()}
                <A href={productId() ? `/products/${productId()}` : "/products"} class="hover:text-error transition-colors ml-1">
                  <X size={14} />
                </A>
              </div>
              <A href={productId() ? `/products/${productId()}` : "/products"} class="btn btn-ghost btn-sm px-2 gap-2">
                <List size={16} /> <span class="hidden sm:inline">All</span>
              </A>
            </div>
          </Show>
        </div>

        <Show when={orderDetail()}>
          {(detail) => (
            <div class="stats stats-vertical sm:stats-horizontal shadow bg-base-100 border border-base-300 w-full overflow-hidden">
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

      <Show when={!loading()} fallback={<span class="loading loading-spinner loading-lg" />}>
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Product List Card - Hidden on mobile if a product is selected */}
          <div class={`card bg-base-100 shadow-xl overflow-hidden border border-base-300 ${productId() ? 'hidden xl:flex' : 'flex'}`}>
            <div class="max-h-[600px] overflow-y-auto">
              <table class="table table-pin-rows table-xs sm:table-sm">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th class="text-center">{orderId() ? 'Qty' : '#'}</th>
                    <th>Price</th>
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
                          class={`cursor-pointer transition-colors ${selectedItem()?._id.id === item._id.id || highlightedId() === String(item._id.id) ? 'bg-primary/10 ring-1 ring-inset ring-primary/20' : 'hover:bg-base-200'}`}
                          onClick={() => {
                            setSearchParams({ product: item._id.id, highlight: undefined });
                          }}
                        >
                          <td class="max-w-[160px] sm:max-w-xs">
                            <div class="flex items-center gap-2 sm:gap-3">
                              <div class="avatar shrink-0">
                                <div class="mask mask-squircle w-10 h-10 bg-base-200">
                                  <Show when={item.image} fallback={<div class="flex items-center justify-center h-full text-[10px] text-opacity-30">N/A</div>}>
                                    <img src={item.image} alt={item._id.name} loading="lazy" />
                                  </Show>
                                </div>
                              </div>
                              <div class="min-w-0">
                                <div class="font-bold truncate text-xs sm:text-sm" title={item._id.name}>{item._id.name}</div>
                                <div class="text-[10px] opacity-50 truncate">ID: {item._id.id}</div>
                              </div>
                            </div>
                          </td>
                          <td class="text-center font-mono text-xs">{orderAmount}</td>
                          <td class="font-medium whitespace-nowrap">{orderPrice.toFixed(2)}€</td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </div>

          {/* Trend Detail Card - Visible on mobile only if a product is selected */}
          <div class={`space-y-6 ${productId() ? 'block' : 'hidden xl:block'}`}>
            <Show when={selectedItem()} fallback={
              <div class="card bg-base-100 shadow-xl h-full min-h-[300px] flex items-center justify-center p-8 opacity-50 border-2 border-dashed border-base-300">
                <div class="text-center">
                  <TrendingUp size={48} class="mx-auto mb-4 opacity-20" />
                  <p>Select a product to view price history</p>
                </div>
              </div>
            }>
              {(item) => (
                <div class="card bg-base-100 shadow-xl border border-base-300">
                  <div class="card-body p-4 sm:p-6">
                    <div class="flex flex-row gap-4 items-center mb-2">
                      <Show when={item().image}>
                        <div class="w-16 h-16 sm:w-20 sm:h-20 flex-shrink-0 bg-base-200 rounded-lg overflow-hidden shadow-inner">
                          <img src={item().image} alt={item()._id.name} class="w-full h-full object-contain" />
                        </div>
                      </Show>
                      <div class="flex-grow min-w-0">
                        <h2 class="card-title text-primary text-lg sm:text-xl line-clamp-2 leading-tight mb-1">{item()._id.name}</h2>
                        <p class="text-[10px] sm:text-xs opacity-70">Price History • ID: {item()._id.id}</p>
                      </div>
                      <button 
                        class="xl:hidden btn btn-ghost btn-sm btn-square" 
                        onClick={() => {
                          if (orderId()) {
                            navigate(`/order/${orderId()}`);
                          } else {
                            navigate('/products');
                          }
                        }}
                        aria-label="Back to list"
                      >
                        <X size={20} />
                      </button>
                    </div>
                    
                    <div class="h-48 sm:h-64 mt-2">
                      <Line data={getChartData(item())} options={chartOptions} />
                    </div>

                    <div class="divider text-xs my-2">Purchase History</div>
                    
                    <div class="space-y-2 max-h-48 xl:max-h-64 overflow-y-auto pr-1">
                      <For each={[...item().prices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())}>
                        {(p) => (
                          <A 
                            href={`/order/${p.orderId}?highlight=${item()._id.id}`}
                            class={`flex justify-between items-center w-full p-2 rounded transition-colors text-left ${String(orderId()) === String(p.orderId) ? 'bg-primary/20 ring-1 ring-primary/30' : 'bg-base-200 hover:bg-base-300'}`}
                          >
                            <div class="flex flex-col">
                              <span class="text-[10px] opacity-50 font-mono">Order #{p.orderId}</span>
                              <span class="text-xs font-medium">{new Date(p.date).toLocaleDateString()}</span>
                            </div>
                            <span class="font-bold text-primary text-sm">{p.unitPrice.toFixed(2)}€</span>
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
