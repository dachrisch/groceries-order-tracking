/**
 * Photo intake as a job, not a request.
 *
 * A vision call takes 10–40 s; an HTTP request that waits for it ties up the UI and
 * times out on a slow model. `POST /list/extract` therefore only registers a job and
 * answers 202 with its id, and the UI polls `GET /list/extract/:id` until the status
 * settles. The image is passed straight to `extractListLines` and never stored — a
 * job holds the resulting lines, not the photo.
 *
 * The registry is per process and in memory: a 404 means "no such job in this
 * process", which also happens after a restart or on a second instance, so the client
 * must simply read the photo again. It cannot be scaled past one instance; sharing
 * jobs across instances would need a store of its own. It deliberately duplicates
 * `bot/jobs.ts` instead of sharing that registry: the payloads differ, the bot's jobs
 * have no cap, and coupling the two would drag the cart pipeline into a photo feature.
 * The caps have already diverged (the bot keeps every job it was asked for).
 *
 * Bounds here are about money and memory, not only tidiness: a vision chain is a paid
 * call in the worst case, so at most one read runs per user, a settled job is the only
 * thing a new read may evict, and a job cannot outlive the UI's patience.
 */
import { randomUUID } from 'node:crypto';
import { extractListLines, NO_READABLE_LIST } from './extract';
import type { ListLine } from './match';

export type ExtractJobStatus = 'pending' | 'running' | 'done' | 'error';

export interface ExtractJob {
  id: string;
  userId: string;
  status: ExtractJobStatus;
  createdAt: number;
  finishedAt?: number;
  lines?: ListLine[];
  /** Struck-through items the model skipped: > 0 with no lines means "all bought". */
  ticked?: number;
  /** `provider:id` that answered, so a paid fallback is visible. */
  model?: string;
  /** True when the curated paid tier answered instead of a free model. */
  paid?: boolean;
  /** Always a message written for the shopper — never a raw provider error. */
  error?: string;
}

export interface StartExtractOptions {
  /**
   * Wall-clock budget for the whole read. Exposed so the deadline path can be tested
   * without waiting two minutes; production always takes the default.
   */
  deadlineMs?: number;
}

const jobs = new Map<string, ExtractJob>();
/** Long enough for a slow shopper to come back and copy the lines. */
const JOB_TTL_MS = 60 * 60 * 1000;
/** A job holds no data worth keeping, so the cap is per user rather than global. */
const MAX_JOBS_PER_USER = 5;

/**
 * The UI gives up after about 2.5 minutes, so a job still unswept at 160 s is answering
 * a poller that has already left. The race bounds the JOB, not the chain:
 * `extractListLines` cannot be cancelled, so its in-flight model call keeps running
 * (and can still cost money) after the job has settled. That is why a timed-out read
 * may be followed by another one, and why the sweep below never deletes a live job.
 *
 * 160 s covers the photo chain's own worst case (2 free + 1 paid attempts × 45 s = 135 s,
 * see `VISION_TIMEOUT_MS`). Raising one without the other makes the job lie about its
 * work.
 */
const JOB_DEADLINE_MS = 160_000;

/** The one distance between a job's timer and its message: keep them in sync. */
const PHOTO_TIMEOUT = 'reading the photo took too long — type the list instead';
/** Anything else: the shopper gets a next step, the log gets the detail. */
const PHOTO_FAILED = 'the photo could not be read — try again or type the list';

/** Wait up to `deadlineMs` for `work`; the losing side is left to finish on its own. */
function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(PHOTO_TIMEOUT)), deadlineMs);
    // Never keep the process alive for a job nobody is polling.
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Store only messages written for the shopper (see `src/api/AGENTS.md`). The two known
 * failures pass through verbatim; everything else — a provider 500, a registry typo, a
 * thrown non-Error — is logged here and replaced with something actionable.
 */
function userSafeMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.message === NO_READABLE_LIST || error.message === PHOTO_TIMEOUT)) {
    return error.message;
  }
  console.error('[easyshopper] photo read failed:', detail);
  return PHOTO_FAILED;
}

function isSettled(job: ExtractJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

function cleanup(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    // Age from the moment the job stopped working, so a long read cannot be swept
    // out from under its own poller; a live job is never deleted.
    if (!isSettled(job)) continue;
    if ((job.finishedAt ?? job.createdAt) < cutoff) jobs.delete(id);
  }
}

/**
 * Start a photo read. Returns `null` when this user already has one running — a second
 * concurrent chain would be a second paid call, and the poller could only see one of
 * them. The image is passed straight through and never stored.
 */
export function startExtractJob(
  userId: string,
  imageBase64: string,
  options: StartExtractOptions = {}
): ExtractJob | null {
  cleanup();

  const mine = [...jobs.values()].filter((job) => job.userId === userId);
  if (mine.some((job) => !isSettled(job))) return null;

  // Only settled jobs may go. The early return above guarantees every job of this user
  // is settled here, so a new read may evict exactly as many of them as it would push
  // the user past the cap — and never the one it is about to start.
  const settled = mine.filter(isSettled);
  const excess = settled.length - MAX_JOBS_PER_USER + 1;
  for (const stale of settled.slice(0, Math.max(0, excess))) jobs.delete(stale.id);

  const job: ExtractJob = { id: randomUUID(), userId, status: 'pending', createdAt: Date.now() };
  jobs.set(job.id, job);

  const deadlineMs = options.deadlineMs ?? JOB_DEADLINE_MS;
  // Deliberately not awaited: the caller answers 202 immediately, the caller's UI polls.
  void (async () => {
    job.status = 'running';
    try {
      const extracted = await withDeadline(extractListLines(imageBase64), deadlineMs);
      job.lines = extracted.lines;
      job.ticked = extracted.ticked;
      job.model = extracted.model;
      job.paid = extracted.paid;
      job.status = 'done';
    } catch (error) {
      // Settle first, then describe: a throw while formatting must not leave the job
      // 'running', because a running job answers the user's next read with 429.
      job.status = 'error';
      try {
        job.error = userSafeMessage(error);
      } catch {
        // The formatter itself failed, which only happens when the log sink does. The
        // generic hint is still the truth, and the worker must never reject.
        job.error = PHOTO_FAILED;
      }
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

export function getExtractJob(userId: string, id: string): ExtractJob | null {
  const job = jobs.get(id);
  // Not-yours and not-there must look the same, so an id cannot be probed.
  if (!job || job.userId !== userId) return null;
  return job;
}

/** Test-only: the registry is process-wide, so tests must not inherit each other's jobs. */
export function __resetExtractJobsForTests(): void {
  jobs.clear();
}
