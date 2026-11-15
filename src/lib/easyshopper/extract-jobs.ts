/**
 * Photo intake as a job, not a request.
 *
 * A vision call takes 10–40 s; an HTTP request that waits for it ties up the UI and
 * times out on a slow model. `POST /list/extract` therefore only registers a job and
 * answers 202 with its id, and the UI polls `GET /list/extract/:id` until the status
 * settles. The image is passed straight to `extractListLines` and never stored — a
 * job holds the resulting lines, not the photo.
 */
import { randomUUID } from 'node:crypto';
import { extractListLines } from './extract';
import type { ListLine } from './match';

export type ExtractJobStatus = 'pending' | 'running' | 'done' | 'error';

export interface ExtractJob {
  id: string;
  userId: string;
  status: ExtractJobStatus;
  createdAt: number;
  finishedAt?: number;
  lines?: ListLine[];
  /** `provider:id` that answered, so a paid fallback is visible. */
  model?: string;
  /** True when the curated paid tier answered instead of a free model. */
  paid?: boolean;
  error?: string;
}

const jobs = new Map<string, ExtractJob>();
const JOB_TTL_MS = 60 * 60 * 1000;
/** A photo job holds no data worth keeping; cap the registry per user instead. */
const MAX_JOBS_PER_USER = 5;

function cleanup(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

/** Start a photo read. The image is passed straight through and never stored. */
export function startExtractJob(userId: string, imageBase64: string): ExtractJob {
  cleanup();

  const mine = [...jobs.values()].filter((job) => job.userId === userId);
  for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_JOBS_PER_USER + 1))) {
    jobs.delete(stale.id);
  }

  const job: ExtractJob = { id: randomUUID(), userId, status: 'pending', createdAt: Date.now() };
  jobs.set(job.id, job);

  // Deliberately not awaited: the caller answers 202 immediately, the caller's UI polls.
  void (async () => {
    job.status = 'running';
    try {
      const extracted = await extractListLines(imageBase64);
      job.lines = extracted.lines;
      job.model = extracted.model;
      job.paid = extracted.paid;
      job.status = 'done';
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.status = 'error';
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
