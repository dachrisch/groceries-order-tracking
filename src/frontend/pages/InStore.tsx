import { createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import { ShoppingBasket, Sparkles, ScanText, Share2, RefreshCw, ImageUp, TriangleAlert } from 'lucide-solid';
import QRCode from 'qrcode';
import {
  FULL_LIST_MESSAGE,
  listLinesFromText,
  listOverflows,
  listRefusalMessage,
  mergeExtractedLines,
} from '../lib/listForm';

interface PlannedLine {
  line: { text: string; quantity: number };
  match: {
    candidate: { id?: string; name: string; brand?: string | null; price?: number | null } | null;
    score: number;
    reason: string;
  };
  action: 'product' | 'text';
  /** `model` = opencode chose the product; `rules` = the deterministic score did. */
  chooser: 'model' | 'rules';
}

interface Plan {
  storeGuid: string;
  lines: PlannedLine[];
  matched: number;
  unmatched: number;
}

/** What `GET /list/extract/:id` answers while a photo read is in flight or settled. */
interface ExtractStatus {
  status: 'pending' | 'running' | 'done' | 'error';
  lines: Array<{ text: string; quantity: number }> | null;
  model: string | null;
  paid: boolean | null;
  error: string | null;
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

/** Draw an already-decoded photo onto a canvas and return a JPEG data URL. */
function toBase64Jpeg(bitmap: ImageBitmap, maxEdge = 1600, quality = 0.8): string {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** The extract schema rejects anything longer, and `express.json` caps the body at 2 MB. */
const MAX_IMAGE_CHARS = 2_000_000;
/** Smaller and more compressed in turn, so a dense page still fits without a 400/413. */
const IMAGE_ATTEMPTS = [
  { edge: 1600, quality: 0.8 },
  { edge: 1280, quality: 0.8 },
  { edge: 1280, quality: 0.6 },
] as const;

/** Encode until the data URL fits the backend's schema, then fail in words it can show. */
async function prepareImage(file: File): Promise<string> {
  // Decode once and reuse the bitmap: a 12 MP decode is expensive, and it is ours to release.
  const bitmap = await createImageBitmap(file);
  try {
    for (const attempt of IMAGE_ATTEMPTS) {
      const dataUrl = toBase64Jpeg(bitmap, attempt.edge, attempt.quality);
      if (dataUrl.length <= MAX_IMAGE_CHARS) return dataUrl;
    }
  } finally {
    bitmap.close();
  }
  throw new Error('that photo is too large to read — take a closer shot or type the list');
}

/**
 * The plan route is bounded at 2 models × 3 attempts × 15 s ≈ 90 s on repeated fast
 * errors (`MATCH_CALL`), and the photo read is bounded server-side at 120 s. Waiting
 * that long in a button is not an option, so both calls carry a client budget and
 * report it as a sentence rather than as "aborted".
 */
const POST_TIMEOUT_MS = 45_000;
const EXTRACT_POST_TIMEOUT_MS = 20_000;
/** Well under the server's 120 s deadline, so the shopper learns first. */
const EXTRACT_POLL_BUDGET_MS = 110_000;
/** One hung poll must not eat the whole budget; the loop's deadline stays the ceiling. */
const EXTRACT_POLL_TIMEOUT_MS = 10_000;
/** 1 s, growing ×1.5 up to 5 s: ~27 polls, not the 90 a fixed 2 s would spend against
 * the 100 requests / 15 min limiter. */
const EXTRACT_POLL_START_MS = 1000;
const EXTRACT_POLL_GROWTH = 1.5;
const EXTRACT_POLL_MAX_MS = 5000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ApiReply {
  error?: string;
}

/** POST JSON with a hard client budget, returning the status so callers can be specific. */
async function postJson<T>(
  path: string,
  payload: unknown,
  options: { timeoutMs?: number; timeoutMessage?: string } = {}
): Promise<{ ok: boolean; status: number; data: T & ApiReply }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? POST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // A rate-limit rejection is plain text, so a failed parse must not hide the status.
    const data = (await res.json().catch(() => ({}))) as T & ApiReply;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(options.timeoutMessage ?? 'matching took too long — try again');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The shopper's half of every refusal: the backend's own text when it has one. */
function replyMessage(status: number, data: ApiReply, fallback: string): string {
  // Two different 429s exist: the per-user "a photo is already being read" refusal carries
  // an `error`, while the app-wide limiter answers 429 in plain text with no body. Only the
  // former is about a running read; blaming it for a rate limit would send the shopper
  // hunting for a job that does not exist.
  if (status === 429) return data.error ?? 'too many requests — wait a minute and try again';
  return data.error ?? fallback;
}

export function InStore() {
  const [insights, setInsights] = createSignal<Insights | null>(null);
  const [lines, setLines] = createSignal('');
  const [imageName, setImageName] = createSignal<string | null>(null);
  const [imageBase64, setImageBase64] = createSignal<string | null>(null);
  const [readBy, setReadBy] = createSignal<string | null>(null);
  const [readPaid, setReadPaid] = createSignal(false);
  const [plan, setPlan] = createSignal<Plan | null>(null);
  const [shareLink, setShareLink] = createSignal<string | null>(null);
  const [qr, setQr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<'plan' | 'create' | 'sync' | 'share' | 'extract' | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [syncStatus, setSyncStatus] = createSignal<SyncStatus | null>(null);
  const [expiresAt, setExpiresAt] = createSignal<string | null>(null);

  /**
   * Which photo and which read the UI currently cares about. Every pick and every read
   * bumps it; a settled or finishing step that no longer owns the number stops instead of
   * writing over newer state — a stale read must never clear the photo picked after it.
   */
  let photoGeneration = 0;

  /**
   * Add the read lines to whatever the shopper already typed, without duplicating any.
   * The merge is capped at the schema's 60 lines: a photo alone may return 60, so
   * appending without a cap would turn the next "Match products" into a raw 400.
   */
  const appendLines = (extracted: Array<{ text: string; quantity: number }>) => {
    const { text, truncated } = mergeExtractedLines(lines(), extracted);
    setLines(text);
    if (truncated) setError(FULL_LIST_MESSAGE);
  };

  onCleanup(() => {
    // Navigating away ends a running poll loop instead of letting it spend its budget.
    photoGeneration += 1;
  });

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

  /**
   * The request body, already inside the schema (`listLinesFromText` clamps each line
   * to 200 characters and the list to 60), so a click can never send a `400` for its
   * own size. A textarea that outgrew the cap is reported rather than silently cut.
   */
  const body = () => {
    if (listOverflows(lines())) setError(FULL_LIST_MESSAGE);
    return { lines: listLinesFromText(lines()) };
  };

  /**
   * Hand the photo to opencode, then poll the job until it settles. The image never
   * reaches the matcher: the lines come back into the box, so the shopper can correct a
   * misread before anything is matched.
   */
  const readPhoto = async () => {
    const image = imageBase64();
    if (!image) return;
    const generation = ++photoGeneration;
    setBusy('extract');
    setError(null);
    try {
      const started = await postJson<{ jobId: string }>('/api/easyshopper/list/extract', { imageBase64: image }, {
        timeoutMs: EXTRACT_POST_TIMEOUT_MS,
        timeoutMessage: 'the photo upload took too long — try again',
      });
      // A newer pick or read owns the UI now; this one must not touch it.
      if (generation !== photoGeneration) return;
      if (!started.ok) {
        // 400 only happens for a photo we already shrank or an unreadable payload, so the
        // zod detail would be noise; 429 and 503 say something the shopper can act on.
        throw new Error(
          started.status === 400
            ? 'that photo could not be read — take another shot or type the list'
            : replyMessage(started.status, started.data, 'could not read the photo')
        );
      }

      const jobId = started.data.jobId;
      const began = Date.now();
      let wait = EXTRACT_POLL_START_MS;
      while (Date.now() - began < EXTRACT_POLL_BUDGET_MS) {
        await sleep(wait);
        if (generation !== photoGeneration) return;
        wait = Math.min(EXTRACT_POLL_MAX_MS, Math.round(wait * EXTRACT_POLL_GROWTH));

        const poll = await fetch(`/api/easyshopper/list/extract/${jobId}`, {
          // A poll that hangs is retried by the loop; the budget below is the real ceiling.
          signal: AbortSignal.timeout(EXTRACT_POLL_TIMEOUT_MS),
        }).catch(() => null);
        if (generation !== photoGeneration) return;
        if (!poll) continue;

        const data = (await poll.json().catch(() => ({}))) as ExtractStatus & ApiReply;
        // A 404 already says what to do ("that photo read was lost — read the photo
        // again"); passing it through verbatim is the point.
        if (!poll.ok) throw new Error(replyMessage(poll.status, data, 'could not read the photo'));

        // `lines`, `model` and `paid` are null until the job settles.
        if (data.status === 'done') {
          appendLines(data.lines ?? []);
          setReadBy(data.model ?? null);
          setReadPaid(data.paid === true);
          setImageBase64(null);
          setImageName(null);
          // The matches and the share card were built from the old lines.
          setPlan(null);
          setShareLink(null);
          setQr(null);
          setExpiresAt(null);
          return;
        }
        if (data.status === 'error') throw new Error(data.error ?? 'could not read the photo');
      }
      throw new Error('reading the photo took too long — type the list instead');
    } catch (err) {
      if (generation !== photoGeneration) return;
      setError(err instanceof Error ? err.message : 'could not read the photo');
    } finally {
      // A superseding pick already released the button; a stale read must not grab it back.
      if (generation === photoGeneration) setBusy(null);
    }
  };

  const runPlan = async () => {
    setBusy('plan');
    setError(null);
    setShareLink(null);
    setQr(null);
    try {
      const { ok, status, data } = await postJson<Plan>('/api/easyshopper/list/plan', body());
      if (!ok) throw new Error(listRefusalMessage(status, data.error, 'planning failed'));
      setPlan(data);
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
      const { ok, status, data } = await postJson<{ plan: Plan; shareLink?: string | null; added: number }>(
        '/api/easyshopper/list/create',
        body(),
        { timeoutMessage: 'creating the list took too long — try again' }
      );
      if (!ok) throw new Error(listRefusalMessage(status, data.error, 'list creation failed'));
      setPlan(data.plan);
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
    // Reset the input so picking the same file again still fires a change event.
    input.value = '';
    const generation = ++photoGeneration;
    // This pick supersedes any read still in flight, including its busy flag.
    setBusy(null);
    setError(null);
    setReadBy(null);
    setReadPaid(false);
    setImageName(file.name);
    try {
      const prepared = await prepareImage(file);
      // A later pick won the race: its photo is the one to keep.
      if (generation !== photoGeneration) return;
      setImageBase64(prepared);
    } catch (err) {
      if (generation !== photoGeneration) return;
      setImageBase64(null);
      setImageName(null);
      setError(err instanceof Error ? err.message : 'that photo could not be read');
    }
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
            quantity. Read photo passes the picture to opencode's vision model; the lines land in the box so
            you can correct them before anything is matched.
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
              <input type="file" accept="image/*" class="hidden" disabled={busy() !== null} onChange={onFile} />
            </label>
            <Show when={imageName()}>
              <span class="badge badge-ghost">{imageName()}</span>
            </Show>
            <Show when={readBy()}>
              <span
                class={`badge badge-sm ${readPaid() ? 'badge-warning' : 'badge-ghost'}`}
                title={
                  readPaid()
                    ? 'the free vision models were unavailable, so a paid model read this photo'
                    : 'the model that read the photo'
                }
              >
                read by {readBy()}
                {readPaid() ? ' (paid)' : ''}
              </span>
            </Show>
            <button
              class="btn btn-outline btn-sm gap-2"
              disabled={busy() !== null || !imageBase64()}
              onClick={readPhoto}
            >
              <Show when={busy() === 'extract'} fallback={<ScanText class="w-4 h-4" />}>
                <span class="loading loading-spinner loading-xs" />
              </Show>
              Read photo
            </button>
            <button
              class="btn btn-primary btn-sm gap-2"
              disabled={busy() !== null || !lines().trim()}
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
                      <th class="text-right">Matched by</th>
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
                            <Show
                              when={entry.chooser === 'model'}
                              fallback={
                                <span
                                  class={`badge badge-sm ${entry.action === 'product' ? 'badge-success' : 'badge-ghost'}`}
                                >
                                  {entry.match.score.toFixed(2)}
                                </span>
                              }
                            >
                              {/* A model pick is deliberate: its rules score can be low, so
                                  showing "0.31" in green would claim a certainty it lacks. */}
                              <span class="badge badge-info badge-sm" title={entry.match.reason}>
                                opencode
                              </span>
                            </Show>
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
