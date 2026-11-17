/**
 * Groceries: one list over both sources.
 *
 * Products and Inventory used to be two destinations describing the same
 * shopper; here a character has one row, one `+` and one detail sheet, and the
 * sheet keeps a separate stat row per store. The source and "due" filters are
 * the server's own parameters, so the page never re-implements the learning.
 *
 * The four ways this list can be empty are separate states, not one fallback:
 * nothing bought yet, nothing due, nothing from the chosen store, nothing
 * matching the filter. Each names its reason and offers the one way out.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { ClipboardList, Link2Off, ListPlus, MapPin, Package, Search } from 'lucide-solid';
import { BasketAddButton } from '../components/BasketAddButton';
import { ProviderBadges } from '../components/ProviderBadges';
import { ProductSheet } from '../components/ProductSheet';
import { StatePanel, type StateAction } from '../components/StatePanel';
import { providerLabel, useLocation, type Provider, type ProviderStatus } from '../lib/location';
import {
  offerFor,
  priceOf,
  providersOf,
  stockLabel,
  type BrowseItem,
  type ProductGroup,
  type ProductsResponse,
} from '../lib/browse';
import { euro, relativeDays } from '../lib/format';
import { openListFlow } from '../lib/overlays';
import { fetchWithTimeout, loadFailureCopy } from '../lib/request';

type SourceFilter = 'both' | 'knuspr' | 'edeka';

const SOURCES: Array<{ id: SourceFilter; label: string }> = [
  { id: 'both', label: 'Both' },
  { id: 'knuspr', label: 'Knuspr' },
  { id: 'edeka', label: 'EDEKA' },
];

interface EmptyState {
  title: string;
  body: string;
  hint?: string;
  action?: StateAction;
}

function initialSource(value: unknown): SourceFilter {
  return value === 'knuspr' || value === 'edeka' ? value : 'both';
}

export function Groceries() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [source, setSource] = createSignal<SourceFilter>(initialSource(searchParams.source));
  const [dueOnly, setDueOnly] = createSignal(searchParams.due === '1');
  const [query, setQuery] = createSignal(typeof searchParams.q === 'string' ? searchParams.q : '');

  const [list, setList] = createSignal<ProductsResponse | null>(null);
  const [catalog, setCatalog] = createSignal<BrowseItem[]>([]);
  const [groups, setGroups] = createSignal<ProductGroup[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const destination = () => location.state()?.destination ?? 'checklist';

  /**
   * The list flow is the EDEKA-side action: when this location writes a `+` to
   * the EDEKA list (or to a plain checklist), the page also offers the list the
   * shopper photographs or types. In Munich a `+` goes to the Knuspr cart, so
   * the flow stays on Activity instead of competing with the cart.
   */
  const listDestination = () => {
    const derived = location.state()?.destination;
    return derived === 'edeka-list' || derived === 'checklist' ? derived : null;
  };

  const loadList = async () => {
    const params = new URLSearchParams();
    if (source() !== 'both') params.set('source', source());
    if (dueOnly()) params.set('due', '1');
    const res = await fetchWithTimeout(`/api/products?${params.toString()}`);
    const body = (await res.json().catch(() => ({}))) as ProductsResponse & { error?: string };
    if (!res.ok) {
      setError(body.error ?? 'Could not read the product list.');
      return;
    }
    setList(body);
    setError(null);
  };

  /**
   * The unfiltered list is the correction catalogue: EDEKA buckets that stand
   * alone are free to be matched, and every Knuspr row is a merge candidate.
   * It is read in its own request so changing a filter never empties the
   * pickers of an open sheet.
   */
  const loadCatalog = async () => {
    const res = await fetchWithTimeout('/api/products');
    if (!res.ok) return;
    const body = (await res.json()) as ProductsResponse;
    setCatalog(body.items);
  };

  const loadGroups = async () => {
    const res = await fetchWithTimeout('/api/bot/groups');
    if (!res.ok) return;
    setGroups((await res.json()) as ProductGroup[]);
  };

  const refresh = async () => {
    await Promise.all([loadList(), loadCatalog(), loadGroups()]);
  };

  const retry = async () => {
    setLoading(true);
    try {
      await refresh();
    } catch (failure) {
      console.error('Groceries load failed', failure);
      setError(loadFailureCopy(failure));
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    void Promise.all([loadList(), loadCatalog(), loadGroups()])
      .catch((failure) => {
        console.error('Groceries load failed', failure);
        setError(loadFailureCopy(failure));
      })
      .finally(() => setLoading(false));

    // A run started elsewhere changes due counts and the cart, not this list's
    // shape, but the counts above the list should still be honest.
    const reload = () => void refresh();
    window.addEventListener('bot-run-complete', reload);
    onCleanup(() => window.removeEventListener('bot-run-complete', reload));
  });

  const changeSource = (next: SourceFilter) => {
    setSource(next);
    void loadList();
  };

  const changeWindow = (due: boolean) => {
    setDueOnly(due);
    void loadList();
  };

  const visible = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const items = list()?.items ?? [];
    return needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : items;
  });

  const selected = () => {
    const id = selectedId();
    if (!id) return undefined;
    return list()?.items.find((item) => item.id === id) ?? catalog().find((item) => item.id === id);
  };

  const statusOf = (provider: Provider): ProviderStatus | undefined =>
    location.state()?.providers.find((entry) => entry.provider === provider);

  const knusprStatus = () => statusOf('knuspr');

  /**
   * Why the list is empty. The order matters: a brand-new account explains the
   * first sync, then a filter is offered as the way back, and only then does a
   * single store get blamed.
   */
  const emptyState = (): EmptyState | null => {
    if (!list()) return null;
    if (list()!.counts.total === 0) {
      return {
        title: 'No products yet',
        body: 'Groceries learns from your purchases. Connect Knuspr in Settings and press Sync now there, or run the capture app on your phone for EDEKA receipts — the first list appears after that.',
        hint: 'The first sync imports the history and rebuilds the learning, so it can take a moment.',
        action: { label: 'Connect a store', href: '/settings' },
      };
    }
    if (query().trim()) {
      return {
        title: `No match for “${query().trim()}”`,
        body: 'The filter only looks at the rows loaded for this store and window.',
        action: { label: 'Clear the filter', onClick: () => setQuery('') },
      };
    }
    if (dueOnly()) {
      // Due is gated by availability server-side, so an away shopper gets an
      // empty list although the weekly basket exists. Naming that beats
      // "nothing is due", which would be wrong about their groceries.
      if (
        source() !== 'edeka' &&
        knusprStatus()?.connected === true &&
        knusprStatus()?.available === false
      ) {
        return {
          title: 'Due items are out of reach here',
          body: 'Knuspr does not deliver where you are, so its due items are hidden from this list. Your stock has not changed.',
          action: { label: 'Show all groceries', onClick: () => changeWindow(false) },
        };
      }
      return {
        title: 'Nothing is due',
        body: 'Every product has enough stock for the planned days.',
        action: { label: 'Show all groceries', onClick: () => changeWindow(false) },
      };
    }
    if (source() !== 'both') {
      return {
        title: `No ${providerLabel(source() as Provider)} products yet`,
        body: 'Nothing has been bought at this store, or this store has no account connected.',
        action: { label: 'Show both stores', onClick: () => changeSource('both') },
      };
    }
    return null;
  };

  /** EDEKA buckets without a Knuspr row: the only ones a match can claim. */
  const edekaBuckets = createMemo(() => {
    const buckets: Array<{ textKey: string; name: string }> = [];
    for (const item of catalog()) {
      if (!item.id.startsWith('edeka:')) continue;
      const offer = offerFor(item, 'edeka');
      if (offer?.textKey) buckets.push({ textKey: offer.textKey, name: item.name });
    }
    return buckets;
  });

  const knusprVariants = createMemo(() => {
    const variants: Array<{ productId: number; name: string }> = [];
    for (const item of catalog()) {
      const offer = offerFor(item, 'knuspr');
      if (typeof offer?.productId === 'number') {
        variants.push({ productId: offer.productId, name: item.name });
      }
    }
    return variants;
  });

  const counts = () => list()?.counts;

  const chip = (active: boolean) =>
    `btn btn-sm border-none rounded-xl px-4 ${active ? 'btn-primary shadow-sm' : 'btn-ghost opacity-80'}`;

  return (
    <div class="space-y-6 pb-12">
      <div class="animate-fade-in flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 class="page-title">Groceries</h1>
          <p class="mt-1 text-base-content/85">
            <Show when={counts()} fallback="Reading your list">
              {(data) => `${data().total} products · ${data().due} due · ${data().empty} empty`}
            </Show>
          </p>
        </div>
      </div>

      <Show when={listDestination()}>
        {(kind) => (
          <div class="flex flex-wrap items-center gap-3 rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ClipboardList size={18} />
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-bold">Shopping with a list?</div>
              <p class="mt-0.5 text-xs text-base-content/60">
                <Show
                  when={kind() === 'edeka-list'}
                  fallback="No store reaches here, so a + keeps items on a checklist. A typed or photographed list can still go to your EASY Shopper account."
                >
                  This location writes a + to your EDEKA list. Type or photograph a list to send it to
                  your phone.
                </Show>
              </p>
            </div>
            <button class="btn btn-primary btn-sm gap-2 rounded-xl" onClick={openListFlow}>
              <ListPlus size={16} /> New list
            </button>
          </div>
        )}
      </Show>

      <div class="rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-base-300 bg-base-100 px-3 py-2">
            <Search size={16} class="shrink-0 text-base-content/45" />
            <input
              class="w-full bg-transparent text-sm outline-none"
              placeholder="Filter this list…"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex gap-1 rounded-xl bg-base-200 p-1">
              <For each={SOURCES}>
                {(entry) => (
                  <button class={chip(source() === entry.id)} onClick={() => changeSource(entry.id)}>
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
            <div class="flex gap-1 rounded-xl bg-base-200 p-1">
              <button class={chip(!dueOnly())} onClick={() => changeWindow(false)}>
                All
              </button>
              <button class={chip(dueOnly())} onClick={() => changeWindow(true)}>
                Due
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* A missing account is worth saying even when the list still has rows. */}
      <Show when={knusprStatus()?.connected === false && (list()?.counts.total ?? 0) > 0}>
        <StatePanel
          compact
          tone="warning"
          icon={<Link2Off size={18} />}
          title="Knuspr is not connected"
          body="No new deliveries will be imported. The Knuspr rows stay listed from what was already learned; connecting again resumes it."
          action={{ label: 'Connect Knuspr', href: '/settings' }}
        />
      </Show>

      {/* Reach, not the account: the rows stay, the destination already follows. */}
      <Show
        when={
          knusprStatus()?.connected === true &&
          knusprStatus()?.available === false &&
          source() !== 'edeka'
        }
      >
        <StatePanel
          compact
          tone="info"
          icon={<MapPin size={18} />}
          title="Knuspr does not deliver here"
          body={knusprStatus()!.reason}
          hint="Knuspr rows stay visible. A row with an EDEKA match sends its + to the list; a row only Knuspr sells has its + switched off, with the reason."
          action={{ label: 'Show the EDEKA list', onClick: () => changeSource('edeka') }}
        />
      </Show>

      <Show when={error()}>
        <StatePanel
          tone="error"
          title="Could not read the product list"
          body={error()!}
          action={{ label: 'Try again', onClick: () => void retry(), busy: loading() }}
        />
      </Show>

      <Show
        when={!loading()}
        fallback={
          <div class="flex flex-col items-center gap-2 py-24">
            <span class="loading loading-spinner loading-lg text-primary" />
            <span class="text-xs text-base-content/55">Reading your list…</span>
          </div>
        }
      >
        <Show when={!error() || list()}>
          <Show
            when={visible().length > 0}
            fallback={
              <Show when={emptyState()}>
                {(state) => (
                  <StatePanel
                    title={state().title}
                    body={state().body}
                    hint={state().hint}
                    action={state().action}
                  />
                )}
              </Show>
            }
          >
            <div class="overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm">
              <For each={visible()}>
                {(item) => (
                  <div class="flex items-center gap-3 border-b border-base-200 px-3 py-2.5 last:border-b-0">
                    <button
                      class="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-base-200">
                        <Show
                          when={item.image}
                          fallback={<Package size={18} class="text-base-content/40" />}
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
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-bold">{item.name}</div>
                        <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-base-content/60">
                          <ProviderBadges providers={providersOf(item)} />
                          <For each={providersOf(item)}>
                            {(provider) => {
                              const stat = item.statsByProvider[provider];
                              return (
                                <span>
                                  {providerLabel(provider)}
                                  {stat?.cadenceDays
                                    ? ` · every ~${Math.round(stat.cadenceDays)} d`
                                    : (item.outsideWindow && provider === 'knuspr'
                                      ? ` · last bought ${relativeDays(stat?.lastBought)}`
                                      : '')}
                                  {stat ? ` · ${stat.purchases}×` : ''}
                                </span>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                      <div class="hidden shrink-0 flex-col items-end text-[11px] sm:flex">
                        <span class="text-sm font-extrabold text-primary">{euro(priceOf(item))}</span>
                        <span class="text-base-content/55">{stockLabel(item)}</span>
                      </div>
                    </button>
                    <BasketAddButton item={item} destination={destination()} />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      <Show when={selected()}>
        {(item) => (
          <ProductSheet
            item={item()}
            groups={groups()}
            edekaBuckets={edekaBuckets()}
            knusprVariants={knusprVariants()}
            destination={destination()}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
          />
        )}
      </Show>
    </div>
  );
}
