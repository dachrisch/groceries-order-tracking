/**
 * Activity: deliveries and in-store runs as one timeline, plus the bot run
 * history that used to live on `/bot`.
 *
 * The two collections stay separate in storage, so this page only merges at
 * read time and keeps the provider on every row and every total. Month spend is
 * two figures, one per store — never a combined rate. Tapping an entry opens
 * its lines; a bot-filled basket can be undone from there, in the store it was
 * written to.
 */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  Bot as BotIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Undo2,
} from 'lucide-solid';import { CapturePanel } from '../components/CapturePanel';
import { Sheet } from '../components/Sheet';
import { StatePanel } from '../components/StatePanel';
import { ProviderChip } from '../components/ProviderBadges';
import { destinationLabel, type Destination, type Provider } from '../lib/location';
import { openAsk } from '../lib/overlays';
import {
  activityTitle,
  monthRange,
  monthStart,
  shiftMonth,
  type ActivityDetail,
  type ActivityResponse,
  type ActivitySummary,
} from '../lib/activity';
import { dateTime, euro, monthLabel } from '../lib/format';
import { fetchWithTimeout, loadFailureCopy } from '../lib/request';

type SourceFilter = 'all' | Provider;

/**
 * A month is the default window because spend is a monthly figure; "wide" is
 * the answer to an empty month, so the shopper does not have to press the
 * arrows twelve times to find out whether there is anything at all.
 */
type Span = 'month' | 'wide';

const WIDE_DAYS = 90;


const SOURCES: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'knuspr', label: 'Knuspr' },
  { id: 'edeka', label: 'EDEKA' },
];

interface BotRunItem {
  productId?: number | null;
  textKey?: string | null;
  name: string;
  qty: number;
  reason?: string;
  price?: number;
}

interface BotRun {
  _id: string;
  createdAt: string;
  intent: {
    type: 'weekly' | 'occasion' | 'plan';
    occasion?: string;
    servings?: number;
    summary?: string;
  };
  items: BotRunItem[];
  totalPrice: number;
  status: 'in-cart' | 'undone' | 'delivered' | 'partially-delivered';
  destination?: Destination;
  locationContext?: { source: string; city?: string; country?: string };
  matchedOrderId?: number;
  deliveredItemCount?: number;
}

const RUN_STATUS: Record<BotRun['status'], { label: string; className: string }> = {
  'in-cart': { label: 'In cart', className: 'badge-primary' },
  undone: { label: 'Undone', className: 'badge-ghost' },
  delivered: { label: 'Delivered', className: 'badge-success' },
  'partially-delivered': { label: 'Partially delivered', className: 'badge-warning' },
};

function runTitle(run: BotRun): string {
  if (run.intent.type === 'plan' && run.intent.summary) {
    return run.intent.summary[0].toUpperCase() + run.intent.summary.slice(1);
  }
  if (run.intent.type === 'weekly') return 'Weekly fill';
  return `${run.intent.occasion ?? 'Occasion'}${run.intent.servings ? ` for ${run.intent.servings}` : ''}`;
}

