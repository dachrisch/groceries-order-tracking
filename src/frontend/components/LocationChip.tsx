/**
 * The city chip and its read-only "Where are you?" sheet.
 *
 * Every page depends on the same answer, so the chip sits in the shell header
 * and reads the shared location store. Editing home city and away windows
 * belongs to Settings; this sheet only explains what the app currently thinks
 * and why each source is or is not reachable.
 */
import { createSignal, For, Show } from 'solid-js';
import { MapPin, RefreshCw } from 'lucide-solid';
import { Sheet } from './Sheet';
import {
  destinationLabel,
  formatAwayWindow,
  providerLabel,
  useLocation,
} from '../lib/location';

export function LocationChip(props: { compact?: boolean }) {
  const location = useLocation();
  const [open, setOpen] = createSignal(false);

  const context = () => location.state()?.context;
  const city = () => context()?.city ?? 'Set location';
  const sourceLabel = () => {
    const source = context()?.source;
    if (source === 'home') return 'home';
    if (source === 'away') return 'away';
    return 'unknown';
  };

  return (
    <>
      <button
        class="btn btn-ghost btn-sm gap-1.5 rounded-full border border-base-300 bg-base-100/80 px-3 font-medium"
        onClick={() => setOpen(true)}
        title="Where are you?"
      >
        <MapPin size={16} class="text-primary" />
        <span class="max-w-[9rem] truncate text-xs font-semibold">{city()}</span>
        <Show when={!props.compact && context()?.source !== 'unknown'}>
          <span class="text-[11px] text-base-content/50">{sourceLabel()}</span>
        </Show>
      </button>

      <Sheet
        open={open()}
        onClose={() => setOpen(false)}
        title="Where are you?"
        subtitle="Coverage decides what can be ordered. It never orders for you."
      >
        <Show
          when={location.state()}
          fallback={
            <div class="space-y-3">
              <Show
                when={location.error()}
                fallback={
                  <div class="flex justify-center p-10">
                    <span class="loading loading-spinner loading-lg text-primary" />
                  </div>
                }
              >
                <div class="alert alert-error">
                  <span class="text-sm">{location.error()}</span>
                </div>
              </Show>
              <button class="btn btn-outline btn-sm gap-2" onClick={() => void location.refresh()}>
                <RefreshCw size={15} /> Try again
              </button>
            </div>
          }
        >
          {(state) => (
            <div class="space-y-3">
              <div class="rounded-xl border border-base-300 bg-base-200/50 p-4">
                <div class="flex items-center gap-2">
                  <MapPin size={18} class="text-primary" />
                  <h3 class="text-base font-bold">
                    {state().context.source === 'unknown'
                      ? 'Location not set'
                      : `${state().context.source === 'away' ? 'Away' : 'Home'} · ${
                          state().context.city ?? ''
                        }`}
                  </h3>
                </div>
                <p class="mt-1 text-xs text-base-content/65">
                  <Show
                    when={state().context.awayWindow}
                    fallback={
                      state().context.source === 'unknown'
                        ? 'Set your home city in Settings. Until then both sources stay available.'
                        : `${state().context.city} is treated as home.`
                    }
                  >
                    {(window) => (
                      <>
                        Away in {window().city} from {formatAwayWindow(window())}. This window wins
                        over your home city.
                      </>
                    )}
                  </Show>
                </p>
              </div>

              <div class="space-y-2">
                <For each={state().providers}>
                  {(provider) => (
                    <div class="flex items-start gap-3 rounded-xl border border-base-300 bg-base-100 p-3">
                      <span
                        class={`badge badge-sm font-bold ${
                          provider.provider === 'knuspr' ? 'badge-primary' : 'badge-secondary'
                        }`}
                      >
                        {provider.provider === 'knuspr' ? 'K' : 'E'}
                      </span>
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-bold">{providerLabel(provider.provider)}</span>
                          <span
                            class={`badge badge-sm ${
                              provider.available ? 'badge-success' : 'badge-ghost'
                            }`}
                          >
                            {provider.available ? 'Available' : 'Not here'}
                          </span>
                        </div>
                        <p class="text-[11px] text-base-content/65">{provider.reason}</p>
                        <p class="mt-0.5 text-[10px] text-base-content/45">
                          {provider.connected ? 'Account connected' : 'No account connected'}
                          {provider.lastSyncAt
                            ? ` · last sync ${new Date(provider.lastSyncAt).toLocaleDateString()}`
                            : ''}
                        </p>
                      </div>
                    </div>
                  )}
                </For>
              </div>

              <div class="rounded-xl border border-primary/25 bg-primary/5 p-3">
                <div class="text-[10px] font-bold uppercase tracking-wide text-base-content/55">
                  Destination for a plain +
                </div>
                <div class="text-sm font-bold">{destinationLabel(state().destination)}</div>
                <p class="text-[11px] text-base-content/65">{state().reason}</p>
              </div>

              <p class="text-[11px] text-base-content/50">
                Your home city and away windows are edited in Settings. Coverage never changes a
                basket on its own.
              </p>

              <button
                class="btn btn-ghost btn-sm gap-2"
                onClick={() => void location.refresh()}
                disabled={location.loading()}
              >
                <RefreshCw size={15} class={location.loading() ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          )}
        </Show>
      </Sheet>
    </>
  );
}
