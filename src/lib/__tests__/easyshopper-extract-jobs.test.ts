/**
 * The photo job registry has no Mongo and no network, so it can be tested here
 * even where `mongodb-memory-server` cannot spawn (musl container, glibc mongod).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../easyshopper/extract', async (importOriginal) => ({
  // Partial: `NO_READABLE_LIST` must be the real string the registry compares against.
  ...(await importOriginal<typeof import('../easyshopper/extract')>()),
  extractListLines: vi.fn(),
}));

import { extractListLines, NO_READABLE_LIST } from '../easyshopper/extract';
import {
  __resetExtractJobsForTests,
  getExtractJob,
  startExtractJob,
  type ExtractJob,
} from '../easyshopper/extract-jobs';

const mockExtract = vi.mocked(extractListLines);

beforeEach(() => {
  mockExtract.mockReset();
  __resetExtractJobsForTests();
  // The registry logs the detail it refuses to show the shopper; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The job body runs detached; wait for the status to settle instead of guessing a delay. */
async function settle(id: string, userId = 'alice'): Promise<ExtractJob> {
  await vi.waitFor(() => {
    expect(['done', 'error']).toContain(getExtractJob(userId, id)?.status);
  });
  const job = getExtractJob(userId, id);
  if (!job) throw new Error('job vanished');
  return job;
}

