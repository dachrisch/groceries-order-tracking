/**
 * Search is an overlay, not a destination (S1).
 *
 * One query, three sections: our own history (instant), the EDEKA catalogue
 * (remote, may be unavailable or fail with a reason) and Knuspr, which is
 * explicitly "later" until a catalogue search exists. No product navigation
 * yet — the sheet is here so the destination question never comes before the
 * query.
 */
import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { Search } from 'lucide-solid';
import { Sheet } from './Sheet';
import { closeSearch, searchOpen } from '../lib/overlays';
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

export function SearchOverlay() {
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
      const res = await fetch(`/api/search?q=${encodeURIComponent(needle)}`);
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
      setError('Could not reach the search service.');
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

        <Show when={query().trim().length < 2}>
          <p class="text-sm text-base-content/60">Type at least two characters.</p>
        </Show>

        <Show when={error()}>
          <div class="alert alert-error">
            <span class="text-sm">{error()}</span>
          </div>
        </Show>

        <Show when={result()}>
          {(body) => (
            <>
              <Section title="In your history" meta={`${body().history.length}`}>
                <Show
                  when={body().history.length > 0}
                  fallback={<p class="text-sm text-base-content/55">Nothing you have bought matches.</p>}
                >
                  <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100">
                    <For each={body().history}>
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
              </Section>

              <Section title="EDEKA" meta="live catalogue">
                <Show
                  when={body().edeka.state === 'ok'}
                  fallback={
                    <div
                      class={`alert ${
                        body().edeka.state === 'error' ? 'alert-error' : 'alert-warning'
                      }`}
                    >
                      <span class="text-sm">{body().edeka.reason}</span>
                    </div>
                  }
                >
                  <Show
                    when={body().edeka.items.length > 0}
                    fallback={
                      <p class="text-sm text-base-content/55">
                        {body().edeka.reason || 'Nothing in the catalogue for that.'}
                      </p>
                    }
                  >
                    <div class="overflow-hidden rounded-xl border border-base-300 bg-base-100">
                      <For each={body().edeka.items}>
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
                    <Show when={body().edeka.truncated}>
                      <p class="text-[11px] text-base-content/50">
                        More matches than fit here — refine the query.
                      </p>
                    </Show>
                  </Show>
                </Show>
              </Section>

              <Section title="Knuspr" meta="live catalogue">
                <div class="alert alert-info">
                  <span class="text-sm">{body().knuspr.reason}</span>
                </div>
                <Show when={!body().knuspr.available}>
                  <p class="text-[11px] text-base-content/50">
                    Knuspr is not available where you are, so a catalogue match would not be
                    orderable anyway.
                  </p>
                </Show>
              </Section>
            </>
          )}
        </Show>

        <p class="pt-1 text-[11px] text-base-content/45">
          Search does not add anything. Basket and list actions stay in the product sheet.
        </p>
      </div>
    </Sheet>
  );
}
