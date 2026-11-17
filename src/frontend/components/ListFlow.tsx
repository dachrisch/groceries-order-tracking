/**
 * The shopping list, in one sheet: lines in (typed or photographed), the
 * matches, then the Aztec code the phone scans.
 *
 * This used to be the `/in-store` page. The merge made it an action rather than
 * a destination, so it is a sheet the shell mounts once: Activity opens it
 * after a shop, Groceries opens it when the location writes to the EDEKA list,
 * and `/lists` opens it over Activity so old bookmarks still land somewhere.
 *
 * The photo read has four outcomes and each one gets its own copy (plan notes
 * L2/L3): lines merged, every line already ticked off (a success with nothing
 * to add), a paid model answered (named, never hidden), and an unreadable photo
 * (typing is always offered). A line the matcher cannot identify is never
 * dropped: it stays as free text and the table says why.
 *
 * The share step is the Aztec of the integration account's `userGuid`. The app
 * URL invite is dead in 4.154.0, so the code is the only share path; following
 * it swaps the phone's own list, which the copy says before the code is shown.
 */
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import {
  ClipboardList,
  ImageUp,
  Info,
  ScanText,
  Share2,
  Sparkles,
  TriangleAlert,
} from 'lucide-solid';
import {
  FULL_LIST_MESSAGE,
  listLinesFromText,
  listOverflows,
  listRefusalMessage,
  mergeExtractedLines,
} from '../lib/listForm';
import { closeListFlow, listFlowOpen } from '../lib/overlays';
import { fetchWithTimeout } from '../lib/request';
import { Sheet } from './Sheet';
import { StatePanel } from './StatePanel';

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
  /** Struck-through items the model skipped; > 0 with no lines means "all bought". */
  ticked: number;
  model: string | null;
  paid: boolean | null;
  error: string | null;
}

/** A read that failed or found nothing to add. Both are answers, not crashes. */
type PhotoOutcome =
  | { kind: 'ticked'; count: number }
  | { kind: 'unreadable'; message: string }
  | null;

