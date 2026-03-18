import { createSignal, onMount, For, Show } from 'solid-js';
import { Chart, Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController } from 'chart.js';
import { Line } from 'solid-chartjs';

export function Products() {
  const [trends, setTrends] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchSignal] = createSignal('');
  const [selectedItem, setSelectedItem] = createSignal<any>(null);

  onMount(async () => {
    try {
      const res = await fetch('/api/product-trends');
      if (res.ok) {
        const json = await res.json();
        setTrends(json);
      }
    } catch (e) {
      console.error('Failed to fetch product trends', e);
    } finally {
      setLoading(false);
    }
  });

  const filteredTrends = () => {
    const term = searchTerm().toLowerCase();
    if (!term) return trends();
    return trends().filter(item => 
      item._id.name.toLowerCase().includes(term) || 
      String(item._id.id).includes(term)
    );
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
      <h1 class="text-3xl font-bold">Product Trends</h1>

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
                    <th>Product Name</th>
                    <th>Purchases</th>
                    <th>Latest Price</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredTrends()}>
                    {(item) => {
                      const latestPrice = [...item.prices].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
                      return (
                        <tr class={selectedItem()?._id.id === item._id.id ? 'bg-base-200' : ''}>
                          <td class="font-medium max-w-xs truncate">{item._id.name}</td>
                          <td>{item.count}</td>
                          <td>{latestPrice.unitPrice.toFixed(2)}€</td>
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
                  <h2 class="card-title text-primary">{selectedItem()._id.name}</h2>
                  <p class="text-sm opacity-70">Price history over time</p>
                  
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
