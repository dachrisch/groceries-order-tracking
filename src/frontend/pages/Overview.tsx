/**
 * Overview: what is due, where it comes from, and what was bought last.
 *
 * The week card carries two rates and never one merged figure (plan §2 D1,
 * note O1): Knuspr's learned weekly basket and the EDEKA items that are due
 * again are separate habits from separate shops, and adding them would
 * double-count a week that had both. The Knuspr row keeps its figure when the
 * shopper is away, struck through, with the location's own reason beside it.
 */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { ArrowRight, Package, ShoppingBasket } from 'lucide-solid';
import { BasketAddButton } from '../components/BasketAddButton';
import { ProviderBadges, ProviderChip } from '../components/ProviderBadges';
import { destinationLabel, providerLabel, useLocation, type Destination, type Provider } from '../lib/location';
import { addTargetFor, offerFor, priceOf, providersOf, stockLabel, type BrowseItem, type ProductsResponse } from '../lib/browse';
import { cadenceRange, euro, monthLabel, relativeDays } from '../lib/format';
import { activityTitle, monthRange, monthStart, type ActivityResponse, type ActivitySummary } from '../lib/activity';

interface ForecastResponse {
  week: {
    estimatedTotal: number;
    itemCount: number;
    horizonDays: number;
    items: Array<{ productId: number; name: string; qty: number; reason: string }>;
  };
}

interface WeekRate {
  provider: Provider;
  total: number;
  items: number;
  cadence: string;
  available: boolean;
  reason: string;
}

