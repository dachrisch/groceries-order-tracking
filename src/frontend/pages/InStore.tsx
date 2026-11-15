import { createSignal, onMount, Show, For } from 'solid-js';
import { ShoppingBasket, Sparkles, Share2, RefreshCw, ImageUp, TriangleAlert } from 'lucide-solid';
import QRCode from 'qrcode';

interface PlannedLine {
  line: { text: string; quantity: number };
  match: {
    candidate: { id?: string; name: string; brand?: string | null; price?: number | null } | null;
    score: number;
    reason: string;
  };
  action: 'product' | 'text';
}

interface Plan {
  storeGuid: string;
  lines: PlannedLine[];
  matched: number;
  unmatched: number;
}

interface SyncStatus {
  requestedAt: string | null;
  lastImportAt: string | null;
  lastPurchaseAt: string | null;
  sessions: number;
}

interface Insights {
  totals: {
    sessions: number;
    rows: number;
    units: number;
    spend: number;
    creditReturned: number;
    averageBasket: number;
    firstPurchaseAt: string | null;
    lastPurchaseAt: string | null;
  };
  stores: Array<{ store: string; visits: number; spend: number; averageBasket: number }>;
  monthly: Array<{ month: string; spend: number; visits: number }>;
  topProducts: Array<{ brand: string | null; name: string; units: number; spend: number; trips: number; lastBoughtAt: string }>;
}

