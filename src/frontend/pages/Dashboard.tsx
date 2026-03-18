import { createSignal, onMount, For, Show } from 'solid-js';
import { Chart, Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController } from 'chart.js';
import { Line } from 'solid-chartjs';
import 'chartjs-adapter-date-fns';

Chart.register(Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController);

export function Dashboard() {
  const [data, setData] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const res = await fetch('/api/aggregates');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error('Failed to fetch aggregates', e);
    } finally {
      setLoading(false);
    }
  });

  const chartData = () => {
    const sortedData = [...data()].sort((a, b) => {
      if (a._id.year !== b._id.year) return a._id.year - b._id.year;
      return a._id.month - b._id.month;
    });

    const labels = sortedData.map(d => `${d._id.year}-${String(d._id.month).padStart(2, '0')}`);
    
    return {
      labels,
      datasets: [
        {
          label: 'Total Spend (EUR)',
          data: sortedData.map(d => d.totalAmount),
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1,
          yAxisID: 'y',
        },
        {
          label: 'Item Count',
          data: sortedData.map(d => d.itemCount),
          borderColor: 'rgb(255, 99, 132)',
          tension: 0.1,
          yAxisID: 'y1',
        }
      ]
    };
  };

  const chartOptions = {
    responsive: true,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    scales: {
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: { display: true, text: 'Spend (EUR)' }
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        grid: { drawOnChartArea: false },
        title: { display: true, text: 'Item Count' }
      },
    }
  };

  return (
    <div class="space-y-8">
      <h1 class="text-3xl font-bold">Dashboard</h1>
      
      <Show when={!loading()} fallback={<span class="loading loading-spinner loading-lg"></span>}>
        <Show when={data().length > 0} fallback={
          <div class="alert alert-info">
            <span>No order data found. Go to <strong>Import</strong> to fetch your Knuspr orders.</span>
          </div>
        }>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="stats shadow bg-primary text-primary-content">
              <div class="stat">
                <div class="stat-title text-primary-content opacity-70">Total Spend</div>
                <div class="stat-value">{data().reduce((acc, d) => acc + d.totalAmount, 0).toFixed(2)}€</div>
                <div class="stat-desc text-primary-content opacity-70">{data().length} months tracked</div>
              </div>
            </div>
            
            <div class="stats shadow bg-secondary text-secondary-content">
              <div class="stat">
                <div class="stat-title text-secondary-content opacity-70">Total Items</div>
                <div class="stat-value">{data().reduce((acc, d) => acc + d.itemCount, 0)}</div>
                <div class="stat-desc text-secondary-content opacity-70">Across {data().reduce((acc, d) => acc + d.orderCount, 0)} orders</div>
              </div>
            </div>

            <div class="stats shadow">
              <div class="stat">
                <div class="stat-title">Avg Order Value</div>
                <div class="stat-value">
                  {(data().reduce((acc, d) => acc + d.totalAmount, 0) / data().reduce((acc, d) => acc + d.orderCount, 0)).toFixed(2)}€
                </div>
              </div>
            </div>
          </div>

          <div class="card bg-base-100 shadow-xl">
            <div class="card-body">
              <h2 class="card-title">Spend & Item Count Over Time</h2>
              <div class="h-96">
                <Line data={chartData()} options={chartOptions} />
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
