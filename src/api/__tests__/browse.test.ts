import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser, fetchCsrf, createOrder, getSessionUserId } from './helpers';
import PurchaseSession from '../../models/PurchaseSession';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

let cookies = '';
let userId = '';

async function withCsrf() {
  const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
  return {
    cookie: `${cookies}; ${csrfCookies.join('; ')}`,
    token,
  };
}

async function seedReceipt(overrides: Record<string, unknown> = {}) {
  return PurchaseSession.create({
    userId,
    key: `k-${Math.random()}`,
    purchasedAt: new Date('2026-11-12T16:00:00Z'),
    store: 'Marktkauf Musterstadt',
    type: 'CART',
    total: 23.9,
    unitCount: 2,
    items: [
      { brand: 'Gut & Günstig', name: 'H-Milch 1,5%', quantity: 1, unitPrice: 0.95 },
      { brand: 'Bauernbrot', name: 'Bauernbrot 750g', quantity: 1, unitPrice: 2.89 },
    ],
    ...overrides,
  });
}

beforeEach(async () => {
  await clearDB();
  await registerUser();
  cookies = await loginUser();
  userId = await getSessionUserId(cookies);
});

describe('GET /api/location', () => {
  it('shows both sources and says the location is not set', async () => {
    const res = await request(app).get('/api/location').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.context.source).toBe('unknown');
    expect(res.body.providers.map((p: { provider: string }) => p.provider)).toEqual(['knuspr', 'edeka']);
    for (const provider of res.body.providers) {
      expect(provider.available).toBe(true);
      expect(provider.reason).toMatch(/not set/i);
      expect(provider.connected).toBe(false);
    }
    expect(res.body.destination).toBe('knuspr-cart');
  });

  it('marks Knuspr available once the home city is Munich', async () => {
    const { cookie, token } = await withCsrf();
    const put = await request(app)
      .put('/api/location')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ homeCity: 'München' });

    expect(put.status).toBe(200);
    expect(put.body.context).toMatchObject({ source: 'home', city: 'München' });
    expect(put.body.providers.find((p: { provider: string }) => p.provider === 'knuspr').available).toBe(true);
    expect(put.body.destination).toBe('knuspr-cart');
  });

  it('turns away windows into an EDEKA list destination', async () => {
    const { cookie, token } = await withCsrf();
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const put = await request(app)
      .put('/api/location')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({
        homeCity: 'Munich',
        awayWindows: [{ from: from.toISOString(), to: to.toISOString(), city: 'Berlin' }],
      });

    expect(put.status).toBe(200);
    expect(put.body.context.source).toBe('away');
    expect(put.body.context.city).toBe('Berlin');
    const knuspr = put.body.providers.find((p: { provider: string }) => p.provider === 'knuspr');
    expect(knuspr.available).toBe(false);
    expect(knuspr.reason).toContain('Munich only');
    expect(put.body.destination).toBe('edeka-list');
    expect(put.body.reason).toContain('EDEKA list');
  });

  it('rejects a window that ends before it starts', async () => {
    const { cookie, token } = await withCsrf();
    const put = await request(app)
      .put('/api/location')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({
        homeCity: 'Munich',
        awayWindows: [{ from: '2026-11-27', to: '2026-11-20', city: 'Berlin' }],
      });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain('from must not be after to');
  });
});

describe('GET /api/activity', () => {
  it('merges deliveries and store runs, with per-source totals', async () => {
    await createOrder(userId, {
      id: 9001,
      orderTimeDate: new Date('2026-11-14T18:00:00Z'),
      priceComposition: { total: { amount: 42.5, currency: 'EUR' } },
    });
    await seedReceipt();

    const res = await request(app).get('/api/activity').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].provider).toBe('knuspr');
    expect(res.body.events[0]).not.toHaveProperty('lines');
    expect(res.body.events[0].lineCount).toBeGreaterThan(0);
    expect(res.body.totals).toMatchObject({ knuspr: 42.5, edeka: 23.9, all: 66.4, count: 2 });
  });

  it('filters by provider and date', async () => {
    await createOrder(userId, { id: 9002, orderTimeDate: new Date('2026-11-14T18:00:00Z') });
    await seedReceipt();

    const onlyEdeka = await request(app).get('/api/activity?provider=edeka').set('Cookie', cookies);
    expect(onlyEdeka.body.events).toHaveLength(1);

    const laterOnly = await request(app)
      .get('/api/activity?from=2026-11-13T00:00:00.000Z')
      .set('Cookie', cookies);
    expect(laterOnly.body.events).toHaveLength(1);
    expect(laterOnly.body.events[0].provider).toBe('knuspr');
  });
});

describe('GET /api/activity/:id', () => {
  it('returns the lines for one entry', async () => {
    await createOrder(userId, { id: 9100 });
    const res = await request(app).get('/api/activity/knuspr:9100').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('knuspr:9100');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.occasions).toEqual([]);
  });

  it('404s an entry that is gone and 400s a malformed id', async () => {
    const missing = await request(app).get('/api/activity/knuspr:1').set('Cookie', cookies);
    expect(missing.status).toBe(404);
    const malformed = await request(app).get('/api/activity/not-an-id').set('Cookie', cookies);
    expect(malformed.status).toBe(400);
  });
});

describe('GET /api/products', () => {
  it('returns one stat row per provider and never a merged figure', async () => {
    await seedReceipt();
    const res = await request(app).get('/api/products').set('Cookie', cookies);
    expect(res.status).toBe(200);

    const edekaItem = res.body.items.find((item: { id: string }) => item.id.startsWith('edeka:'));
    expect(edekaItem).toBeDefined();
    expect(Object.keys(edekaItem.statsByProvider)).toEqual(['edeka']);
    expect(edekaItem.statsByProvider.edeka.provider).toBe('edeka');

    for (const item of res.body.items) {
      expect(Object.keys(item.statsByProvider).length).toBe(1);
    }
    expect(res.body.location.destination).toBe('knuspr-cart');
  });

  it('filters by source', async () => {
    await seedReceipt();
    const res = await request(app).get('/api/products?source=knuspr').set('Cookie', cookies);
    expect(res.body.items.every((item: { id: string }) => item.id.startsWith('knuspr:'))).toBe(true);
  });
});

describe('GET /api/search', () => {
  it('needs at least two characters', async () => {
    const res = await request(app).get('/api/search?q=m').set('Cookie', cookies);
    expect(res.status).toBe(400);
  });

  it('answers from history instantly and says what is not connected', async () => {
    await seedReceipt();
    const res = await request(app).get('/api/search?q=milch').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.history.length).toBeGreaterThan(0);
    expect(res.body.history[0].provider).toBe('edeka');
    expect(res.body.edeka.state).toBe('unavailable');
    expect(res.body.edeka.reason).toContain('not connected');
    expect(res.body.knuspr.state).toBe('later');
  });
});
