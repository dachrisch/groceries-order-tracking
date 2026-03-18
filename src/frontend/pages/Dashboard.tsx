import { createSignal, onMount, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Chart, Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController } from 'chart.js';
import { Line } from 'solid-chartjs';
import 'chartjs-adapter-date-fns';

Chart.register(Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController);

export function Dashboard() {
  const [data, setData] = createSignal<any[]>([]);
  const [stats, setStats] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const [aggRes, statsRes] = await Promise.all([
        fetch('/api/aggregates'),
        fetch('/api/stats')
      ]);

      if (aggRes.ok) {
        const json = await aggRes.json();
        setData(json);
      }
      if (statsRes.ok) {
        const json = await statsRes.json();
        setStats(json);
      }
    } catch (e) {
      console.error('Failed to fetch dashboard data', e);
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
    <div class="max-w-5xl mx-auto space-y-10 pb-12">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 class="text-4xl font-extrabold tracking-tight">Dashboard</h1>
          <p class="text-base-content/60 mt-1">Spending insights and order statistics</p>
        </div>
      </div>
      
      <Show when={!loading()} fallback={
        <div class="flex justify-center items-center py-20">
          <span class="loading loading-spinner loading-lg text-primary"></span>
        </div>
      }>
        <Show when={data().length > 0} fallback={
          <div class="alert alert-info shadow-sm border-info/20">
            <span>No order data found. Go to <A href="/settings" class="link font-bold">Settings</A> to connect your Knuspr account and sync your orders.</span>
          </div>
        }>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div class="stats shadow bg-primary text-primary-content">
              <div class="stat">
                <div class="stat-title text-primary-content opacity-70">Total Spend</div>
                <div class="stat-value text-2xl md:text-3xl">{stats()?.totalSpend.toFixed(2)}€</div>
                <div class="stat-desc text-primary-content opacity-70">{data().length} months tracked</div>
              </div>
            </div>
            
            <div class="stats shadow bg-secondary text-secondary-content">
              <div class="stat">
                <div class="stat-title text-secondary-content opacity-70">Total Items</div>
                <div class="stat-value text-2xl md:text-3xl">{stats()?.totalItems}</div>
                <div class="stat-desc text-secondary-content opacity-70">{stats()?.distinctItems} distinct products</div>
              </div>
            </div>

            <div class="stats shadow">
              <div class="stat">
                <div class="stat-title">Avg Order Value</div>
                <div class="stat-value text-2xl md:text-3xl">
                  {stats()?.totalOrders ? (stats().totalSpend / stats().totalOrders).toFixed(2) : '0.00'}€
                </div>
                <div class="stat-desc">{stats()?.totalOrders} total orders</div>
              </div>
            </div>

            <div class="stats shadow">
              <div class="stat">
                <div class="stat-title">Orders per Month</div>
                <div class="stat-value text-2xl md:text-3xl">
                  {data().length ? (stats()?.totalOrders / data().length).toFixed(1) : '0.0'}
                </div>
                <div class="stat-desc">Monthly average</div>
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
