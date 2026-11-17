/**
 * Groceries: one list over both sources.
 *
 * Products and Inventory used to be two destinations describing the same
 * shopper; here a character has one row, one `+` and one detail sheet, and the
 * sheet keeps a separate stat row per store. The source and "due" filters are
 * the server's own parameters, so the page never re-implements the learning.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { Package, Search } from 'lucide-solid';
import { BasketAddButton } from '../components/BasketAddButton';
import { ProviderBadges } from '../components/ProviderBadges';
import { ProductSheet } from '../components/ProductSheet';
import { providerLabel, useLocation, type Provider } from '../lib/location';
import {
  addTargetFor,
  offerFor,
  priceOf,
  providersOf,
  stockLabel,
  type BrowseItem,
  type ProductGroup,
  type ProductsResponse,
} from '../lib/browse';
import { euro, relativeDays } from '../lib/format';

type SourceFilter = 'both' | 'knuspr' | 'edeka';

const SOURCES: Array<{ id: SourceFilter; label: string }> = [
  { id: 'both', label: 'Both' },
  { id: 'knuspr', label: 'Knuspr' },
  { id: 'edeka', label: 'EDEKA' },
];

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

  const loadList = async () => {
    const params = new URLSearchParams();
    if (source() !== 'both') params.set('source', source());
    if (dueOnly()) params.set('due', '1');
    const res = await fetch(`/api/products?${params.toString()}`);
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
    const res = await fetch('/api/products');
    if (!res.ok) return;
    const body = (await res.json()) as ProductsResponse;
    setCatalog(body.items);
  };

  const loadGroups = async () => {
    const res = await fetch('/api/bot/groups');
    if (!res.ok) return;
    setGroups((await res.json()) as ProductGroup[]);
  };

  const refresh = async () => {
    await Promise.all([loadList(), loadCatalog(), loadGroups()]);
  };

  onMount(() => {
    void Promise.all([loadList(), loadCatalog(), loadGroups()])
      .catch((failure) => {
        console.error('Groceries load failed', failure);
        setError('Could not reach the server.');
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
              {(data) =>
                `${data().total} products · ${data().due} due · ${data().empty} empty`
              }
            </Show>
          </p>
        </div>
      </div>

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
        <Show
          when={visible().length > 0}
          fallback={
            <div class="rounded-2xl border border-base-300 bg-base-100 p-10 text-center shadow-sm">
              <Show
                when={query().trim().length > 0}
                fallback={
                  <Show
                    when={dueOnly()}
                    fallback={
                      <Show
                        when={source() !== 'both'}
                        fallback={
                          <>
                            <h2 class="text-lg font-bold">No products yet</h2>
                            <p class="mt-1 text-sm text-base-content/65">
                              Connect Knuspr in Settings or import an in-store receipt to start the
                              list.
                            </p>
                          </>
                        }
                      >
                        <h2 class="text-lg font-bold">
                          No {providerLabel(source() as Provider)} products yet
                        </h2>
                        <p class="mt-1 text-sm text-base-content/65">
                          Switch to Both to see the other store's list.
                        </p>
                        <button class="btn btn-ghost btn-sm mt-3" onClick={() => changeSource('both')}>
                          Show both stores
                        </button>
                      </Show>
                    }
                  >
                    <h2 class="text-lg font-bold">Nothing is due</h2>
                    <p class="mt-1 text-sm text-base-content/65">
                      Your stock covers the next few days.
                    </p>
                    <button class="btn btn-ghost btn-sm mt-3" onClick={() => changeWindow(false)}>
                      Show all groceries
                    </button>
                  </Show>
                }
              >
                <h2 class="text-lg font-bold">No match for “{query()}”</h2>
                <p class="mt-1 text-sm text-base-content/65">
                  Clear the filter to see the whole list.
                </p>
              </Show>
            </div>
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
                  <Show when={addTargetFor(item, destination())}>
                    {(target) => <BasketAddButton item={target()} destination={destination()} />}
                  </Show>
                </div>
              )}
            </For>
          </div>
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
            windowDays={list()?.windowDays ?? 182}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
          />
        )}
      </Show>
    </div>
  );
}
