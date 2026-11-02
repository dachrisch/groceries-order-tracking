import { randomUUID } from 'crypto';
import { executeBotMessage, type BotMessageResult } from './chat';

export type BotJobStatus = 'pending' | 'running' | 'done' | 'error';

export interface BotJob {
  id: string;
  userId: string;
  status: BotJobStatus;
  createdAt: number;
  finishedAt?: number;
  result?: BotMessageResult;
  error?: string;
}

const jobs = new Map<string, BotJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

function cleanup(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

export function startBotJob(userId: string, text: string, derivedKey: Buffer | undefined): BotJob {
  cleanup();

  const job: BotJob = {
    id: randomUUID(),
    userId,
    status: 'pending',
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);

  // Fire and forget: the frontend polls GET /api/bot/jobs/:id.
  void (async () => {
    job.status = 'running';
    try {
      job.result = await executeBotMessage(userId, text, derivedKey);
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

export function getBotJob(userId: string, id: string): BotJob | null {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) return null;
  return job;
}