/** A promise this test controls, so a job can be inspected while it is genuinely running. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('startExtractJob', () => {
  it('copies lines, model and paid off a successful extraction', async () => {
    mockExtract.mockResolvedValueOnce({
      lines: [
        { text: 'Milch 1,5', quantity: 2 },
        { text: 'Brot', quantity: 1 },
      ],
      ticked: 2,
      model: 'opencode-go:gpt-6-luna',
      paid: true,
    });

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    expect(started).not.toBeNull();
    const job = started as ExtractJob;

    const settled = await settle(job.id);

    expect(settled.status).toBe('done');
    expect(settled.lines).toEqual([
      { text: 'Milch 1,5', quantity: 2 },
      { text: 'Brot', quantity: 1 },
    ]);
    expect(settled.ticked).toBe(2);
    expect(settled.model).toBe('opencode-go:gpt-6-luna');
    expect(settled.paid).toBe(true);
    expect(settled.error).toBeUndefined();
    expect(settled.finishedAt).toEqual(expect.any(Number));
    // The photo itself is passed straight through and never kept.
    expect(settled).not.toHaveProperty('imageBase64');
    expect(mockExtract).toHaveBeenCalledWith('data:image/jpeg;base64,AAAA');
  });

  it('settles an all-ticked list successfully with no lines', async () => {
    mockExtract.mockResolvedValueOnce({ lines: [], ticked: 4 });

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    const settled = await settle((started as ExtractJob).id);

    // Nothing to add is not a failure: the UI shows a note, not an error.
    expect(settled.status).toBe('done');
    expect(settled.lines).toEqual([]);
    expect(settled.ticked).toBe(4);
    expect(settled.error).toBeUndefined();
  });

  it('keeps the shopper-facing message for an unreadable photo', async () => {
    mockExtract.mockRejectedValueOnce(new Error(NO_READABLE_LIST));

    const job = (await settle(startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!.id)) as ExtractJob;

    expect(job.status).toBe('error');
    expect(job.error).toBe(NO_READABLE_LIST);
    expect(job.lines).toBeUndefined();
    expect(job.model).toBeUndefined();
  });

  it('does not forward a raw provider error to the shopper', async () => {
    const consoleError = vi.spyOn(console, 'error');
    mockExtract.mockRejectedValueOnce(
      new Error('opencode generation failed: 402 payment required for opencode-go:gpt-6-luna')
    );

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    const job = await settle(started!.id);

    expect(job.error).toBe('the photo could not be read — try again or type the list');
    expect(job.error).not.toMatch(/402|opencode-go/);
    // The detail is not lost, only kept server-side.
    expect(consoleError).toHaveBeenCalledWith(
      '[easyshopper] photo read failed:',
      'opencode generation failed: 402 payment required for opencode-go:gpt-6-luna'
    );
  });

  it('turns a non-Error throw into the generic message, not "[object Object]"', async () => {
    mockExtract.mockRejectedValueOnce({ status: 500, body: 'internal' });

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    const job = await settle(started!.id);

    expect(job.status).toBe('error');
    expect(job.error).toBe('the photo could not be read — try again or type the list');
  });

  it('settles the job even when describing the failure throws', async () => {
    // The status is written before the message, so a broken log sink cannot leave the
    // user locked out behind a 429: a 'running' job refuses the next read.
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('the log sink is gone');
    });
    mockExtract.mockRejectedValueOnce(new Error('provider said 500'));

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    const job = await settle(started!.id);

    expect(job.status).toBe('error');
    expect(job.error).toBe('the photo could not be read — try again or type the list');
    // Settled means the next read is accepted, not refused.
    mockExtract.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });
    expect(startExtractJob('alice', 'data:image/jpeg;base64,AAAA')).not.toBeNull();
  });

  it('gives up at the deadline instead of waiting for a chain that may run for half an hour', async () => {
    // The real chain can spend ~36 min on model × attempt × timeout; the UI waits ~3.
    mockExtract.mockReturnValueOnce(new Promise(() => {}));

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA', { deadlineMs: 20 });
    expect(started).not.toBeNull();

    const job = await settle(started!.id);

    expect(job.status).toBe('error');
    expect(job.error).toBe('reading the photo took too long — type the list instead');
    expect(job.lines).toBeUndefined();
    // Settled, so the shopper may try again.
    expect(job.finishedAt).toEqual(expect.any(Number));
  });

  it('allows only one running read per user', async () => {
    const pending = deferred<{ lines: { text: string; quantity: number }[] }>();
    mockExtract.mockReturnValueOnce(pending.promise);

    const first = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    expect(first).not.toBeNull();
    // A second chain would be a second paid call, and the poller could not see it.
    expect(startExtractJob('alice', 'data:image/jpeg;base64,AAAA')).toBeNull();

    // A different user is not blocked by alice's read.
    mockExtract.mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });
    const bob = startExtractJob('bob', 'data:image/jpeg;base64,AAAA');
    expect(bob).not.toBeNull();

    pending.resolve({ lines: [{ text: 'Brot', quantity: 1 }] });
    expect((await settle(first!.id)).status).toBe('done');
    await settle(bob!.id, 'bob');

    // Settled: alice may read another photo.
    mockExtract.mockResolvedValueOnce({ lines: [{ text: 'Milch', quantity: 1 }] });
    expect(startExtractJob('alice', 'data:image/jpeg;base64,AAAA')).not.toBeNull();
  });

  it('is invisible to another user', () => {
    mockExtract.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });

    const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;

    expect(getExtractJob('alice', started.id)).not.toBeNull();
    expect(getExtractJob('bob', started.id)).toBeNull();
    expect(getExtractJob('alice', 'abc123')).toBeNull();
  });

  it('evicts only a settled job once a user has more than five', async () => {
    mockExtract.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
      expect(started).not.toBeNull();
      ids.push(started!.id);
      await settle(started!.id);
    }
    // Nothing is evicted while the registry is at the cap.
    for (const id of ids) expect(getExtractJob('alice', id)).not.toBeNull();

    const sixth = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;
    await settle(sixth.id);

    expect(getExtractJob('alice', ids[0])).toBeNull();
    for (const id of ids.slice(1)) expect(getExtractJob('alice', id)).not.toBeNull();
    expect(getExtractJob('alice', sixth.id)).not.toBeNull();

    // Another user's registry is untouched by alice's churn.
    const bob = startExtractJob('bob', 'data:image/jpeg;base64,AAAA')!;
    for (let i = 0; i < 5; i += 1) startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    expect(getExtractJob('bob', bob.id)).not.toBeNull();
  });

  it('makes room for a new read by evicting a settled job, never the one it starts', async () => {
    mockExtract.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;
      ids.push(started.id);
      await settle(started.id);
    }

    const running = deferred<{ lines: { text: string; quantity: number }[] }>();
    mockExtract.mockReturnValueOnce(running.promise);
    // Four settled jobs are at the cap, so the fifth slot holds the live one.
    const live = startExtractJob('alice', 'data:image/jpeg;base64,AAAA');
    if (live === null) {
      // At the cap with five settled jobs the new read is refused only when one runs;
      // here nothing runs yet, so it must start.
      throw new Error('a settled registry at the cap must still accept a new read');
    }
    // The cap is enforced by evicting a settled job, never the live one.
    expect(getExtractJob('alice', live.id)).not.toBeNull();
    expect(ids.filter((id) => getExtractJob('alice', id) !== null)).toHaveLength(4);

    running.resolve({ lines: [{ text: 'Milch', quantity: 1 }] });
    expect((await settle(live.id)).status).toBe('done');
  });
});

/**
 * The sweep is the only thing that keeps the registry from growing forever, and its
 * guard (age from `finishedAt`, never from a live job) is invisible to every other
 * test here. Fake timers only: the deadline test above runs on the real clock.
 */
