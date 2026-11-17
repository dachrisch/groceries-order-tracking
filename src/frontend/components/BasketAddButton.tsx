/**
 * The one `+`: a product row, a due card and an offer all send their line
 * through the basket contract, and all of them show the server's refusal
 * verbatim.
 *
 * The button never decides reachability: `POST /api/basket/add` answers `409`
 * with the availability reason or the guardrail that refused the run, and that
 * string is what the shopper sees. A greyed-out button would only hide the
 * reason, not protect the cart.
 */
import { createSignal, onCleanup, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Check, Plus } from 'lucide-solid';
import { destinationLabel, type Destination } from '../lib/location';
import type { AddTarget } from '../lib/browse';

export function BasketAddButton(props: {
  item: AddTarget;
  /** The location's destination; a row may still fall back to its own store. */
  destination: Destination;
  size?: 'xs' | 'sm';
  /** A label turns the square button into a wide one, e.g. in a product sheet. */
  label?: string;
}) {
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A refusal that a connection would fix must not read like a dead end.
  const [needsConnect, setNeedsConnect] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (resetTimer) clearTimeout(resetTimer);
  });

  /**
   * The store this line belongs to. A checklist has no store; anything else
   * must match the line's provider, or the server would skip it.
   */
  const target = (): Destination => {
    if (props.destination === 'checklist') return 'checklist';
    if (props.destination === 'knuspr-cart' && props.item.provider === 'knuspr') return 'knuspr-cart';
    if (props.destination === 'edeka-list' && props.item.provider === 'edeka') return 'edeka-list';
    return props.item.provider === 'knuspr' ? 'knuspr-cart' : 'edeka-list';
  };

  const add = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    setNeedsConnect(false);
    try {
      const res = await fetch('/api/basket/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: target(),
          items: [
            {
              provider: props.item.provider,
              productId: props.item.productId,
              textKey: props.item.textKey,
              name: props.item.name,
              qty: props.item.qty ?? 1,
            },
          ],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        code?: string;
        error?: string;
        added?: unknown[];
        skipped?: Array<{ name: string; reason: string }>;
      };

      if (!res.ok) {
        // 409 is the availability, connection or guardrail refusal; its message
        // is the copy, and a missing account gets the action that fixes it.
        setError(body.error ?? 'That could not be added.');
        setNeedsConnect(body.code === 'edeka-not-connected');
        return;
      }
      if (body.status === 'added' && (body.added?.length ?? 0) > 0) {
        setDone(true);
        window.dispatchEvent(new CustomEvent('bot-run-complete'));
        resetTimer = setTimeout(() => setDone(false), 2500);
        return;
      }
      const skipped = body.skipped?.[0];
      setError(skipped ? `${skipped.name}: ${skipped.reason}` : body.error ?? 'Nothing was added.');
    } catch {
      setError('Network error while adding that.');
    } finally {
      setBusy(false);
    }
  };

  const size = () => (props.size === 'sm' ? 'btn-sm' : 'btn-xs');

  return (
    <div class="flex flex-col items-end gap-1">
      <button
        type="button"
        class={`btn btn-primary ${size()} ${props.label ? 'gap-1' : 'btn-square'}`}
        onClick={add}
        disabled={busy()}
        title={`Add to ${destinationLabel(target())}`}
        aria-label={`Add ${props.item.name} to ${destinationLabel(target())}`}
      >
        <Show when={busy()}>
          <span class="loading loading-spinner loading-xs" />
        </Show>
        <Show when={!busy()}>
          <Show when={done()} fallback={<Plus size={props.size === 'sm' ? 16 : 14} />}>
            <Check size={props.size === 'sm' ? 16 : 14} />
          </Show>
        </Show>
        <Show when={props.label}>
          <span>{done() ? 'Added' : props.label}</span>
        </Show>
      </button>
      <Show when={error()}>
        <span class="max-w-[11rem] text-right text-[10px] leading-tight text-error">{error()}</span>
      </Show>
      <Show when={needsConnect()}>
        <A href="/settings" class="text-[10px] font-semibold text-primary underline">
          Connect EDEKA
        </A>
      </Show>
    </div>
  );
}