export function Overview() {
  const location = useLocation();
  const [products, setProducts] = createSignal<ProductsResponse | null>(null);
  const [forecast, setForecast] = createSignal<ForecastResponse | null>(null);
  const [recent, setRecent] = createSignal<ActivitySummary[]>([]);
  const [month, setMonth] = createSignal<ActivityResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const destination = (): Destination => location.state()?.destination ?? 'checklist';

  const load = async () => {
    setError(null);
    const now = new Date();
    const range = monthRange(monthStart(now), now);
    try {
      const [productsRes, forecastRes, recentRes, monthRes] = await Promise.all([
        fetch('/api/products?due=1'),
        fetch('/api/bot/forecast'),
        fetch('/api/activity?limit=5'),
        fetch(`/api/activity?from=${range.from.toISOString()}&to=${range.to.toISOString()}&limit=300`),
      ]);

      if (productsRes.ok) {
        setProducts((await productsRes.json()) as ProductsResponse);
      } else {
        const body = (await productsRes.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not read your groceries.');
      }
      if (forecastRes.ok) setForecast((await forecastRes.json()) as ForecastResponse);
      if (recentRes.ok) setRecent(((await recentRes.json()) as ActivityResponse).events);
      if (monthRes.ok) setMonth((await monthRes.json()) as ActivityResponse);
    } catch (failure) {
      console.error('Overview load failed', failure);
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void load();
    // A run started from Ask or a product sheet changes what is still due.
    const reload = () => void load();
    window.addEventListener('bot-run-complete', reload);
    onCleanup(() => window.removeEventListener('bot-run-complete', reload));
  });

  const dueItems = () => products()?.items ?? [];
  // The list endpoint gates "due" per provider, so the two sides are told apart
  // by the row's own id. A merged row's EDEKA stat is display-only and must not
  // land in the EDEKA rate as well.
  const knusprDue = () => dueItems().filter((item) => item.id.startsWith('knuspr:'));
  const edekaDue = () => dueItems().filter((item) => item.id.startsWith('edeka:'));

  const reachOf = (provider: Provider) =>
    location.state()?.providers.find((entry) => entry.provider === provider);

  const weekRates = (): WeekRate[] => {
    const knusprStats = knusprDue()
      .map((item) => item.statsByProvider.knuspr)
      .filter((stat) => stat !== undefined);
    const edekaStats = edekaDue()
      .map((item) => item.statsByProvider.edeka)
      .filter((stat) => stat !== undefined);

    // Knuspr's rate is the learned weekly basket; it keeps its figure while the
    // shopper is away, which is what the strikethrough explains. The due list is
    // availability-gated, so its rows are the fallback when the forecast is down.
    const week = forecast()?.week;
    const knusprTotal =
      week?.estimatedTotal ??
      knusprDue().reduce((sum, item) => sum + (offerFor(item, 'knuspr')?.price ?? 0), 0);
    const knusprCount = week?.itemCount ?? knusprDue().length;
    const edekaTotal = edekaDue().reduce((sum, item) => sum + (offerFor(item, 'edeka')?.price ?? 0), 0);

    return [
      {
        provider: 'knuspr',
        total: knusprTotal,
        items: knusprCount,
        cadence: cadenceRange(knusprStats.map((stat) => stat.cadenceDays)),
        available: reachOf('knuspr')?.available ?? true,
        reason: reachOf('knuspr')?.reason ?? '',
      },
      {
        provider: 'edeka',
        total: edekaTotal,
        items: edekaDue().length,
        cadence: cadenceRange(edekaStats.map((stat) => stat.cadenceDays)),
        available: reachOf('edeka')?.available ?? true,
        reason: reachOf('edeka')?.reason ?? '',
      },
    ];
  };

  const horizonDays = () => forecast()?.week.horizonDays ?? products()?.horizonDays ?? 7;

  const addItem = (item: BrowseItem) => addTargetFor(item, destination());

  const monthEvents = () => month()?.events ?? [];

  const spendRows = () => {
    const totals = month()?.totals;
    return [
      {
        provider: 'knuspr' as Provider,
        total: totals?.knuspr ?? 0,
        count: monthEvents().filter((event) => event.provider === 'knuspr').length,
        noun: 'deliveries',
      },
      {
        provider: 'edeka' as Provider,
        total: totals?.edeka ?? 0,
        count: monthEvents().filter((event) => event.provider === 'edeka').length,
        noun: 'store runs',
      },
    ];
  };

  const today = () =>
    new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div class="space-y-8 pb-12">
      <div class="animate-fade-in flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 class="page-title">Overview</h1>
          <p class="mt-1 text-base-content/85">
            {today()} ·{' '}
            <Show when={products()} fallback="reading what is due">
              {(data) => `${data().counts.due} due`}
            </Show>{' '}
            across both stores
          </p>
        </div>
        <A href="/groceries?due=1" class="btn btn-outline btn-sm gap-2 self-start rounded-xl">
          <ShoppingBasket size={16} /> All groceries
        </A>
      </div>

      <Show when={error()}>
        <div class="alert alert-error shadow-sm">
          <span>{error()}</span>
        </div>
      </Show>

      <Show
        when={!loading()}
        fallback={
          <div class="flex justify-center py-24">
            <span class="loading loading-spinner loading-lg text-primary" />
          </div>
        }
      >
        <div class="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div class="space-y-8 xl:col-span-2">
            <section class="card rounded-2xl border border-base-300 bg-base-100 shadow-lg">
              <div class="card-body gap-4 p-5 sm:p-6">
                <div class="flex items-start justify-between gap-3">
                  <span class="text-[10px] font-bold uppercase tracking-wider text-base-content/55">
                    Next ~{horizonDays()} days · one rate per store
                  </span>
                  <span class="badge badge-ghost badge-sm">
                    {products()?.counts.due ?? 0} due
                  </span>
                </div>

                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <For each={weekRates()}>
                    {(rate) => (
                      <div
                        class={`rounded-xl border border-base-300 bg-base-200/40 p-3 ${
                          rate.available ? '' : 'opacity-60'
                        }`}
                      >
                        <div class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-base-content/60">
                          <ProviderChip provider={rate.provider} />
                          {providerLabel(rate.provider)}
                        </div>
                        <div
                          class={`mt-1 text-2xl font-extrabold leading-none ${
                            rate.available ? 'text-primary' : 'text-base-content/55 line-through'
                          }`}
                        >
                          {rate.items === 0 ? '—' : euro(rate.total)}
                        </div>
                        <span class="mt-0.5 block text-[11px] text-base-content/60">
                          <Show when={rate.items > 0} fallback="nothing due">
                            {rate.items} item{rate.items === 1 ? '' : 's'}
                            <Show when={rate.available}> · {rate.cadence}</Show>
                          </Show>
                        </span>
                        <Show when={!rate.available}>
                          <span class="mt-1 block text-[10px] leading-tight text-error">
                            {rate.reason}
                          </span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                <p class="text-[11px] text-base-content/50">
                  A plain + writes to {destinationLabel(destination())}. Availability only changes
                  defaults; it never orders anything for you.
                </p>
              </div>
            </section>

            <section class="space-y-3">
              <div class="flex items-baseline justify-between gap-2">
                <h2 class="text-lg font-bold">Due this week</h2>
                <A href="/groceries?due=1" class="text-xs font-bold text-primary">
                  See all
                </A>
              </div>

              <Show
                when={dueItems().length > 0}
                fallback={
                  <div class="rounded-2xl border border-base-300 bg-base-100 p-8 text-center shadow-sm">
                    <p class="text-sm font-semibold">Nothing is due this week.</p>
                    <p class="mt-1 text-xs text-base-content/60">
                      Your stock covers the next few days. Browse everything you buy instead.
                    </p>
                    <A href="/groceries?due=0" class="btn btn-ghost btn-sm mt-3 rounded-xl">
                      Browse all groceries
                    </A>
                  </div>
                }
              >
                <div class="flex gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-4">
                  <For each={dueItems()}>
                    {(item) => (
                      <div class="flex w-40 shrink-0 flex-col rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm sm:w-auto">
                        <div class="mb-2 flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-base-200">
                          <Show
                            when={item.image}
                            fallback={<Package size={20} class="text-base-content/40" />}
                          >
                            {(image) => (
                              <img
                                src={image()}
                                alt=""
                                loading="lazy"
                                class="h-full w-full object-cover"
                              />
                            )}
                          </Show>
                        </div>
                        <span class="line-clamp-2 min-h-[2.1rem] text-xs font-bold leading-snug">
                          {item.name}
                        </span>
                        <div class="mt-1.5 flex items-center gap-1">
                          <ProviderBadges providers={providersOf(item)} />
                        </div>
                        <div class="mt-auto flex items-end justify-between gap-1 pt-2">
                          <div class="min-w-0">
                            <div class="text-xs font-extrabold text-primary">{euro(priceOf(item))}</div>
                            <div class="truncate text-[10px] text-base-content/55">
                              {stockLabel(item)}
                            </div>
                          </div>
                          <Show when={addItem(item)}>
                            {(target) => (
                              <BasketAddButton item={target()} destination={destination()} />
                            )}
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          </div>

          <div class="space-y-6">
            <section class="card rounded-2xl border border-base-300 bg-base-100 shadow-sm">
              <div class="card-body gap-2 p-5">
                <div class="flex items-baseline justify-between gap-2">
                  <h2 class="text-base font-bold">Recent</h2>
                  <A href="/activity" class="text-xs font-bold text-primary">
                    All activity
                  </A>
                </div>
                <Show
                  when={recent().length > 0}
                  fallback={<p class="py-4 text-xs text-base-content/60">No purchases recorded yet.</p>}
                >
                  <div class="divide-y divide-base-200">
                    <For each={recent()}>
                      {(event) => (
                        <A href="/activity" class="flex items-center gap-3 py-2.5">
                          <ProviderChip provider={event.provider} />
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-xs font-bold">{activityTitle(event)}</div>
                            <div class="text-[10px] text-base-content/60">
                              {relativeDays(event.at)} · {event.itemCount} items
                            </div>
                          </div>
                          <span class="text-xs font-extrabold">{euro(event.total)}</span>
                        </A>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </section>

            <section class="card rounded-2xl border border-base-300 bg-base-100 shadow-sm">
              <div class="card-body gap-3 p-5">
                <div class="flex items-baseline justify-between gap-2">
                  <h2 class="text-base font-bold">Spend this month</h2>
                  <A href="/activity" class="flex items-center gap-0.5 text-xs font-bold text-primary">
                    {monthLabel(monthStart())}
                    <ArrowRight size={12} />
                  </A>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <For each={spendRows()}>
                    {(row) => (
                      <div class="rounded-xl bg-base-200/50 p-3">
                        <div class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-base-content/55">
                          <ProviderChip provider={row.provider} />
                          {providerLabel(row.provider)}
                        </div>
                        <div class="mt-1 text-lg font-extrabold">{euro(row.total)}</div>
                        <div class="text-[10px] text-base-content/55">
                          {row.count} {row.noun}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
                <p class="text-[10px] text-base-content/50">
                  Two shops, two figures. Nothing here adds them together.
                </p>
              </div>
            </section>
          </div>
        </div>
      </Show>
    </div>
  );
}
