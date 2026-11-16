import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// Hoisted so the mock factory can hand out the same spies the tests configure.
const opencodeStub = vi.hoisted(() => ({
  runPrompt: vi.fn(),
  isOpencodeConfigured: vi.fn(() => true),
}));

vi.mock('../../lib/opencode-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/opencode-client')>()),
  runPrompt: opencodeStub.runPrompt,
  isOpencodeConfigured: opencodeStub.isOpencodeConfigured,
}));

import request from 'supertest';
import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser, fetchCsrf } from './helpers';
import PurchaseSession from '../../models/PurchaseSession';
import { findListForStore } from '../controllers/easyshopper.controller';
import { isOpencodeConfigured, NOT_AN_ANSWER, runPrompt } from '../../lib/opencode-client';
import { __resetExtractJobsForTests } from '../../lib/easyshopper/extract-jobs';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

const capture = {
  sessions: [
    {
      key: '11/13/2026 04:50 PM|MARKTKAUF MUSTERSTADT|107.19',
      displayWhen: '11/13/2026, 04:50 PM',
      purchasedAt: '2026-11-13T15:50:00.000Z',
      store: 'Edeka Musterstadt (MUSTERSTR.)',
      type: 'CART',
      paymentMode: 'EASY Shopper Cashier',
      receiptBarcode: null,
      itemCount: 36,
      total: 107.19,
      items: [
        { brand: 'Kneipp', name: 'Dusche 200ml Gute Laune', quantity: 1, unitPrice: 2.95, lineTotal: 2.95 },
        { brand: 'Frosch', name: 'Waschmittel 22WL 1450g Sensitiv Aloe Vera Pulver', quantity: 1, unitPrice: 5.45, lineTotal: 5.45 },
      ],
    },
    {
      displayWhen: '10/17/2026, 11:54 AM',
      purchasedAt: '2026-10-17T09:54:00.000Z',
      store: 'Wez Musterstadt',
      type: 'CART',
      total: 16.96,
      items: [{ brand: null, name: 'Kiwi gold', quantity: 2, unitPrice: 0.33, lineTotal: 0.66 }],
    },
  ],
};

describe('EASY Shopper purchase import', () => {
  let cookies: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
  });

  it('stores sessions and is idempotent on re-import', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    const first = await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(capture);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: 2, inserted: 2 });

    const second = await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(capture);

    expect(second.status).toBe(200);
    expect(second.body.inserted).toBe(0);
    expect(await PurchaseSession.countDocuments()).toBe(2);
  });

  it('derives a stable key when the capture did not provide one', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    const body = { sessions: [capture.sessions[1]] };
    await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(body);
    await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(body);

    const stored = await PurchaseSession.find().lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toContain('16.96');
  });

  it('rejects an empty payload', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    const res = await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send({ sessions: [] });
    expect(res.status).toBe(400);
  });

  it('returns sessions newest first with a per-store summary', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(capture);

    const res = await request(app).get('/api/easyshopper/purchases').set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].store).toContain('Musterstadt');
    expect(res.body.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: expect.stringContaining('Musterstadt'), visits: 1, total: 107.19 }),
        expect.objectContaining({ visits: 1, total: 16.96 }),
      ])
    );
  });

  it('keeps purchases out of the Knuspr order collection', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(capture);

    const res = await request(app).get('/api/orders').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('findListForStore', () => {
  it('picks the list bound to the requested store', () => {
    const lists = [
      { shoppingListGuid: 'a', storeGuid: 'store-1' },
      { shoppingListGuid: 'b', storeGuid: 'store-2' },
    ];
    expect(findListForStore(lists, 'store-2')).toBe('b');
  });

  it('falls back to the first list when none is store-tagged', () => {
    expect(findListForStore([{ guid: 'only' }], 'store-x')).toBe('only');
  });

  it('returns null for an empty account', () => {
    expect(findListForStore([], 'store-x')).toBeNull();
  });
});

/**
 * End-to-end against a real capture, when one exists on this machine. Skipped in CI
 * (no phone), but it is the check that catches schema drift against real receipts.
 */
const REAL_CAPTURE = join(homedir(), '.local/share/groceries/easyshopper/purchases.json');

describe.runIf(existsSync(REAL_CAPTURE))('EASY Shopper import of a real capture', () => {
  let cookies: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
  });

  it('imports every captured session and keeps deposits out of the spend', async () => {
    const capture = JSON.parse(readFileSync(REAL_CAPTURE, 'utf8')) as {
      sessions: Array<{ items: unknown[]; total: number }>;
    };
    const sessions = capture.sessions.filter((session) => session.items.length > 0);
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);

    const res = await request(app)
      .post('/api/easyshopper/import-purchases')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send({ sessions });

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(sessions.length);

    const insights = await request(app).get('/api/easyshopper/insights').set('Cookie', cookies);
    expect(insights.status).toBe(200);
    expect(insights.body.totals.sessions).toBe(sessions.length);
    expect(insights.body.totals.spend).toBeCloseTo(
      sessions.reduce((sum, session) => sum + session.total, 0),
      2
    );
    // Deposits are money back, never products.
    expect(insights.body.topProducts.map((product: { name: string }) => product.name)).not.toContain('Leergut');
    expect(insights.body.totals.creditReturned).toBeLessThan(0);
  });
});

