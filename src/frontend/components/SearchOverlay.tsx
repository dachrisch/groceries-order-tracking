/**
 * Search is an overlay, not a destination (S1).
 *
 * One query, three sections: our own history (instant), the EDEKA catalogue
 * (remote, may be unavailable or fail with a reason) and Knuspr, which is
 * explicitly "later" until a catalogue search exists. No product navigation
 * yet — the sheet is here so the destination question never comes before the
 * query.
 *
 * The API answers history and catalogue in one response, so the history cannot
 * land before the catalogue does. While that one request is in flight the
 * sections show skeleton rows: they say what is still coming instead of
 * replacing the sheet with a blank spinner, which is what made a slow
 * catalogue look like a broken search (note S2).
 */
import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Search } from 'lucide-solid';
import { Sheet } from './Sheet';
import { StatePanel } from './StatePanel';
import { closeSearch, searchOpen } from '../lib/overlays';
import { fetchWithTimeout, loadFailureCopy } from '../lib/request';
import type { Provider } from '../lib/location';

interface SearchHistoryEntry {
  id: string;
  name: string;
  provider: Provider;
  lastBought: string | null;
  purchases: number;
  price: number | null;
}

interface EdekaCandidate {
  name: string;
  brand: string | null;
  price: number | null;
  id: string | null;
}

interface EdekaResult {
  state: 'ok' | 'unavailable' | 'error';
  reason: string;
  items: EdekaCandidate[];
  truncated: boolean;
}

interface KnusprResult {
  state: 'later';
  available: boolean;
  reason: string;
}

interface SearchResponse {
  query: string;
  history: SearchHistoryEntry[];
  edeka: EdekaResult;
  knuspr: KnusprResult;
}

const money = (value: number | null) => (value === null ? '—' : `€${value.toFixed(2)}`);

