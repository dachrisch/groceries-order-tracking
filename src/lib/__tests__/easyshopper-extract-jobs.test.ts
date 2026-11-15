/**
 * The photo job registry has no Mongo and no network, so it can be tested here
 * even where `mongodb-memory-server` cannot spawn (musl container, glibc mongod).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../easyshopper/extract', () => ({ extractListLines: vi.fn() }));

import { extractListLines } from '../easyshopper/extract';
import { getExtractJob, startExtractJob } from '../easyshopper/extract-jobs';

const mockExtract = vi.mocked(extractListLines);

beforeEach(() => mockExtract.mockReset());

/** The job body runs detached; wait for the status to settle instead of guessing a delay. */
async function settle(id: string, userId = 'alice') {
  await vi.waitFor(() => {
    expect(['done', 'error']).toContain(getExtractJob(userId, id)?.status);
  });
  const job = getExtractJob(userId, id);
  if (!job) throw new Error('job vanished');
  return job;
}

describe('startExtractJob', () => {
  it('copies lines, model and paid off a successful extraction', async () => {
    mockExtract.mockResolvedValueOnce({
      lines: [
        { text: 'Milch 1,5', quantity: 2 },
        { text: 'Brot', quantity: 1 },
      ],
      model: 'opencode-go:gpt-6-luna',
      paid: true,
    });

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    // The worker body starts synchronously, so it may already be past 'pending'.
    expect(['pending', 'running']).toContain(started.status);
    expect(started.id).toBeTruthy();
    expect(started.userId).toBe('alice');

    const job = await settle(started.id);

    expect(job.status).toBe('done');
    expect(job.lines).toEqual([
      { text: 'Milch 1,5', quantity: 2 },
      { text: 'Brot', quantity: 1 },
    ]);
    expect(job.model).toBe('opencode-go:gpt-6-luna');
    expect(job.paid).toBe(true);
    expect(job.error).toBeUndefined();
    expect(job.finishedAt).toEqual(expect.any(Number));
    // The photo itself is passed straight through and never kept.
    expect(job).not.toHaveProperty('imageBase64');
    expect(mockExtract).toHaveBeenCalledWith('data:image/jpeg;base64,AAAA');
  });

  it('keeps the failure message and no lines when the photo cannot be read', async () => {
    mockExtract.mockRejectedValueOnce(new Error('the photo contained no readable shopping list'));

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    const job = await settle(started.id);

    expect(job.status).toBe('error');
    expect(job.error).toBe('the photo contained no readable shopping list');
    expect(job.lines).toBeUndefined();
    expect(job.model).toBeUndefined();
  });

  it('is invisible to another user', () => {
    mockExtract.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');

    expect(getExtractJob('alice', started.id)).not.toBeNull();
    expect(getExtractJob('bob', started.id)).toBeNull();
    expect(getExtractJob('alice', 'abc123')).toBeNull();
  });

  it('evicts the oldest job once a user has more than five', () => {
    mockExtract.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });

    const ids = Array.from({ length: 6 }, () => startExtractJob('alice', 'data:image/jpeg;base64,AAAA').id);

    expect(getExtractJob('alice', ids[0])).toBeNull();
    for (const id of ids.slice(1)) expect(getExtractJob('alice', id)).not.toBeNull();

    // Another user's registry is untouched by alice's churn.
    const bob = startExtractJob('bob', 'data:image/jpeg;base64,AAAA');
    for (let i = 0; i < 5; i += 1) startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    expect(getExtractJob('bob', bob.id)).not.toBeNull();
  });
});
