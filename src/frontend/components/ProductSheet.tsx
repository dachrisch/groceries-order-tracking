/**
 * One product, both stores — one stat row per provider, never an average.
 *
 * The sheet is also the only correction surface left for the learning now that
 * the Groups page lives inside Ask: "Same as…" merges two variants the rules
 * missed, "Split" undoes a manual merge, and the EDEKA match can be changed or
 * cleared. The match stays display-only: nothing on this sheet may feed a rate,
 * a stock estimate or a due decision.
 */
import { createMemo, createSignal, For, Show } from 'solid-js';
import { AlertCircle, Package } from 'lucide-solid';
import { Sheet } from './Sheet';
import { BasketAddButton } from './BasketAddButton';
import { ProviderChip } from './ProviderBadges';
import { destinationLabel, providerLabel, type Destination, type Provider } from '../lib/location';
import {
  addTargetFor,
  offerFor,
  priceOf,
  providersOf,
  stockLabel,
  type BrowseItem,
  type ProductGroup,
} from '../lib/browse';
import { euro, relativeDays } from '../lib/format';

interface EdekaBucket {
  textKey: string;
  name: string;
}

interface KnusprVariant {
  productId: number;
  name: string;
}

type Picker = 'edeka' | 'group' | null;

export function ProductSheet(props: {
  item: BrowseItem;
  groups: ProductGroup[];
  edekaBuckets: EdekaBucket[];
  knusprVariants: KnusprVariant[];
  destination: Destination;
  /** Length of the rate window, so "outside it" can be said in weeks. */
  windowDays?: number;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [picker, setPicker] = createSignal<Picker>(null);
  const [filter, setFilter] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  /** A Knuspr row's representative product id: the handle for every correction. */
  const productId = () => offerFor(props.item, 'knuspr')?.productId;

  const groupOf = createMemo(() => {
    const id = productId();
    return id === undefined
      ? undefined
      : props.groups.find((group) => group.productIds.includes(id));
  });

  const manualGroup = () => {
    const group = groupOf();
    return group?.manual ? group : undefined;
  };

  /**
   * The id the split endpoint needs. `GET /api/bot/groups` does not expose it
   * today, so Split is only offered when the response carries one; calling
   * `/groups/undefined/split` would be a worse affordance than no button.
   */
  const splitGroupId = () => manualGroup()?._id ?? manualGroup()?.id;

  const match = (needle: string, name: string) => name.toLowerCase().includes(needle.trim().toLowerCase());

  const edekaChoices = createMemo(() =>
    props.edekaBuckets.filter((bucket) => match(filter(), bucket.name))
  );
  const variantChoices = createMemo(() =>
    props.knusprVariants.filter(
      (variant) => variant.productId !== productId() && match(filter(), variant.name)
    )
  );
  const choices = createMemo<Array<EdekaBucket | KnusprVariant>>(() =>
    picker() === 'edeka' ? edekaChoices() : variantChoices()
  );

  const openPicker = (next: Picker) => {
    setFilter('');
    setError(null);
    setNotice(null);
    setPicker(next);
  };

  const readError = async (res: Response): Promise<string | null> => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? null : body.error ?? 'That did not work.';
  };

  /** Record, change or clear the questionably-named cross-store match. */
  const saveLink = async (textKey: string | null) => {
    const id = productId();
    if (id === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/product-links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ knusprProductId: id, edekaTextKey: textKey }),
      });
      const failure = await readError(res);
      if (failure) {
        setError(failure);
        return;
      }
      setPicker(null);
      setNotice(textKey === null ? 'EDEKA match cleared.' : 'EDEKA match saved.');
      await props.onChanged();
    } catch {
      setError('Network error while saving that match.');
    } finally {
      setBusy(false);
    }
  };

  const mergeWith = async (variant: KnusprVariant) => {
    const id = productId();
    if (id === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/bot/groups/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [id, variant.productId] }),
      });
      const failure = await readError(res);
      if (failure) {
        setError(failure);
        return;
      }
      await props.onChanged();
      // The row's group key changed, so this sheet's identity is gone: close it
      // and let the merged row speak for itself.
      props.onClose();
    } catch {
      setError('Network error while merging those products.');
    } finally {
      setBusy(false);
    }
  };

  const splitFromGroup = async () => {
    const id = productId();
    const groupId = splitGroupId();
    if (id === undefined || !groupId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bot/groups/${groupId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: id }),
      });
      const failure = await readError(res);
      if (failure) {
        setError(failure);
        return;
      }
      await props.onChanged();
      props.onClose();
    } catch {
      setError('Network error while splitting that group.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * An outside-window row has no cadence on purpose; saying "no rhythm yet"
   * would read as a new product, when the truth is that the last purchase is
   * simply older than the window.
   */
  const cadenceText = (provider: Provider, stat: { cadenceDays: number | null }) => {
    if (stat.cadenceDays) return `every ~${Math.round(stat.cadenceDays)} d`;
    if (provider === 'knuspr' && props.item.outsideWindow) {
      const weeks = Math.max(1, Math.round((props.windowDays ?? 182) / 7));
      return `not in ${weeks} weeks`;
    }
    return 'no rhythm yet';
  };

  const statRow = (provider: Provider) => {
    const stat = props.item.statsByProvider[provider];
    if (!stat) return null;
    return (
      <div class="rounded-xl border border-base-300 bg-base-200/40 p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 text-xs font-bold">
            <ProviderChip provider={provider} /> {providerLabel(provider)}
          </span>
          <span class="text-[10px] text-base-content/50">last {relativeDays(stat.lastBought)}</span>
        </div>
        <div class="mt-2 grid grid-cols-3 gap-2">
          <div>
            <div class="text-[9px] font-bold uppercase tracking-wide text-base-content/45">Every</div>
            <div class="text-sm font-bold">{cadenceText(provider, stat)}</div>
          </div>
          <div>
            <div class="text-[9px] font-bold uppercase tracking-wide text-base-content/45">Bought</div>
            <div class="text-sm font-bold">{stat.purchases}×</div>
          </div>
          <div>
            <div class="text-[9px] font-bold uppercase tracking-wide text-base-content/45">Avg price</div>
            <div class="text-sm font-bold">{euro(stat.avgPrice)}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Sheet
      open
      onClose={props.onClose}
      title={props.item.name}
      subtitle={[props.item.groupLabel, stockLabel(props.item)].filter(Boolean).join(' · ')}
    >
      <div class="space-y-4">
        <div class="flex items-start gap-3">
          <div class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-base-200">
            <Show
              when={props.item.image}
              fallback={<Package size={26} class="text-base-content/40" />}
            >
              {(image) => <img src={image()} alt="" class="h-full w-full object-cover" />}
            </Show>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <For each={providersOf(props.item)}>
                {(provider) => <ProviderChip provider={provider} />}
              </For>
              <span class="text-xs font-semibold text-base-content/60">
                {providersOf(props.item).length > 1 ? 'bought in both stores' : 'one store'}
              </span>
            </div>
            <div class="mt-1 text-lg font-extrabold text-primary">{euro(priceOf(props.item))}</div>
            <p class="text-[11px] text-base-content/55">
              + writes to {destinationLabel(props.destination)}. Each offer below can go to its own
              store.
            </p>
          </div>
          <Show when={addTargetFor(props.item, props.destination)}>
            {(target) => <BasketAddButton item={target()} destination={props.destination} size="sm" label="Add" />}
          </Show>
        </div>

        <Show when={error()}>
          <div class="alert alert-error py-2 shadow-sm">
            <AlertCircle size={16} />
            <span class="text-xs font-semibold">{error()}</span>
            <button class="btn btn-ghost btn-xs" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        </Show>

        <Show when={notice()}>
          <div class="alert alert-success py-2 shadow-sm">
            <span class="text-xs font-semibold">{notice()}</span>
          </div>
        </Show>

        <section class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wide text-base-content/55">
            Per store, never averaged
          </h3>
          <For each={providersOf(props.item)}>{(provider) => statRow(provider)}</For>
        </section>

        <section class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wide text-base-content/55">
            Where to get it
          </h3>
          <For each={props.item.offers}>
            {(offer) => (
              <div class="flex items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3">
                <ProviderChip provider={offer.provider} />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 text-sm font-bold">
                    {providerLabel(offer.provider)}
                    <span class="text-primary">{euro(offer.price)}</span>
                  </div>
                  <div
                    class={`text-[11px] leading-tight ${
                      offer.available ? 'text-base-content/60' : 'text-error'
                    }`}
                  >
                    {offer.available ? offer.reason : `Not orderable here — ${offer.reason}`}
                  </div>
                </div>
                <Show when={offer.available}>
                  <BasketAddButton
                    item={{
                      provider: offer.provider,
                      name: props.item.name,
                      productId: offer.productId,
                      textKey: offer.textKey,
                    }}
                    destination={offer.provider === 'knuspr' ? 'knuspr-cart' : 'edeka-list'}
                    size="sm"
                    label="Add"
                  />
                </Show>
              </div>
            )}
          </For>
        </section>

        <Show when={productId() !== undefined}>
          <section class="rounded-xl border border-base-300 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs font-bold">EDEKA match</span>
              <div class="flex items-center gap-1">
                <Show
                  when={props.item.linked}
                  fallback={
                    <button class="btn btn-ghost btn-xs" onClick={() => openPicker('edeka')}>
                      Match…
                    </button>
                  }
                >
                  {(linked) => (
                    <>
                      <span class="badge badge-secondary badge-sm font-semibold">
                        matched by name
                        {linked().source === 'manual'
                          ? ' · your correction'
                          : ` · ${Math.round(linked().confidence * 100)}%`}
                      </span>
                      <button class="btn btn-ghost btn-xs" onClick={() => openPicker('edeka')}>
                        Change
                      </button>
                      <button
                        class="btn btn-ghost btn-xs text-error"
                        onClick={() => void saveLink(null)}
                        disabled={busy()}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </Show>
              </div>
            </div>
            <p class="mt-1 text-[10px] leading-tight text-base-content/50">
              The match only moves this EDEKA row next to the Knuspr one. It never changes a rate,
              stock or what is due.
            </p>
          </section>

          <section class="rounded-xl border border-base-300 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs font-bold">Learning group</span>
              <span class="truncate text-[11px] text-base-content/60">
                {groupOf()?.label ?? props.item.groupLabel ?? 'not grouped'}
              </span>
            </div>
            <div class="mt-2 flex flex-wrap gap-2">
              <button
                class="btn btn-ghost btn-xs"
                onClick={() => openPicker('group')}
                disabled={busy()}
              >
                Same as…
              </button>
              <Show when={splitGroupId()}>
                <button
                  class="btn btn-ghost btn-xs"
                  onClick={() => void splitFromGroup()}
                  disabled={busy()}
                >
                  Split
                </button>
              </Show>
            </div>
            <p class="mt-1 text-[10px] leading-tight text-base-content/50">
              Merging tells the bot two variants are one product. Splitting undoes a manual merge,
              so the learning keeps matching your shopping.
            </p>
          </section>
        </Show>

        <Show when={picker()}>
          <div class="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-bold">
                {picker() === 'edeka'
                  ? 'Which EDEKA product is this?'
                  : 'Same product as…'}
              </span>
              <button class="btn btn-ghost btn-xs" onClick={() => setPicker(null)}>
                Cancel
              </button>
            </div>
            <input
              class="input input-bordered input-sm mt-2 w-full"
              placeholder="Filter by name…"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
            <div class="mt-2 max-h-52 space-y-1 overflow-y-auto">
              <For each={choices()}>
                {(choice) => (
                  <button
                    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-base-200"
                    disabled={busy()}
                    onClick={() =>
                      picker() === 'edeka'
                        ? void saveLink((choice as EdekaBucket).textKey)
                        : void mergeWith(choice as KnusprVariant)
                    }
                  >
                    <ProviderChip provider={picker() === 'edeka' ? 'edeka' : 'knuspr'} />
                    <span class="flex-1 truncate">{choice.name}</span>
                  </button>
                )}
              </For>
              <Show when={choices().length === 0}>
                <p class="px-2 py-3 text-[11px] text-base-content/55">
                  {picker() === 'edeka'
                    ? 'No EDEKA product to match yet — import an in-store receipt first.'
                    : 'No other product to merge with here.'}
                </p>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Sheet>
  );
}