function Section(props: { title: string; meta?: string; children: JSX.Element }) {
  return (
    <div class="space-y-2">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="text-xs font-bold uppercase tracking-wide text-base-content/55">{props.title}</h3>
        <Show when={props.meta}>
          <span class="text-[11px] text-base-content/45">{props.meta}</span>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

/** Placeholder rows for a section that has not answered yet. */
function SkeletonRows(props: { count?: number }) {
  return (
    <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100" aria-hidden="true">
      <For each={Array.from({ length: props.count ?? 3 })}>
        {() => (
          <div class="flex items-center gap-3 border-b border-base-200 px-3 py-2.5 last:border-b-0">
            <span class="h-4 w-4 shrink-0 animate-pulse rounded bg-base-300" />
            <span class="h-3 flex-1 animate-pulse rounded bg-base-300" />
            <span class="h-3 w-10 shrink-0 animate-pulse rounded bg-base-300" />
          </div>
        )}
      </For>
    </div>
  );
}

export function SearchOverlay() {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');
  const [result, setResult] = createSignal<SearchResponse | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;

  onCleanup(() => {
    if (debounce) clearTimeout(debounce);
  });

  const run = async (needle: string) => {
    const id = ++requestId;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/search?q=${encodeURIComponent(needle)}`);
      const body = await res.json().catch(() => ({}));
      if (id !== requestId) return;
      if (!res.ok) {
        setError((body as { error?: string }).error ?? 'Search failed.');
        setResult(null);
        return;
      }
      setResult(body as SearchResponse);
    } catch (failure) {
      if (id !== requestId) return;
      console.error('Search failed', failure);
      setError(loadFailureCopy(failure));
      setResult(null);
    } finally {
      if (id === requestId) setLoading(false);
    }
  };

  const onInput = (value: string) => {
    setQuery(value);
    if (debounce) clearTimeout(debounce);
    const needle = value.trim();
    if (needle.length < 2) {
      requestId++;
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Invalidate an answer already in flight for the previous keystroke.
    requestId++;
    debounce = setTimeout(() => void run(needle), 250);
  };

  /** An answer belongs to the text in the box; anything else is stale. */
  const answered = () => {
    const body = result();
    return body !== null && body.query.trim().toLowerCase() === query().trim().toLowerCase();
  };

  const emptyQuery = () => query().trim().length < 2;

  const nothingFound = () =>
    answered() &&
    !loading() &&
    result()!.history.length === 0 &&
    result()!.edeka.state === 'ok' &&
    result()!.edeka.items.length === 0;

  const goToSettings = () => {
    closeSearch();
    navigate('/settings');
  };

  const edekaAction = () => {
    const edeka = result()?.edeka;
    if (edeka?.state === 'error') {
      return { label: 'Try again', onClick: () => void run(query().trim()) };
    }
    if (edeka?.state === 'unavailable' && edeka.reason.toLowerCase().includes('not connected')) {
      return { label: 'Connect EDEKA', onClick: goToSettings };
    }
    return { label: 'Check your location', onClick: goToSettings };
  };

  return (
    <Sheet
      open={searchOpen()}
      onClose={closeSearch}
      title="Search"
      subtitle="Your history first, then the stores"
    >
      <div class="space-y-4">
        <label class="input input-bordered flex items-center gap-2">
          <Search size={18} class="text-base-content/50" />
          <input
            class="grow"
            placeholder="Milch, Brot, Waschmittel…"
            value={query()}
            onInput={(event) => onInput(event.currentTarget.value)}
            ref={(element) => setTimeout(() => element.focus(), 0)}
            aria-label="Search products"
          />
          <Show when={loading()}>
            <span class="loading loading-spinner loading-xs" />
          </Show>
        </label>

        {/* Empty query: say what the box will do instead of leaving it blank. */}
        <Show when={emptyQuery()}>
          <div class="space-y-1.5 rounded-xl border border-base-300 bg-base-200/40 p-3">
            <p class="text-sm font-semibold">Your own history answers first.</p>
            <p class="text-xs text-base-content/65">
              Search looks at what you have already bought — deliveries and in-store receipts —
              then at the EDEKA catalogue for your store. Two letters are enough.
            </p>
            <p class="text-[11px] text-base-content/45">
              Knuspr catalogue search is not connected yet; its purchase history is still searched.
            </p>
          </div>
        </Show>

        <Show when={error()}>
          <StatePanel
            compact
            tone="error"
            title="That search did not finish"
            body={error()!}
            action={{ label: 'Try again', onClick: () => void run(query().trim()) }}
          />
        </Show>

        <Show when={!emptyQuery()}>
          <Section
            title="In your history"
            meta={answered() && !loading() ? `${result()!.history.length}` : 'searching'}
          >
            <Show when={answered() && !loading()} fallback={<SkeletonRows count={2} />}>
              <Show
                when={result()!.history.length > 0}
                fallback={
                  <p class="text-sm text-base-content/55">Nothing you have bought matches.</p>
                }
              >
                <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100">
                  <For each={result()!.history}>
                    {(entry) => (
                      <div class="flex items-center gap-3 border-b border-base-200 px-3 py-2 last:border-b-0">
                        <span
                          class={`badge badge-sm font-bold ${
                            entry.provider === 'knuspr' ? 'badge-primary' : 'badge-secondary'
                          }`}
                        >
                          {entry.provider === 'knuspr' ? 'K' : 'E'}
                        </span>
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-sm font-semibold">{entry.name}</div>
                          <div class="text-[11px] text-base-content/55">
                            {entry.purchases}× bought
                            {entry.lastBought
                              ? ` · last ${new Date(entry.lastBought).toLocaleDateString()}`
                              : ''}
                          </div>
                        </div>
                        <span class="font-mono text-xs text-base-content/70">
                          {money(entry.price)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Section>

          <Section
            title="EDEKA"
            meta={answered() && !loading() ? 'live catalogue' : 'asking the store…'}
          >
            <Show when={answered() && !loading()} fallback={<SkeletonRows count={3} />}>
              <Show
                when={result()!.edeka.state === 'ok'}
                fallback={
                  <StatePanel
                    compact
                    tone={result()!.edeka.state === 'error' ? 'error' : 'warning'}
                    title={
                      result()!.edeka.state === 'error'
                        ? 'The EDEKA catalogue did not answer'
                        : 'EDEKA is not searchable here'
                    }
                    body={result()!.edeka.reason}
                    action={edekaAction()}
                  />
                }
              >
                <Show
                  when={result()!.edeka.items.length > 0}
                  fallback={
                    <p class="text-sm text-base-content/55">
                      {result()!.edeka.reason || 'Nothing in the catalogue for that.'}
                    </p>
                  }
                >
                  <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100">
                    <For each={result()!.edeka.items}>
                      {(item) => (
                        <div class="flex items-center gap-3 border-b border-base-200 px-3 py-2 last:border-b-0">
                          <span class="badge badge-secondary badge-sm font-bold">E</span>
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-sm font-semibold">{item.name}</div>
                            <Show when={item.brand}>
                              <div class="text-[11px] text-base-content/55">{item.brand}</div>
                            </Show>
                          </div>
                          <span class="font-mono text-xs text-base-content/70">
                            {money(item.price)}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={result()!.edeka.truncated}>
                    <p class="text-[11px] text-base-content/50">
                      More matches than fit here — refine the query.
                    </p>
                  </Show>
                </Show>
              </Show>
            </Show>
          </Section>

          {/* Knuspr is a planned state, not a failure, so it gets no action. */}
          <Show when={answered() && !loading()}>
            <Section title="Knuspr" meta="later">
              <StatePanel
                compact
                tone="info"
                title="Knuspr catalogue search is not connected yet"
                body={
                  result()!.knuspr.available
                    ? 'Its purchase history is searched above; a live catalogue needs its own endpoint.'
                    : 'Its purchase history is searched above. It also does not deliver where you are, so a catalogue hit would not be orderable.'
                }
              />
            </Section>
          </Show>

          <Show when={nothingFound()}>
            <StatePanel
              tone="neutral"
              title={`Nothing found for “${query().trim()}”`}
              body="Not in what you have bought, and not in the EDEKA catalogue at this store."
              hint="Search does not add anything; basket and list actions stay in the product sheet."
              action={{
                label: 'Add as free text',
                disabledReason:
                  'A free-text line is written to the EDEKA list, and this search sheet cannot write to it.',
              }}
            />
          </Show>
        </Show>

        <p class="pt-1 text-[11px] text-base-content/45">
          Search does not add anything. Basket and list actions stay in the product sheet.
        </p>
      </div>
    </Sheet>
  );
}