describe('EASY Shopper photo intake', () => {
  let cookies: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
    vi.mocked(runPrompt).mockReset();
    vi.mocked(isOpencodeConfigured).mockReturnValue(true);
    // The registry is process-wide and these tests share it.
    __resetExtractJobsForTests();
  });

  /** A photo big enough to clear the schema's 64-char floor. */
  const photo = `data:image/jpeg;base64,${'A'.repeat(200)}`;

  function startExtract(body: unknown = { imageBase64: photo }, csrfCookies: string[] = [], token = '') {
    return request(app)
      .post('/api/easyshopper/list/extract')
      .set('Cookie', `${cookies}; ${csrfCookies.join('; ')}`)
      .set('x-csrf-token', token)
      .send(body as object);
  }

  /** Poll a photo job the way the UI does, so a hung job fails the test instead of hanging. */
  async function pollJob(jobId: string, settleOn: 'done' | 'error') {
    let body: {
      status: string;
      lines: unknown[] | null;
      model?: string | null;
      paid?: boolean | null;
      error?: string | null;
    } = { status: 'pending', lines: null };
    for (let i = 0; i < 50 && body.status !== settleOn; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const poll = await request(app).get(`/api/easyshopper/list/extract/${jobId}`).set('Cookie', cookies);
      // A broken poll loop must not look like a slow model.
      expect(poll.status).toBe(200);
      body = poll.body;
    }
    return body;
  }

  it('extracts list lines through opencode and exposes them on the job', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(runPrompt).mockImplementationOnce(async (_prompt, options) => {
      options?.onModelUsed?.({ id: 'gpt-6-luna', providerID: 'opencode-go', paid: true });
      return { lines: [{ text: '2x Milch 1,5', quantity: 2 }, { text: 'Brot', quantity: 1 }] };
    });

    const started = await startExtract({ imageBase64: photo }, csrfCookies, token);

    expect(started.status).toBe(202);
    expect(started.body.jobId).toBeTruthy();

    const body = await pollJob(started.body.jobId, 'done');

    expect(body.status).toBe('done');
    expect(body.lines).toEqual([
      { text: 'Milch 1,5', quantity: 2 },
      { text: 'Brot', quantity: 1 },
    ]);
    // Visible, so a paid fallback cannot go unnoticed.
    expect(body.model).toBe('opencode-go:gpt-6-luna');
    expect(body.paid).toBe(true);
  });

  it('marks a free answer as unpaid', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(runPrompt).mockImplementationOnce(async (_prompt, options) => {
      options?.onModelUsed?.({ id: 'qwen-vl-ocr', providerID: 'opencode', paid: false });
      return { lines: [{ text: 'Butter', quantity: 1 }] };
    });

    const started = await startExtract({ imageBase64: photo }, csrfCookies, token);

    expect(started.status).toBe(202);
    const body = await pollJob(started.body.jobId, 'done');

    expect(body.status).toBe('done');
    expect(body.model).toBe('opencode:qwen-vl-ocr');
    expect(body.paid).toBe(false);
  });

  it('says why an unreadable photo could not be read', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(runPrompt).mockRejectedValueOnce(new Error(NOT_AN_ANSWER));

    const started = await startExtract({ imageBase64: photo }, csrfCookies, token);

    expect(started.status).toBe(202);
    const body = await pollJob(started.body.jobId, 'error');

    expect(body.status).toBe('error');
    expect(body.error).toBe('the photo contained no readable shopping list');
  });

  it('does not forward a raw provider error to the shopper', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(runPrompt).mockRejectedValueOnce(new Error('opencode generation failed: 402 payment required'));

    const started = await startExtract({ imageBase64: photo }, csrfCookies, token);

    expect(started.status).toBe(202);
    const body = await pollJob(started.body.jobId, 'error');

    expect(body.status).toBe('error');
    expect(body.error).toBe('the photo could not be read — try again or type the list');
    expect(body.error).not.toMatch(/402|opencode/);
  });

  it('closes the door when a read is already running', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(runPrompt).mockImplementationOnce(() => new Promise(() => {}));

    const first = await startExtract({ imageBase64: photo }, csrfCookies, token);
    expect(first.status).toBe(202);

    const second = await startExtract({ imageBase64: photo }, csrfCookies, token);
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/already being read/);
  });

  it('refuses a photo when opencode is not configured', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(isOpencodeConfigured).mockReturnValueOnce(false);

    const res = await startExtract({ imageBase64: photo }, csrfCookies, token);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/opencode/);
  });

  it('rejects an oversized photo with a readable message, before the body limit', async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);

    // 2 MB of base64 still fits express.json({limit:'2mb'}); the schema ceiling is lower,
    // so the shopper gets a field message rather than a bare 413 from the parser.
    const res = await startExtract({ imageBase64: 'A'.repeat(2_000_001) }, csrfCookies, token);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageBase64/);
  });

  it("does not return another user's extraction", async () => {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    vi.mocked(runPrompt).mockResolvedValueOnce({ lines: [{ text: 'Brot', quantity: 1 }] });
    const started = await startExtract({ imageBase64: photo }, csrfCookies, token);
    expect(started.status).toBe(202);

    const other = { name: 'Bob', email: 'bob@example.com', password: 'secret123' };
    await registerUser(other);
    const otherCookies = await loginUser({ email: other.email, password: other.password });
    const poll = await request(app)
      .get(`/api/easyshopper/list/extract/${started.body.jobId}`)
      .set('Cookie', otherCookies);
    expect(poll.status).toBe(404);

    // Positive control: the id exists, the 404 is about whose job it is.
    const owner = await request(app)
      .get(`/api/easyshopper/list/extract/${started.body.jobId}`)
      .set('Cookie', cookies);
    expect(owner.status).toBe(200);
  });
});
