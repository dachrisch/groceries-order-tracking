import { createSignal, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Chart, Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController } from 'chart.js';
import { Line } from 'solid-chartjs';
import 'chartjs-adapter-date-fns';

Chart.register(Title, Tooltip, Legend, Colors, LineElement, PointElement, LinearScale, CategoryScale, TimeScale, LineController);

interface AggregateData {
  _id: { year: number; month: number };
  totalAmount: number;
  itemCount: number;
  orderCount: number;
}

interface StatsData {
  totalSpend: number;
  totalItems: number;
  totalOrders: number;
  distinctItems: number;
  firstOrder?: string;
  lastOrder?: string;
}

export function Dashboard() {
  const [data, setData] = createSignal<AggregateData[]>([]);
  const [stats, setStats] = createSignal<StatsData | null>(null);
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
          borderColor: '#3a7d6e',
          backgroundColor: 'rgba(58, 125, 110, 0.1)',
          tension: 0.3,
          fill: true,
          yAxisID: 'y',
        },
        {
          label: 'Item Count',
          data: sortedData.map(d => d.itemCount),
          borderColor: '#c47d4e',
          backgroundColor: 'rgba(196, 125, 78, 0.1)',
          tension: 0.3,
          fill: true,
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
    plugins: {
      legend: {
        position: 'top' as const,
        labels: {
          usePointStyle: true,
          padding: 20,
          font: { family: "'DM Sans', sans-serif" }
        }
      }
    },
    scales: {
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: { display: true, text: 'Spend (EUR)', font: { family: "'DM Sans', sans-serif" } },
        grid: { color: 'rgba(92, 83, 70, 0.08)' }
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        grid: { drawOnChartArea: false },
        title: { display: true, text: 'Item Count', font: { family: "'DM Sans', sans-serif" } }
      },
      x: {
        grid: { display: false }
      }
    }
  };

  return (
    <div class="space-y-12 pb-12">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div class="animate-fade-in">
          <h1 class="text-4xl md:text-5xl font-extrabold tracking-tight">Dashboard</h1>
          <p class="text-base-content/85 mt-2 text-lg">Spending insights and order statistics</p>
        </div>
      </div>
      
      <Show when={!loading()} fallback={
        <div class="flex justify-center items-center py-24">
          <span class="loading loading-spinner loading-lg text-primary" />
        </div>
      }>
        <Show when={data().length > 0} fallback={
          <div class="alert alert-info shadow-sm border-info/20 p-6 text-lg">
            <span>No order data found. Go to <A href="/settings" class="link font-bold">Settings</A> to connect your Knuspr account and sync your orders.</span>
          </div>
        }>
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            <Show when={stats()}>
              {(s) => (
                <>
                  <div class="stats shadow bg-primary text-primary-content p-2 rounded-2xl hover-lift">
                    <div class="stat">
                      <div class="stat-title text-primary-content opacity-80 text-sm font-medium uppercase tracking-wider">Total Spend</div>
                      <div class="stat-value text-3xl md:text-4xl">{s().totalSpend.toFixed(2)}€</div>
                      <div class="stat-desc text-primary-content opacity-70 mt-1">{data().length} months tracked</div>
                    </div>
                  </div>
                  
                  <div class="stats shadow bg-secondary text-secondary-content p-2 rounded-2xl hover-lift">
                    <div class="stat">
                      <div class="stat-title text-secondary-content opacity-80 text-sm font-medium uppercase tracking-wider">Total Items</div>
                      <div class="stat-value text-3xl md:text-4xl">{s().totalItems}</div>
                      <div class="stat-desc text-secondary-content opacity-70 mt-1">{s().distinctItems} distinct products</div>
                    </div>
                  </div>

                  <div class="stats shadow p-2 rounded-2xl hover-lift">
                    <div class="stat">
                      <div class="stat-title text-sm font-medium uppercase tracking-wider">Avg Order Value</div>
                      <div class="stat-value text-3xl md:text-4xl">
                        {s().totalOrders ? (s().totalSpend / s().totalOrders).toFixed(2) : '0.00'}€
                      </div>
                      <div class="stat-desc mt-1">{s().totalOrders} total orders</div>
                    </div>
                  </div>

                  <div class="stats shadow p-2 rounded-2xl hover-lift">
                    <div class="stat">
                      <div class="stat-title text-sm font-medium uppercase tracking-wider">Orders per Month</div>
                      <div class="stat-value text-3xl md:text-4xl">
                        {data().length ? (s().totalOrders / data().length).toFixed(1) : '0.0'}
                      </div>
                      <div class="stat-desc mt-1">Monthly average</div>
                    </div>
                  </div>
                </>
              )}
            </Show>
          </div>

          <div class="card bg-base-100 shadow-xl border border-base-300 overflow-hidden rounded-2xl">
            <div class="card-body p-8">
              <h2 class="card-title text-2xl mb-4">Spend & Item Count Over Time</h2>
              <div class="h-[400px] md:h-[500px]">
                <Line data={chartData()} options={chartOptions} />
              </div>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
