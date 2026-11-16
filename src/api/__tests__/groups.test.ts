import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser, fetchCsrf, createOrder, getSessionUserId } from './helpers';
import ProductGroup from '../../models/ProductGroup';
import { invalidateProductGroupCache, rebuildProductGroups } from '../../lib/bot/product-groups';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

let cookies = '';
let userId = '';

async function withCsrf() {
  const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
  return { cookie: `${cookies}; ${csrfCookies.join('; ')}`, token };
}

function items(...ids: number[]) {
  return ids.map((id) => ({
    id,
    name: `Produkt ${id}`,
    unit: 'Stk',
    textualAmount: '500 g',
    amount: 1,
    images: [],
    priceComposition: { total: { amount: 2, currency: 'EUR' } },
  }));
}

beforeEach(async () => {
  await clearDB();
  await registerUser();
  cookies = await loginUser();
  userId = await getSessionUserId(cookies);
  invalidateProductGroupCache(userId);
});

describe('manual product groups', () => {
  it('carries the id the split endpoint needs', async () => {
    await createOrder(userId, { id: 7001, items: items(1, 2, 3) });
    const { cookie, token } = await withCsrf();

    const merge = await request(app)
      .post('/api/bot/groups/merge')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ productIds: [1, 2] });
    expect(merge.status).toBe(200);

    const list = await request(app).get('/api/bot/groups').set('Cookie', cookies);
    const manual = list.body.find((group: { manual: boolean }) => group.manual);

    expect(manual).toBeDefined();
    expect(mongoose.isValidObjectId(manual._id)).toBe(true);

    const stored = await ProductGroup.findById(manual._id).lean();
    expect(stored?.manual).toBe(true);
    expect(stored?.productIds?.sort()).toEqual([1, 2]);
  });

  it('splits a manual group by that id', async () => {
    await createOrder(userId, { id: 7002, items: items(11, 12, 13) });
    const { cookie, token } = await withCsrf();

    const merge = await request(app)
      .post('/api/bot/groups/merge')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ productIds: [11, 12, 13] });
    const manualId = merge.body.groups.find((group: { manual: boolean }) => group.manual)._id;

    const split = await request(app)
      .post(`/api/bot/groups/${manualId}/split`)
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ productId: 13 });

    expect(split.status).toBe(200);
    const stored = await ProductGroup.findById(manualId).lean();
    expect(stored?.productIds?.sort()).toEqual([11, 12]);
  });
});

describe('rebuildProductGroups', () => {
  it('runs once when two reads arrive with a cold cache', async () => {
    await createOrder(userId, { id: 7101, items: items(21, 22) });
    invalidateProductGroupCache(userId);

    // Both start before either finishes: without the in-flight guard they would
    // both delete and re-upsert the same keys and lose on the unique index.
    const [first, second] = await Promise.all([
      rebuildProductGroups(userId),
      rebuildProductGroups(userId),
    ]);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(await ProductGroup.countDocuments({ userId, manual: false })).toBe(first.length);
  });
});