interface ApiReply {
  error?: string;
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
 * errors (`MATCH_CALL`), and the photo read is bounded server-side at 160 s. Waiting
 * that long in a button is not an option, so both calls carry a client budget and
 * report it as a sentence rather than as "aborted".
 */
const POST_TIMEOUT_MS = 45_000;
const EXTRACT_POST_TIMEOUT_MS = 20_000;
/** Well under the server's 160 s deadline, so the shopper learns first. */
const EXTRACT_POLL_BUDGET_MS = 150_000;
/** One hung poll must not eat the whole budget; the loop's deadline stays the ceiling. */
const EXTRACT_POLL_TIMEOUT_MS = 10_000;
/** 1 s, growing ×1.5 up to 5 s: ~27 polls, not the 90 a fixed 2 s would spend against
 * the 100 requests / 15 min limiter. */
const EXTRACT_POLL_START_MS = 1000;
const EXTRACT_POLL_GROWTH = 1.5;
const EXTRACT_POLL_MAX_MS = 5000;
/** Signup + login live behind the share-code read, so it gets more than a page read. */
const SHARE_CODE_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

/** A catalogue price, or an em dash when the match carried none. */
function formatPrice(price: number | null | undefined): string {
  return typeof price === 'number' ? `€${price.toFixed(2)}` : '—';
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

export function ListFlow() {
  const [lines, setLines] = createSignal('');
  const [imageName, setImageName] = createSignal<string | null>(null);
  const [imageBase64, setImageBase64] = createSignal<string | null>(null);
  const [readBy, setReadBy] = createSignal<string | null>(null);
  const [readPaid, setReadPaid] = createSignal(false);
  const [plan, setPlan] = createSignal<Plan | null>(null);
  const [created, setCreated] = createSignal(false);
  const [added, setAdded] = createSignal(0);
  /** The Aztec is the account's `userGuid`; it is read once the list exists. */
  const [shareCode, setShareCode] = createSignal<{ path: string; size: number } | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<'plan' | 'create' | 'extract' | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** Which request failed, so "Try again" retries the right one. */
  const [failed, setFailed] = createSignal<'plan' | 'create' | null>(null);
  // A read that succeeded but had nothing to add is a note, not a failure.
  const [notice, setNotice] = createSignal<string | null>(null);
  const [photoOutcome, setPhotoOutcome] = createSignal<PhotoOutcome>(null);

  let textarea: HTMLTextAreaElement | undefined;

  /**
   * Which photo and which read the UI currently cares about. Every pick and every read
   * bumps it; a settled or finishing step that no longer owns the number stops instead of
   * writing over newer state — a stale read must never clear the photo picked after it.
   */
  let photoGeneration = 0;
  let wasOpen = false;

  const reset = () => {
    photoGeneration += 1;
    setLines('');
    setImageName(null);
    setImageBase64(null);
    setReadBy(null);
    setReadPaid(false);
    setPlan(null);
    setCreated(false);
    setAdded(0);
    setError(null);
    setFailed(null);
    setNotice(null);
    setPhotoOutcome(null);
    setShareError(null);
    setBusy(null);
  };

  /**
   * A finished list is a finished errand: reopening the sheet starts a new one.
   * An unfinished draft is kept, because closing to check something must not
   * throw away what the shopper typed.
   */
  createEffect(() => {
    const open = listFlowOpen();
    if (open && !wasOpen) {
      wasOpen = true;
      if (created()) reset();
    }
    if (!open) wasOpen = false;
  });

  onCleanup(() => {
    // Leaving the app ends a running poll loop instead of letting it spend its budget.
    photoGeneration += 1;
  });

  const handleClose = () => {
    // Closing must also stop a photo read; it would otherwise keep polling for 150 s.
    if (busy() === 'extract') {
      photoGeneration += 1;
      setBusy(null);
    }
    closeListFlow();
  };

  /**
   * Add the read lines to whatever the shopper already typed, without duplicating any.
   * The merge is capped at the schema's 60 lines: a photo alone may return 60, so
   * appending without a cap would turn the next "Match products" into a raw 400.
   */
  const appendLines = (extracted: Array<{ text: string; quantity: number }>) => {
    const { text, truncated } = mergeExtractedLines(lines(), extracted);
    setLines(text);
    if (truncated) setNotice(FULL_LIST_MESSAGE);
  };

  const loadShareCode = async () => {
    setShareError(null);
    try {
      const res = await fetchWithTimeout(
        '/api/easyshopper/share-code',
        {},
        SHARE_CODE_TIMEOUT_MS
      );
      const data = (await res.json().catch(() => ({}))) as { userGuid?: string } & ApiReply;
      if (!res.ok) {
        setShareError(data.error ?? 'could not load the share code');
        return;
      }
      if (!data.userGuid) {
        setShareError('the store did not return a share code');
        return;
      }
      // Aztec needs @zxing/library; loading it here keeps the library out of the
      // app's first paint for everyone who never creates a list.
      const { aztecSvg } = await import('../lib/aztec');
      setShareCode(aztecSvg(String(data.userGuid)));
    } catch {
      setShareError('could not reach the server for the share code');
    }
  };

  /**
   * The request body, already inside the schema (`listLinesFromText` clamps each line
   * to 200 characters and the list to 60), so a click can never send a `400` for its
   * own size. A textarea that outgrew the cap is reported rather than silently cut.
   */
  const body = () => {
    // Over the cap is a note, not a failed request: the body is clamped and still valid.
    if (listOverflows(lines())) setNotice(FULL_LIST_MESSAGE);
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
    setFailed(null);
    setNotice(null);
    setPhotoOutcome(null);
    try {
      const started = await postJson<{ jobId: string }>(
        '/api/easyshopper/list/extract',
        { imageBase64: image },
        {
          timeoutMs: EXTRACT_POST_TIMEOUT_MS,
          timeoutMessage: 'the photo upload took too long — try again',
        }
      );
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
          const extracted = data.lines ?? [];
          appendLines(extracted);
          setReadBy(data.model ?? null);
          setReadPaid(data.paid === true);
          setImageBase64(null);
          setImageName(null);
          // Everything was already ticked off: the read worked, there is simply nothing
          // to add. Saying "unreadable" here was the bug that started all this.
          setPhotoOutcome(
            extracted.length === 0 && (data.ticked ?? 0) > 0
              ? { kind: 'ticked', count: data.ticked ?? 0 }
              : null
          );
          // The matches and the created list were built from the old lines.
          setPlan(null);
          setCreated(false);
          return;
        }
        if (data.status === 'error') throw new Error(data.error ?? 'could not read the photo');
      }
      throw new Error('reading the photo took too long — type the list instead');
    } catch (err) {
      if (generation !== photoGeneration) return;
      // Every photo failure ends in the same place: the lines can be typed instead.
      setPhotoOutcome({
        kind: 'unreadable',
        message: err instanceof Error ? err.message : 'could not read the photo',
      });
    } finally {
      // A superseding pick already released the button; a stale read must not grab it back.
      if (generation === photoGeneration) setBusy(null);
    }
  };