export function Activity() {
  const [tab, setTab] = createSignal<'timeline' | 'runs'>('timeline');
  const [source, setSource] = createSignal<SourceFilter>('all');
  const [cursor, setCursor] = createSignal(monthStart());
  const [span, setSpan] = createSignal<Span>('month');

  const [data, setData] = createSignal<ActivityResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const [selected, setSelected] = createSignal<ActivitySummary | null>(null);
  const [detail, setDetail] = createSignal<ActivityDetail | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal<string | null>(null);
  const [undoBusy, setUndoBusy] = createSignal(false);

  const [runs, setRuns] = createSignal<BotRun[]>([]);
  const [runsLoading, setRunsLoading] = createSignal(false);
  const [runsLoaded, setRunsLoaded] = createSignal(false);
  const [expandedRun, setExpandedRun] = createSignal<string | null>(null);
  const [runError, setRunError] = createSignal<string | null>(null);

  const range = () => {
    if (span() === 'wide') {
      const to = new Date();
      return { from: new Date(to.getTime() - WIDE_DAYS * 86_400_000), to };
    }
    return monthRange(cursor());
  };

  const rangeLabel = () => (span() === 'wide' ? `Last ${WIDE_DAYS} days` : monthLabel(cursor()));

  /** The same range inside a sentence, where a leading capital reads wrong. */
  const rangeSentence = () =>
    span() === 'wide' ? `the last ${WIDE_DAYS} days` : monthLabel(cursor());

  const load = async () => {
    setLoading(true);
    setError(null);
    const { from, to } = range();
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      limit: '300',
    });
    if (source() !== 'all') params.set('provider', source());
    try {
      const res = await fetchWithTimeout(`/api/activity?${params.toString()}`);
      const body = (await res.json().catch(() => ({}))) as ActivityResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Could not read your activity.');
        return;
      }
      setData(body);
    } catch (failure) {
      console.error('Activity load failed', failure);
      setError(loadFailureCopy(failure));
    } finally {
      setLoading(false);
    }
  };

  const loadRuns = async () => {
    setRunsLoading(true);
    setRunError(null);
    try {
      const res = await fetchWithTimeout('/api/bot/runs');
      if (res.ok) {
        setRuns((await res.json()) as BotRun[]);
        setRunsLoaded(true);
      } else {
        setRunError('Could not read the bot runs.');
      }
    } catch (failure) {
      console.error('Could not load bot runs', failure);
      setRunError(loadFailureCopy(failure));
    } finally {
      setRunsLoading(false);
    }
  };

  onMount(() => {
    void load();
    // A run started in Ask changes this timeline as soon as it is delivered or
    // undone, so both panes listen to the same event the bot already fires.
    const reload = () => {
      void load();
      if (runsLoaded()) void loadRuns();
    };
    window.addEventListener('bot-run-complete', reload);
    onCleanup(() => window.removeEventListener('bot-run-complete', reload));
  });

  const changeSource = (next: SourceFilter) => {
    setSource(next);
    void load();
  };

  const changeMonth = (offset: number) => {
    setSpan('month');
    setCursor((current) => shiftMonth(current, offset));
    void load();
  };

  /** "Widen the range": three months back from today, ignoring the month cursor. */
  const widen = () => {
    setSpan('wide');
    void load();
  };

  const backToMonth = () => {
    setSpan('month');
    setCursor(monthStart());
    void load();
  };

  const isCurrentMonth = () => {
    const now = new Date();
    return cursor().getUTCFullYear() === now.getUTCFullYear() && cursor().getUTCMonth() === now.getUTCMonth();
  };

  const openDetail = async (entry: ActivitySummary) => {
    setSelected(entry);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await fetchWithTimeout(`/api/activity/${encodeURIComponent(entry.id)}`);
      const body = (await res.json().catch(() => ({}))) as ActivityDetail & { error?: string };
      if (!res.ok) {
        setDetailError(body.error ?? 'Could not read that entry.');
        return;
      }
      setDetail(body);
    } catch (failure) {
      setDetailError(loadFailureCopy(failure));
    } finally {
      setDetailLoading(false);
    }
  };

  const undo = async () => {
    const entry = detail();
    if (!entry?.runId) return;
    setUndoBusy(true);
    setDetailError(null);
    try {
      const res = await fetchWithTimeout(`/api/basket/undo/${encodeURIComponent(entry.runId)}`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        failed?: Array<{ name: string; reason: string }>;
      };
      if (!res.ok) {
        const failed = body.failed?.length
          ? ` (${body.failed.map((line) => line.name).join(', ')} stayed in the cart)`
          : '';
        setDetailError(`${body.error ?? 'Undo failed.'}${failed}`);
        return;
      }
      setSelected(null);
      window.dispatchEvent(new CustomEvent('bot-run-complete'));
      await load();
    } catch {
      setDetailError('Network error while undoing that run.');
    } finally {
      setUndoBusy(false);
    }
  };

  const undoRun = async (run: BotRun) => {
    setRunError(null);
    try {
      const res = await fetchWithTimeout(`/api/bot/runs/${run._id}/undo`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string; cartUrl?: string };
      if (!res.ok) {
        setRunError(body.error ?? 'Undo failed.');
        if (body.cartUrl) window.open(body.cartUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      window.dispatchEvent(new CustomEvent('bot-run-complete'));
      await loadRuns();
    } catch {
      setRunError('Network error while undoing that run.');
    }
  };

  const events = () => data()?.events ?? [];

  const sourceCount = (provider: Provider) =>
    events().filter((event) => event.provider === provider).length;

  const totals = () => data()?.totals;

  /** An empty range has no figures to show; the empty state already says so. */
  const shownTotals = () => (events().length > 0 ? totals() : undefined);

  const chip = (active: boolean) =>
    `btn btn-sm border-none rounded-xl px-4 ${active ? 'btn-primary shadow-sm' : 'btn-ghost opacity-80'}`;

  return (
    <div class="space-y-6 pb-12">
      <div class="animate-fade-in flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 class="page-title">Activity</h1>
          <p class="mt-1 text-base-content/85">Deliveries and in-store runs, one timeline</p>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex gap-1 rounded-xl bg-base-200 p-1">
            <button class={chip(tab() === 'timeline')} onClick={() => setTab('timeline')}>
              Timeline
            </button>
            <button
              class={chip(tab() === 'runs')}
              onClick={() => {
                setTab('runs');
                if (!runsLoaded()) void loadRuns();
              }}
            >
              Bot runs
            </button>
          </div>
          <button
            class="btn btn-ghost btn-sm btn-square"
            title={
              loading() || runsLoading()
                ? 'Already reading — wait for this answer'
                : 'Refresh'
            }
            onClick={() => (tab() === 'runs' ? void loadRuns() : void load())}
            disabled={loading() || runsLoading()}
          >
            <RefreshCw size={16} class={loading() || runsLoading() ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <Show when={tab() === 'timeline'}>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex gap-1 rounded-xl bg-base-200 p-1">
            <For each={SOURCES}>
              {(entry) => (
                <button class={chip(source() === entry.id)} onClick={() => changeSource(entry.id)}>
                  {entry.label}
                </button>
              )}
            </For>
          </div>
          <div class="flex items-center gap-1">
            <Show
              when={span() === 'month'}
              fallback={
                <>
                  <span class="min-w-[9rem] text-center text-sm font-bold">{rangeLabel()}</span>
                  <button class="btn btn-ghost btn-sm rounded-xl" onClick={backToMonth}>
                    This month
                  </button>
                </>
              }
            >
              <button
                class="btn btn-ghost btn-sm btn-square"
                onClick={() => changeMonth(-1)}
                title="Previous month"
              >
                <ChevronLeft size={16} />
              </button>
              <span class="min-w-[9rem] text-center text-sm font-bold">{rangeLabel()}</span>
              <button
                class="btn btn-ghost btn-sm btn-square"
                onClick={() => changeMonth(1)}
                disabled={isCurrentMonth()}
                title={
                  isCurrentMonth()
                    ? 'This is the newest month; there is nothing after it'
                    : 'Next month'
                }
              >
                <ChevronRight size={16} />
              </button>
            </Show>
          </div>
        </div>

        <Show when={error()}>
          <StatePanel
            tone="error"
            title="Could not read your activity"
            body={error()!}
            action={{ label: 'Try again', onClick: () => void load() }}
          />
        </Show>

        {/* The phone is the one source that stops on its own; say so here too. */}
        <CapturePanel onSynced={() => void load()} />

        <Show when={shownTotals()}>
          {(summary) => (
            <div class="grid grid-cols-2 gap-3 rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm sm:grid-cols-4">
              <div class="rounded-xl bg-base-200/50 p-3">
                <div class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-base-content/55">
                  <ProviderChip provider="knuspr" /> Knuspr
                </div>
                <div class="mt-1 text-xl font-extrabold">{euro(summary().knuspr)}</div>
                <div class="text-[10px] text-base-content/55">
                  {sourceCount('knuspr')} deliveries
                </div>
              </div>
              <div class="rounded-xl bg-base-200/50 p-3">
                <div class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-base-content/55">
                  <ProviderChip provider="edeka" /> EDEKA
                </div>
                <div class="mt-1 text-xl font-extrabold">{euro(summary().edeka)}</div>
                <div class="text-[10px] text-base-content/55">
                  {sourceCount('edeka')} store runs
                </div>
              </div>
              <div class="col-span-2 flex items-center justify-end rounded-xl bg-base-200/30 p-3 text-[11px] text-base-content/55">
                {summary().count} entries in {span() === 'wide' ? 'this range' : 'this month'}, each
                in its own store
              </div>
            </div>
          )}
        </Show>

        <Show
          when={!loading()}
          fallback={
            <div class="flex flex-col items-center gap-2 py-24">
              <span class="loading loading-spinner loading-lg text-primary" />
              <span class="text-xs text-base-content/55">Reading your activity…</span>
            </div>
          }
        >
          <Show
            when={events().length > 0}
            fallback={
              <Show when={!error()}>
                <StatePanel
                  tone="neutral"
                  title={`No purchases in ${rangeSentence()}`}
                  body="Deliveries and in-store receipts both land here. A quiet range is a real answer, not a failed read."
                  hint={
                    span() === 'month'
                      ? 'The arrows above step back one month at a time.'
                      : undefined
                  }
                  action={
                    span() === 'month'
                      ? { label: 'Widen the range', onClick: widen }
                      : { label: 'Back to this month', onClick: backToMonth }
                  }
                />
              </Show>
            }
          >
            <div class="overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm">
              <For each={events()}>
                {(entry) => (
                  <button
                    class="flex w-full items-center gap-3 border-b border-base-200 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-base-200/40"
                    onClick={() => void openDetail(entry)}
                  >
                    <ProviderChip provider={entry.provider} className="badge-lg" />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm font-bold">{activityTitle(entry)}</div>
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-base-content/60">
                        <span>{dateTime(entry.at)}</span>
                        <span>· {entry.itemCount} items</span>
                        <Show when={entry.runId}>
                          <span class="badge badge-outline badge-xs gap-0.5">
                            <BotIcon size={9} /> bot
                          </span>
                        </Show>
                        <For each={entry.occasions}>
                          {(occasion) => (
                            <span class="badge badge-secondary badge-xs">
                              {occasion.name} ×{occasion.servings}
                            </span>
                          )}
                        </For>
                      </div>
                    </div>
                    <div class="shrink-0 text-right">
                      <div class="text-sm font-extrabold">{euro(entry.total)}</div>
                      <div class="text-[10px] text-base-content/50">
                        {entry.kind === 'delivery' ? 'delivery' : 'receipt'}
                      </div>
                    </div>
                    <ChevronRight size={16} class="shrink-0 text-base-content/30" />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={tab() === 'runs'}>
        <Show when={runError()}>
          <StatePanel
            tone="error"
            title="Could not read the bot runs"
            body={runError()!}
            action={{ label: 'Try again', onClick: () => void loadRuns(), busy: runsLoading() }}
          />
        </Show>

        <Show
          when={!runsLoading()}
          fallback={
            <div class="flex flex-col items-center gap-2 py-24">
              <span class="loading loading-spinner loading-lg text-primary" />
              <span class="text-xs text-base-content/55">Reading the run history…</span>
            </div>
          }
        >
          <Show
            when={runs().length > 0}
            fallback={
              <Show when={!runError()}>
                <StatePanel
                  title="No bot runs yet"
                  body="Ask for a weekly fill, or press + on a due card. Every run that writes a basket is recorded here, with its destination and an undo."
                  action={{ label: 'Open Ask', onClick: () => openAsk('chat') }}
                />
              </Show>
            }
          >
            <div class="space-y-3">
              <For each={runs()}>
                {(run) => (
                  <div class="overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm">
                    <button
                      class="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-base-200/40"
                      onClick={() => setExpandedRun(expandedRun() === run._id ? null : run._id)}
                    >
                      <div class="rounded-xl bg-primary/10 p-2 text-primary">
                        <BotIcon size={18} />
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-bold">{runTitle(run)}</div>
                        <div class="text-[11px] text-base-content/60">
                          {dateTime(run.createdAt)} · {run.items.length} items · €
                          {run.totalPrice.toFixed(2)}
                          <Show when={run.destination}> · {destinationLabel(run.destination)}</Show>
                        </div>
                      </div>
                      <span class={`badge badge-sm font-bold ${RUN_STATUS[run.status].className}`}>
                        {RUN_STATUS[run.status].label}
                      </span>
                      <ChevronDown
                        size={16}
                        class={`shrink-0 transition-transform ${
                          expandedRun() === run._id ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    <Show when={expandedRun() === run._id}>
                      <div class="space-y-2 border-t border-base-200 p-3">
                        <For each={run.items}>
                          {(item) => (
                            <div class="flex items-start gap-2 text-xs">
                              <span class="badge badge-neutral badge-sm mt-0.5 font-mono">
                                ×{item.qty}
                              </span>
                              <div class="flex-1">
                                <div class="font-semibold">{item.name}</div>
                                <Show when={item.reason}>
                                  <div class="text-[10px] text-base-content/60">{item.reason}</div>
                                </Show>
                              </div>
                              <Show when={item.price !== undefined}>
                                <div class="font-mono text-[10px] text-base-content/70">
                                  €{((item.price ?? 0) * item.qty).toFixed(2)}
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                        <div class="flex flex-wrap items-center gap-2 border-t border-base-200 pt-2">
                          <Show when={run.status === 'in-cart'}>
                            <button
                              class="btn btn-error btn-outline btn-sm gap-1"
                              onClick={() => void undoRun(run)}
                            >
                              <Undo2 size={14} /> Undo
                            </button>
                          </Show>
                          <Show when={run.locationContext?.city}>
                            <span class="text-[10px] text-base-content/50">
                              run for {run.locationContext?.city}
                            </span>
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={selected()}>
        {(entry) => (
          <Sheet
            open
            onClose={() => setSelected(null)}
            title={activityTitle(entry())}
            subtitle={`${dateTime(entry().at)} · ${entry().itemCount} items · ${euro(entry().total)}`}
          >
            <Show when={detailError()}>
              <div class="mb-3">
                <StatePanel
                  compact
                  tone="error"
                  title="Could not read that entry"
                  body={detailError()!}
                  action={{
                    label: 'Try again',
                    onClick: () => void openDetail(entry()),
                    busy: detailLoading(),
                  }}
                />
              </div>
            </Show>

            <Show
              when={!detailLoading()}
              fallback={
                <div class="flex flex-col items-center gap-2 py-12">
                  <span class="loading loading-spinner loading-md text-primary" />
                  <span class="text-xs text-base-content/55">Reading the lines…</span>
                </div>
              }
            >
              <Show when={detail()}>
                {(entryDetail) => (
                  <div class="space-y-4">
                    <div class="flex items-center gap-2">
                      <ProviderChip provider={entryDetail().provider} />
                      <span class="text-sm font-bold">
                        {entryDetail().kind === 'delivery' ? 'Knuspr delivery' : 'In-store receipt'}
                      </span>
                      <Show when={entryDetail().place}>
                        <span class="text-xs text-base-content/60">· {entryDetail().place}</span>
                      </Show>
                    </div>

                    <Show when={entryDetail().occasions.length > 0}>
                      <div class="alert alert-info py-2 text-xs shadow-sm">
                        <span>
                          Occasion basket: {entryDetail().occasions.map((occasion) => occasion.name).join(', ')}.
                          Occasions are kept out of the weekly rate, so a big shop like this does
                          not make the same groceries look due again.
                        </span>
                      </div>
                    </Show>

                    <Show when={entryDetail().runId}>
                      <div class="rounded-xl border border-primary/25 bg-primary/5 p-3 text-[11px] text-base-content/70">
                        Filled by a bot run. Undo removes exactly these lines from the store it was
                        written to.
                      </div>
                    </Show>

                    <div class="overflow-hidden rounded-xl border border-base-300">
                      <For each={entryDetail().lines}>
                        {(line) => (
                          <div class="flex items-start gap-2 border-b border-base-200 px-3 py-2 text-xs last:border-b-0">
                            <span class="badge badge-ghost badge-sm font-mono">×{line.qty}</span>
                            <div class="min-w-0 flex-1">
                              <div class="truncate font-semibold">{line.name}</div>
                              <div class="text-[10px] text-base-content/55">
                                {euro(line.unitPrice)} each
                              </div>
                            </div>
                            <div class="font-mono text-[11px]">
                              {euro((line.unitPrice ?? 0) * line.qty)}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <Show when={entryDetail().canUndo && entryDetail().runId}>
                        <button
                          class="btn btn-error btn-outline btn-sm gap-1"
                          onClick={() => void undo()}
                          disabled={undoBusy()}
                        >
                          <Show when={undoBusy()} fallback={<Undo2 size={15} />}>
                            <span class="loading loading-spinner loading-xs" />
                          </Show>
                          Undo this run
                        </button>
                      </Show>
                      <span class="ml-auto text-sm font-extrabold">{euro(entryDetail().total)}</span>
                    </div>
                  </div>
                )}
              </Show>
            </Show>
          </Sheet>
        )}
      </Show>
    </div>
  );
}