describe('job sweep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ONE_HOUR = 60 * 60 * 1000;

  /** Flush the detached worker's microtasks without firing its 120 s deadline. */
  async function flush() {
    await vi.advanceTimersByTimeAsync(1);
  }

  it('forgets a settled job after the hour', async () => {
    mockExtract.mockResolvedValue({ lines: [{ text: 'Brot', quantity: 1 }] });

    const old = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;
    await flush();
    expect(getExtractJob('alice', old.id)?.status).toBe('done');

    vi.setSystemTime(Date.now() + ONE_HOUR + 60_000);
    const fresh = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;
    await flush();

    expect(getExtractJob('alice', old.id)).toBeNull();
    expect(getExtractJob('alice', fresh.id)).not.toBeNull();
  });

  it('ages a job from the moment it settled, not from when it started', async () => {
    // A deadline longer than the jump below, so the job is genuinely still reading when
    // the clock moves. Production caps this at two minutes; the registry must still age
    // by `finishedAt`, because that is what "started" would get wrong.
    const slow = deferred<{ lines: { text: string; quantity: number }[] }>();
    mockExtract.mockReturnValue(slow.promise);
    const late = startExtractJob('alice', 'data:image/jpeg;base64,AAAA', { deadlineMs: ONE_HOUR })!;
    await flush();

    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    slow.resolve({ lines: [{ text: 'Milch', quantity: 1 }] });
    await flush();
    expect(getExtractJob('alice', late.id)?.status).toBe('done');

    // 70 minutes after it started, 40 after it settled: still worth reading.
    vi.setSystemTime(Date.now() + 40 * 60 * 1000);
    const fresh = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;
    await flush();

    expect(getExtractJob('alice', late.id)).not.toBeNull();
    expect(getExtractJob('alice', fresh.id)).not.toBeNull();
  });

  it('keeps a read that is still running, however old its creation time', async () => {
    // Still running after an hour of wall clock: only the deadline can end it, and the
    // sweep must not delete it — its poller is the one waiting.
    const stuck = deferred<{ lines: { text: string; quantity: number }[] }>();
    mockExtract.mockReturnValue(stuck.promise);

    const live = startExtractJob('alice', 'data:image/jpeg;base64,AAAA')!;
    await flush();
    expect(getExtractJob('alice', live.id)?.status).toBe('running');

    vi.setSystemTime(Date.now() + ONE_HOUR + 60_000);
    // The concurrency guard answers first: one read at a time.
    expect(startExtractJob('alice', 'data:image/jpeg;base64,AAAA')).toBeNull();

    expect(getExtractJob('alice', live.id)?.status).toBe('running');

    // Not swept, just late: it finishes normally and counts as fresh from now on.
    stuck.resolve({ lines: [{ text: 'Milch', quantity: 1 }] });
    await flush();
    expect(getExtractJob('alice', live.id)?.status).toBe('done');
  });
});
