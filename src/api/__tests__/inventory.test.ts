import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB, clearDB, teardownTestDB,
  registerUser, loginUser, getSessionUserId,
  createOrder,
} from './helpers';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('GET /api/inventory', () => {
  let cookies: string;
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
    userId = await getSessionUserId(cookies);
  });

  // NOTE: createOrder spreads overrides — when overriding `items`, provide
  // the full item object (no partial merge with DEFAULT_ITEM).
  const makeItem = (id: number, name: string, amount: number, orderFieldId: number) => ({
    id, name, amount, orderFieldId,
    unit: 'l',
    textualAmount: '1 l',
    images: [],
    priceComposition: { total: { amount: 149, currency: 'EUR' }, unit: { amount: 149, currency: 'EUR' } },
    compensated: false,
  });

  it('returns avgQuantity based on typical order amounts', async () => {
    // Seed 3 orders for the same product with varying quantities
    await createOrder(userId, {
      orderTimeDate: new Date('2024-01-01'),
      items: [makeItem(42, 'Milk', 2, 1)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-02-01'),
      items: [makeItem(42, 'Milk', 3, 2)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-03-01'),
      items: [makeItem(42, 'Milk', 2, 3)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    expect(res.status).toBe(200);
    const item = res.body.find((i: any) => i._id === 42);
    expect(item).toBeDefined();
    expect(item.avgQuantity).toBeGreaterThanOrEqual(1);
    expect(typeof item.avgQuantity).toBe('number');
    // Average of [2, 3, 2] = 2.33 → rounds to 2
    expect(item.avgQuantity).toBe(2);
  });

  it('returns avgQuantity of at least 1 even for zero-amount items', async () => {
    await createOrder(userId, {
      orderTimeDate: new Date('2024-01-01'),
      items: [makeItem(55, 'Bread', 0, 10)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-02-01'),
      items: [makeItem(55, 'Bread', 0, 11)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    expect(res.status).toBe(200);
    const item = res.body.find((i: any) => i._id === 55);
    expect(item.avgQuantity).toBe(1);
  });

  it('still returns correct avgInterval after refactor', async () => {
    // Verify the interval logic is intact after the tuple refactor
    await createOrder(userId, {
      orderTimeDate: new Date('2024-01-01'),
      items: [makeItem(77, 'Eggs', 1, 20)],
    });
    await createOrder(userId, {
      orderTimeDate: new Date('2024-02-01'),
      items: [makeItem(77, 'Eggs', 1, 21)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    const item = res.body.find((i: any) => i._id === 77);
    expect(item).toBeDefined();
    // ~31 days between Jan 1 and Feb 1
    expect(item.avgInterval).toBeCloseTo(31, 0);
    expect(item.daysSinceLast).toBeGreaterThan(0);
  });
});