/** Downscale a photo before upload: a 2 MB JSON body will not take a 12 MP original. */
async function toBase64Jpeg(file: File, maxEdge = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

export function InStore() {
  const [insights, setInsights] = createSignal<Insights | null>(null);
  const [lines, setLines] = createSignal('');
  const [imageName, setImageName] = createSignal<string | null>(null);
  const [imageBase64, setImageBase64] = createSignal<string | null>(null);
  const [plan, setPlan] = createSignal<Plan | null>(null);
  const [shareLink, setShareLink] = createSignal<string | null>(null);
  const [qr, setQr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<'plan' | 'create' | 'sync' | 'share' | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [syncStatus, setSyncStatus] = createSignal<SyncStatus | null>(null);
  const [expiresAt, setExpiresAt] = createSignal<string | null>(null);

  const loadPurchases = async () => {
    try {
      const stats = await fetch('/api/easyshopper/insights');
      if (stats.ok) setInsights(await stats.json());
    } catch {
      /* summary is optional chrome; the list flow still works */
    }
  };

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/easyshopper/sync/status');
      if (res.ok) setSyncStatus(await res.json());
    } catch {
      /* ignore */
    }
  };

  onMount(() => {
    void loadPurchases();
    void loadStatus();
  });

  const requestSync = async () => {
    setBusy('sync');
    setError(null);
    try {
      const res = await fetch('/api/easyshopper/sync/request', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'sync request failed');
      await loadStatus();
      // The sidecar owns the phone; poll briefly so the user sees the upload land.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        await loadStatus();
        if (!syncStatus()?.requestedAt) break;
      }
      await loadPurchases();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sync request failed');
    } finally {
      setBusy(null);
      void loadStatus();
    }
  };

  const refreshShareLink = async () => {
    setBusy('share');
    setError(null);
    try {
      const res = await fetch('/api/easyshopper/list/share', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'could not mint a share link');
      setShareLink(data.shareLink);
      setExpiresAt(data.expiresAt ?? null);
      setQr(await QRCode.toDataURL(String(data.shareLink), { width: 320, margin: 1 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not mint a share link');
    } finally {
      setBusy(null);
    }
  };

  const body = () => ({
    lines: lines()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    ...(imageBase64() ? { imageBase64: imageBase64() } : {}),
  });

  const runPlan = async () => {
    setBusy('plan');
    setError(null);
    setShareLink(null);
    setQr(null);
    try {
      const res = await fetch('/api/easyshopper/list/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'planning failed');
      setPlan(data as Plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'planning failed');
    } finally {
      setBusy(null);
    }
  };

  const createList = async () => {
    setBusy('create');
    setError(null);
    try {
      const res = await fetch('/api/easyshopper/list/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'list creation failed');
      setPlan(data.plan as Plan);
      setShareLink(data.shareLink ?? null);
      setExpiresAt(null);
      if (data.shareLink) setQr(await QRCode.toDataURL(String(data.shareLink), { width: 320, margin: 1 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'list creation failed');
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setImageName(file.name);
    setImageBase64(await toBase64Jpeg(file));
  };

  const totals = () => {
    const data = insights();
    if (!data) return null;
    return {
      visits: data.totals.sessions,
      spent: data.totals.spend,
      items: data.totals.rows,
      units: data.totals.units,
      average: data.totals.averageBasket,
      credits: data.totals.creditReturned,
    };
  };

  return (
    <div class="p-4 lg:p-8 space-y-6">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-1">
          <h1 class="text-2xl font-semibold flex items-center gap-2">
            <ShoppingBasket class="w-6 h-6" /> EDEKA in store
          </h1>
          <p class="text-sm opacity-70">
            Purchases are read off the phone; the shopping list is written to the integration's own EASY
            Shopper account and handed to your phone as a share link.
          </p>
        </div>
        <div class="flex flex-col items-end gap-1">
          <button class="btn btn-sm btn-outline gap-2" disabled={busy() !== null} onClick={requestSync}>
            <Show when={busy() === 'sync'} fallback={<RefreshCw class="w-4 h-4" />}>
              <span class="loading loading-spinner loading-xs" />
            </Show>
            Sync now
          </button>
          <Show when={syncStatus()?.requestedAt}>
            <span class="text-xs opacity-60">waiting for the sidecar…</span>
          </Show>
          <Show when={syncStatus()?.lastImportAt}>
            <span class="text-xs opacity-60">
              last sync {new Date(syncStatus()!.lastImportAt!).toLocaleString()}
            </span>
          </Show>
        </div>
      </header>

      <Show when={totals()}>
        {(summary) => (
          <div class="stats stats-vertical sm:stats-horizontal shadow bg-base-100 w-full">
            <div class="stat">
              <div class="stat-title">Purchases captured</div>
              <div class="stat-value text-2xl">{summary().visits}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Total spent</div>
              <div class="stat-value text-2xl">€{summary().spent.toFixed(2)}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Average basket</div>
              <div class="stat-value text-2xl">€{summary().average.toFixed(2)}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Lines / units</div>
              <div class="stat-value text-2xl">
                {summary().items} / {summary().units}
              </div>
              <div class="stat-desc">deposits returned €{summary().credits.toFixed(2)}</div>
            </div>
          </div>
        )}
      </Show>

      <Show when={insights()}>
        {(data) => (
          <section class="card bg-base-100 shadow">
            <div class="card-body gap-4">
              <h2 class="card-title text-base">What you actually bought</h2>
              <div class="grid gap-6 lg:grid-cols-2">
                <div class="overflow-x-auto">
                  <h3 class="text-sm font-medium opacity-70 mb-2">Most bought</h3>
                  <table class="table table-sm">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th class="text-right">Trips</th>
                        <th class="text-right">Units</th>
                        <th class="text-right">Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data().topProducts.slice(0, 10)}>
                        {(product) => (
                          <tr>
                            <td>
                              <Show when={product.brand}>
                                <span class="opacity-60">{product.brand} · </span>
                              </Show>
                              {product.name}
                            </td>
                            <td class="text-right tabular-nums">{product.trips}</td>
                            <td class="text-right tabular-nums">{product.units}</td>
                            <td class="text-right tabular-nums">€{product.spend.toFixed(2)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <div class="space-y-6">
                  <div>
                    <h3 class="text-sm font-medium opacity-70 mb-2">By store</h3>
                    <table class="table table-sm">
                      <tbody>
                        <For each={data().stores}>
                          {(store) => (
                            <tr>
                              <td>{store.store}</td>
                              <td class="text-right tabular-nums opacity-70">{store.visits} visits</td>
                              <td class="text-right tabular-nums">€{store.spend.toFixed(2)}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <h3 class="text-sm font-medium opacity-70 mb-2">By month</h3>
                    <div class="flex items-end gap-1 h-24">
                      <For each={[...data().monthly].reverse().slice(-12)}>
                        {(month) => {
                          const peak = Math.max(...data().monthly.map((entry) => entry.spend), 1);
                          return (
                            <div class="flex-1 flex flex-col items-center gap-1" title={`${month.month}: €${month.spend}`}>
                              <div
                                class="w-full rounded-t bg-primary/70"
                                style={{ height: `${Math.max(4, (month.spend / peak) * 80)}px` }}
                              />
                              <span class="text-[9px] opacity-50">{month.month.slice(5)}</span>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </Show>

      <section class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <h2 class="card-title text-base">1 · The list</h2>
          <p class="text-sm opacity-70">
            Photograph the handwritten list, type it, or both. One item per line — “2x Milch” sets the
            quantity.
          </p>

          <textarea
            class="textarea textarea-bordered w-full h-40 font-mono text-sm"
            placeholder={'Milch 1,5\nBrot\n2x Waschmittel sensitiv'}
            value={lines()}
            onInput={(event) => setLines(event.currentTarget.value)}
          />

          <div class="flex flex-wrap items-center gap-3">
            <label class="btn btn-outline btn-sm gap-2">
              <ImageUp class="w-4 h-4" />
              Photo
              <input type="file" accept="image/*" class="hidden" onChange={onFile} />
            </label>
            <Show when={imageName()}>
              <span class="badge badge-ghost">{imageName()}</span>
            </Show>
            <button
              class="btn btn-primary btn-sm gap-2"
              disabled={busy() !== null || (!lines().trim() && !imageBase64())}
              onClick={runPlan}
            >
              <Show when={busy() === 'plan'} fallback={<Sparkles class="w-4 h-4" />}>
                <span class="loading loading-spinner loading-xs" />
              </Show>
              Match products
            </button>
          </div>
        </div>
      </section>

      <Show when={error()}>
        <div class="alert alert-error text-sm">
          <TriangleAlert class="w-4 h-4" /> {error()}
        </div>
      </Show>

      <Show when={plan()}>
        {(current) => (
          <section class="card bg-base-100 shadow">
            <div class="card-body gap-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <h2 class="card-title text-base">
                  2 · Matches
                  <span class="badge badge-success badge-sm">{current().matched} matched</span>
                  <span class="badge badge-ghost badge-sm">{current().unmatched} as text</span>
                </h2>
                <button class="btn btn-primary btn-sm gap-2" disabled={busy() !== null} onClick={createList}>
                  <Show when={busy() === 'create'} fallback={<Share2 class="w-4 h-4" />}>
                    <span class="loading loading-spinner loading-xs" />
                  </Show>
                  Create list &amp; share
                </button>
              </div>

              <div class="overflow-x-auto">
                <table class="table table-sm">
                  <thead>
                    <tr>
                      <th>List line</th>
                      <th>Product</th>
                      <th class="text-right">Price</th>
                      <th class="text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={current().lines}>
                      {(entry) => (
                        <tr>
                          <td class="whitespace-nowrap">
                            {entry.line.quantity > 1 ? `${entry.line.quantity}× ` : ''}
                            {entry.line.text}
                          </td>
                          <td>
                            <Show
                              when={entry.match.candidate}
                              fallback={<span class="text-xs opacity-60">{entry.match.reason}</span>}
                            >
                              {(candidate) => (
                                <span>
                                  <Show when={candidate().brand}>
                                    <span class="opacity-60">{candidate().brand} · </span>
                                  </Show>
                                  {candidate().name}
                                </span>
                              )}
                            </Show>
                          </td>
                          <td class="text-right tabular-nums">
                            {entry.match.candidate?.price ? `€${entry.match.candidate.price.toFixed(2)}` : '—'}
                          </td>
                          <td class="text-right">
                            <span
                              class={`badge badge-sm ${entry.action === 'product' ? 'badge-success' : 'badge-ghost'}`}
                            >
                              {entry.match.score.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </Show>

      <Show when={shareLink()}>
        {(link) => (
          <section class="card bg-base-100 shadow">
            <div class="card-body gap-4 items-start">
              <h2 class="card-title text-base">
                <Share2 class="w-4 h-4" /> 3 · Share with your phone
              </h2>
              <p class="text-sm opacity-70">
                Scan with the phone's camera — it opens EASY Shopper and offers to follow the list.
                Links expire after 24 hours, so mint a fresh one when you are about to use the list.
              </p>
              <Show when={expiresAt()}>
                <span class="badge badge-warning badge-sm">
                  valid until {new Date(expiresAt()!).toLocaleString()}
                </span>
              </Show>
              <Show when={qr()}>
                <img src={qr()!} alt="Share link QR code" class="rounded-box bg-white p-2" />
              </Show>
              <div class="flex w-full flex-wrap items-center gap-2">
                <input class="input input-bordered input-sm flex-1 font-mono text-xs" readonly value={link()} />
                <button class="btn btn-sm btn-outline gap-2" onClick={() => navigator.clipboard.writeText(link())}>
                  <RefreshCw class="w-3.5 h-3.5" /> Copy
                </button>
                <button class="btn btn-sm btn-outline gap-2" disabled={busy() !== null} onClick={refreshShareLink}>
                  <Show when={busy() === 'share'} fallback={<Share2 class="w-3.5 h-3.5" />}>
                    <span class="loading loading-spinner loading-xs" />
                  </Show>
                  New link
                </button>
              </div>
            </div>
          </section>
        )}
      </Show>
    </div>
  );
}