  const runPlan = async () => {
    setBusy('plan');
    setError(null);
    setFailed(null);
    setNotice(null);
    setPhotoOutcome(null);
    setCreated(false);
    try {
      const { ok, status, data } = await postJson<Plan>('/api/easyshopper/list/plan', body());
      if (!ok) throw new Error(listRefusalMessage(status, data.error, 'planning failed'));
      setPlan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'planning failed');
      setFailed('plan');
    } finally {
      setBusy(null);
    }
  };

  const createList = async () => {
    setBusy('create');
    setError(null);
    setFailed(null);
    try {
      const { ok, status, data } = await postJson<{ plan: Plan; added: number }>(
        '/api/easyshopper/list/create',
        // The share-link invite is dead in app 4.154.0; the Aztec code is the share.
        { ...body(), createShareLink: false },
        { timeoutMessage: 'creating the list took too long — try again' }
      );
      if (!ok) throw new Error(listRefusalMessage(status, data.error, 'list creation failed'));
      setPlan(data.plan);
      setAdded(data.added);
      setCreated(true);
      setShareCode(null);
      // The code is account-level, but it is only useful now that a list was written.
      void loadShareCode();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'list creation failed');
      setFailed('create');
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    setNotice(null);
    setPhotoOutcome(null);
    const file = input.files?.[0];
    if (!file) return;
    // Reset the input so picking the same file again still fires a change event.
    input.value = '';
    const generation = ++photoGeneration;
    // This pick supersedes any read still in flight, including its busy flag.
    setBusy(null);
    setError(null);
    setFailed(null);
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
      setPhotoOutcome({
        kind: 'unreadable',
        message: err instanceof Error ? err.message : 'that photo could not be read',
      });
    }
  };

  const cancelRead = () => {
    photoGeneration += 1;
    setBusy(null);
    setNotice('Reading canceled. The photo is still selected, so Read photo can try again.');
  };

  const focusLines = () => {
    setPhotoOutcome(null);
    textarea?.focus();
  };

  // Narrowed accessors so `<Show>` hands each panel its own shape instead of the union.
  const tickedOutcome = () => {
    const outcome = photoOutcome();
    return outcome?.kind === 'ticked' ? outcome : null;
  };
  const unreadableOutcome = () => {
    const outcome = photoOutcome();
    return outcome?.kind === 'unreadable' ? outcome : null;
  };

  const planBlocked = () =>
    busy() !== null
      ? 'Another step is running — wait for it to finish.'
      : !lines().trim()
        ? 'Type one item per line, or read a photo first.'
        : null;

  const readBlocked = () =>
    busy() !== null
      ? 'Another step is running — wait for it to finish.'
      : !imageBase64()
        ? 'Pick a photo first.'
        : null;

  return (
    <Sheet
      open={listFlowOpen()}
      onClose={handleClose}
      title="New shopping list"
      subtitle="Photo or type the lines, match products, then send the list to your phone."
      width="lg"
    >
      <div class="space-y-4">
        <section class="space-y-3 rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm">
          <div>
            <h3 class="flex items-center gap-2 text-sm font-bold">
              <ClipboardList size={16} /> 1 · The list
            </h3>
            <p class="mt-1 text-xs text-base-content/60">
              One item per line — “2x Milch” sets the quantity. A photo is read into the box so you can
              correct it before anything is matched.
            </p>
          </div>

          <textarea
            // A callback rather than `ref={textarea}` so the assignment is explicit.
            ref={(element) => {
              textarea = element;
            }}
            class="textarea textarea-bordered h-36 w-full font-mono text-sm"
            placeholder={'Milch 1,5\nBrot\n2x Waschmittel sensitiv'}
            value={lines()}
            onInput={(event) => setLines(event.currentTarget.value)}
          />

          <div class="flex flex-wrap items-center gap-2">
            <label
              class="btn btn-outline btn-sm gap-2"
              title={busy() !== null ? 'Another step is running — wait for it to finish.' : undefined}
            >
              <ImageUp size={15} />
              Photo
              <input
                type="file"
                accept="image/*"
                class="hidden"
                disabled={busy() !== null}
                onChange={onFile}
              />
            </label>
            <Show when={imageName()}>
              <span class="badge badge-ghost">{imageName()}</span>
            </Show>
            <button
              class="btn btn-outline btn-sm gap-2"
              disabled={busy() !== null || !imageBase64()}
              title={readBlocked() ?? undefined}
              onClick={readPhoto}
            >
              <Show when={busy() === 'extract'} fallback={<ScanText size={15} />}>
                <span class="loading loading-spinner loading-xs" />
              </Show>
              Read photo
            </button>
            <Show when={busy() === 'extract'}>
              <button class="btn btn-ghost btn-sm" onClick={cancelRead}>
                Cancel
              </button>
            </Show>
            <button
              class="btn btn-primary btn-sm gap-2"
              disabled={busy() !== null || !lines().trim()}
              title={planBlocked() ?? undefined}
              onClick={runPlan}
            >
              <Show when={busy() === 'plan'} fallback={<Sparkles size={15} />}>
                <span class="loading loading-spinner loading-xs" />
              </Show>
              Match products
            </button>
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
          </div>

          <Show when={busy() === null && (planBlocked() || readBlocked())}>
            <p class="text-[11px] text-base-content/55">
              <Show when={planBlocked()} fallback={readBlocked()}>
                {planBlocked()}
              </Show>
            </p>
          </Show>
        </section>

        <Show when={notice()}>
          <div class="alert alert-info py-2 text-xs">
            <Info size={14} /> {notice()}
          </div>
        </Show>

        {/* A photo whose items are all ticked is a success with nothing to add. */}
        <Show when={tickedOutcome()}>
          {(outcome) => (
            <StatePanel
              tone="success"
              title="Every item on the photo is already ticked off"
              body={`The read found ${outcome().count} struck-through line${
                outcome().count === 1 ? '' : 's'
              } — the shopping is done, so there is nothing to add.`}
              hint="A fully ticked list is a successful read, not an unreadable photo."
            />
          )}
        </Show>

        <Show when={unreadableOutcome()}>
          {(outcome) => (
            <StatePanel
              tone="warning"
              icon={<TriangleAlert size={18} />}
              title="That photo could not be read as a list"
              body={outcome().message}
              hint="Typing works the same way — matching does not care how the lines arrived."
              action={{ label: 'Type the lines instead', onClick: focusLines }}
            />
          )}
        </Show>

        <Show when={error()}>
          <StatePanel
            tone="error"
            title={failed() === 'create' ? 'Could not create the list' : 'Could not match the list'}
            body={error()!}
            hint={
              failed() === 'create'
                ? 'Some lines may already be on the phone list; matching again shows the current plan.'
                : undefined
            }
            action={{
              label: 'Try again',
              onClick: () => (failed() === 'create' ? void createList() : void runPlan()),
              busy: busy() !== null,
              disabledReason:
                busy() !== null ? 'Another step is running — wait for it to finish.' : undefined,
            }}
          />
        </Show>

        <Show when={plan()}>
          {(current) => (
            <section class="space-y-3 rounded-2xl border border-base-300 bg-base-100 p-3 shadow-sm">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 class="flex items-center gap-2 text-sm font-bold">
                    <Sparkles size={16} /> 2 · Matches
                  </h3>
                  <p class="mt-1 text-xs text-base-content/60">
                    {current().matched} matched · {current().unmatched} kept as free text
                  </p>
                </div>
                <button
                  class="btn btn-primary btn-sm gap-2 rounded-xl"
                  disabled={busy() !== null || created()}
                  title={
                    created()
                      ? 'This list is already on your phone. Edit the lines, then Match products again to write a new version.'
                      : busy() !== null
                        ? 'Another step is running — wait for it to finish.'
                        : 'Write these lines to your EASY Shopper list'
                  }
                  onClick={createList}
                >
                  <Show when={busy() === 'create'} fallback={<Share2 size={15} />}>
                    <span class="loading loading-spinner loading-xs" />
                  </Show>
                  {created() ? 'List created' : 'Create list'}
                </button>
              </div>

              <p class="text-[11px] text-base-content/55">
                A line without a product match stays on the list exactly as typed; nothing is
                dropped. The server plans again when it writes, so this preview is advisory.
              </p>

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
                              fallback={
                                <div>
                                  <span class="badge badge-ghost badge-sm">free text</span>
                                  <div class="mt-0.5 text-[10px] text-base-content/55">
                                    {entry.match.reason}
                                  </div>
                                </div>
                              }
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
                            {formatPrice(entry.match.candidate?.price)}
                          </td>
                          <td class="text-right">
                            <Show
                              when={entry.chooser === 'model'}
                              fallback={
                                <span
                                  class={`badge badge-sm ${entry.action === 'product' ? 'badge-success' : 'badge-ghost'}`}
                                >
                                  {entry.action === 'product' ? entry.match.score.toFixed(2) : 'not matched'}
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

              <Show when={created()}>
                <p class="text-[11px] text-base-content/55">
                  {added()} line{added() === 1 ? '' : 's'} written. Edit the lines and press Match
                  products again to write a new version.
                </p>
              </Show>
            </section>
          )}
        </Show>

        <Show when={created()}>
          <section class="space-y-3 rounded-2xl border border-primary/30 bg-primary/5 p-4 shadow-sm">
            <div>
              <h3 class="flex items-center gap-2 text-sm font-bold">
                <Share2 size={16} /> 3 · Scan this with your phone
              </h3>
              <p class="mt-1 text-xs text-base-content/70">
                In EASY Shopper: <strong>shopping list → three-dot menu → “Connect to Another Shopping
                List”</strong>, then scan this code.
              </p>
            </div>

            {/* The swap is the product's caveat, so it sits next to the code, not in a footer. */}
            <div class="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-base-content/80">
              <strong>Following swaps the phone's own list for this one.</strong> The phone's items are
              parked and come back when you unfollow in the app. This is not an “add these items to my
              list” action.
            </div>

            <Show
              when={shareCode()}
              fallback={
                <div class="space-y-2">
                  <p class="text-xs text-base-content/60">
                    {shareError() ?? 'Preparing the share code…'}
                  </p>
                  <Show when={shareError()}>
                    <button class="btn btn-outline btn-sm rounded-xl" onClick={() => void loadShareCode()}>
                      Try again
                    </button>
                  </Show>
                </div>
              }
            >
              {(code) => (
                <svg
                  class="h-auto w-full max-w-[260px] rounded-xl bg-white p-3"
                  viewBox={`0 0 ${code().size} ${code().size}`}
                  shape-rendering="crispEdges"
                  role="img"
                  aria-label="Shopping list share code (Aztec barcode)"
                >
                  <rect width={code().size} height={code().size} fill="white" />
                  <path d={code().path} fill="black" />
                </svg>
              )}
            </Show>
          </section>
        </Show>
      </div>
    </Sheet>
  );
}
