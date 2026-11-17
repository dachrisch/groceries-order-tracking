/**
 * The one `+`: a product row, a due card and an offer all send their line
 * through the basket contract, and all of them show the server's refusal
 * verbatim.
 *
 * What the button can decide locally is reach: `resolveAdd` knows, from the same
 * location data the pages render, whether this line's store is reachable at all.
 * A store that cannot be reached disables the button with its reason instead of
 * firing a request whose only outcome is a red 409 — and when the row has a
 * cross-store match, that match is offered instead.
 *
 * Everything else stays the server's call: the guardrail, the account, the
 * availability race between render and click.
 */
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { Check, Plus } from 'lucide-solid';
import { destinationLabel, useLocation, type Destination } from '../lib/location';
import { resolveAdd } from '../lib/basket-target';
import type { BrowseItem, BrowseOffer } from '../lib/browse';

export function BasketAddButton(props: {
  /** The row, not a pre-picked line: the decision needs its offers to fall back. */
  item: BrowseItem;
  /** The location's destination; the row's own store is the fallback. */
  destination: Destination;
  /** Pin one offer, for a button that sits inside "Where to get it". */
  offer?: BrowseOffer;
  size?: 'xs' | 'sm';
  /** A label turns the square button into a wide one, e.g. in a product sheet. */
  label?: string;
}) {
  const location = useLocation();
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
   * Recomputed from the location store, so a location change disables or
   * re-enables every `+` on the page without a reload.
   */
  const decision = createMemo(() =>
    resolveAdd(props.item, props.destination, location.state()?.providers ?? null, props.offer)
  );

  const unavailableReason = () => {
    const plan = decision();
    return plan.kind === 'unavailable' ? plan.reason : null;
  };

  const label = () => {
    const plan = decision();
    if (plan.kind === 'unavailable') {
      return `Cannot add ${props.item.name}: ${plan.reason}`;
    }
    return `Add ${plan.item.name} to ${destinationLabel(plan.destination)}`;
  };

  const add = async () => {
    const plan = decision();
    if (plan.kind !== 'add' || busy()) return;
    setBusy(true);
    setError(null);
    setNeedsConnect(false);
    try {
      const res = await fetch('/api/basket/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination: plan.destination,
          items: [
            {
              provider: plan.item.provider,
              productId: plan.item.productId,
              textKey: plan.item.textKey,
              name: plan.item.name,
              qty: plan.item.qty ?? 1,
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
  const disabled = () => busy() || unavailableReason() !== null;

  return (
    <div class="flex flex-col items-end gap-1">
      <button
        type="button"
        class={`btn btn-primary ${size()} ${props.label ? 'gap-1' : 'btn-square'}`}
        onClick={add}
        disabled={disabled()}
        title={unavailableReason() ?? label()}
        aria-label={label()}
        aria-description={unavailableReason() ?? undefined}
        aria-disabled={disabled()}
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
