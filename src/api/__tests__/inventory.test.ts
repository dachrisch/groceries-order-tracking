import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB, clearDB, teardownTestDB,
  registerUser, loginUser, getSessionUserId,
  createOrder,
} from './helpers';

// Mock getKnusprSession and global fetch
vi.mock('../../lib/knuspr-auth', async () => {
  const actual = await vi.importActual('../../lib/knuspr-auth');
  return {
    ...actual,
    getKnusprSession: vi.fn(),
  };
});

// Import the mocked function
import { getKnusprSession } from '../../lib/knuspr-auth';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

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
      orderTimeDate: daysAgo(21),
      items: [makeItem(42, 'Milk', 2, 1)],
    });
    await createOrder(userId, {
      orderTimeDate: daysAgo(14),
      items: [makeItem(42, 'Milk', 3, 2)],
    });
    await createOrder(userId, {
      orderTimeDate: daysAgo(1),
      items: [makeItem(42, 'Milk', 2, 3)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    expect(res.status).toBe(200);
    const item = res.body.find((i: { _id: number }) => i._id === 42);
    expect(item).toBeDefined();
    expect(item.avgQuantity).toBeGreaterThanOrEqual(1);
    expect(typeof item.avgQuantity).toBe('number');
    // Mode of [2, 3, 2] = 2
    expect(item.avgQuantity).toBe(2);
  });

  it('returns avgQuantity of at least 1 even for zero-amount items', async () => {
    await createOrder(userId, {
      orderTimeDate: daysAgo(21),
      items: [makeItem(55, 'Bread', 0, 10)],
    });
    await createOrder(userId, {
      orderTimeDate: daysAgo(14),
      items: [makeItem(55, 'Bread', 0, 11)],
    });
    await createOrder(userId, {
      orderTimeDate: daysAgo(1),
      items: [makeItem(55, 'Bread', 0, 12)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    expect(res.status).toBe(200);
    const item = res.body.find((i: { _id: number }) => i._id === 55);
    expect(item.avgQuantity).toBe(1);
  });

  it('still returns a sensible interval after switching to the consumption model', async () => {
    // Three purchases 31 days apart.
    await createOrder(userId, {
      orderTimeDate: daysAgo(63),
      items: [makeItem(77, 'Eggs', 1, 20)],
    });
    await createOrder(userId, {
      orderTimeDate: daysAgo(32),
      items: [makeItem(77, 'Eggs', 1, 21)],
    });
    await createOrder(userId, {
      orderTimeDate: daysAgo(1),
      items: [makeItem(77, 'Eggs', 1, 22)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);

    const item = res.body.find((i: { _id: number }) => i._id === 77);
    expect(item).toBeDefined();
    expect(item.avgInterval).toBeCloseTo(31, 0);
    expect(item.daysSinceLast).toBeGreaterThan(0);
    expect(item.stockDays).not.toBeNull();
  });

  it('excludes one-off purchases from the inventory', async () => {
    await createOrder(userId, {
      orderTimeDate: daysAgo(14),
      items: [makeItem(88, 'Birthday cake', 1, 30)],
    });

    const res = await request(app).get('/api/inventory').set('Cookie', cookies);
    expect(res.body.find((i: { _id: number }) => i._id === 88)).toBeUndefined();
  });

  it('fetches enhanced metadata from Knuspr API including sale prices', async () => {
    // Seed 3 orders for product 220
    await createOrder(userId, {
      id: 111,
      orderTimeDate: daysAgo(21),
      items: [makeItem(220, 'Sojasprossen', 1, 100)],
    });
    await createOrder(userId, {
      id: 222,
      orderTimeDate: daysAgo(10),
      items: [makeItem(220, 'Sojasprossen', 1, 101)],
    });
    await createOrder(userId, {
      id: 223,
      orderTimeDate: daysAgo(1),
      items: [makeItem(220, 'Sojasprossen', 1, 102)],
    });

    vi.mocked(getKnusprSession).mockResolvedValueOnce('mock-session');
    const originalFetch = global.fetch;
    type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          productId: 220,
          price: { amount: 2.49 },
          sales: [
            {
              active: true,
              price: { amount: 1.99 }
            }
          ]
        }
      ])
    }) as unknown as MockFetch;

    try {
      const res = await request(app).get('/api/inventory').set('Cookie', cookies);
      expect(res.status).toBe(200);
      const item = res.body.find((i: { _id: number }) => i._id === 220);
      expect(item).toBeDefined();
      expect(item.currentPrice).toBe(1.99);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('falls back to originalPrice if salePrice is missing', async () => {
    await createOrder(userId, {
      id: 333,
      orderTimeDate: daysAgo(21),
      items: [makeItem(221, 'Tofu', 1, 200)],
    });
    await createOrder(userId, {
      id: 444,
      orderTimeDate: daysAgo(10),
      items: [makeItem(221, 'Tofu', 1, 201)],
    });
    await createOrder(userId, {
      id: 445,
      orderTimeDate: daysAgo(1),
      items: [makeItem(221, 'Tofu', 1, 202)],
    });

    vi.mocked(getKnusprSession).mockResolvedValueOnce('mock-session');
    const originalFetch = global.fetch;
    type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        {
          productId: 221,
          price: { amount: 2.99 }
        }
      ])
    }) as unknown as MockFetch;

    try {
      const res = await request(app).get('/api/inventory').set('Cookie', cookies);
      expect(res.status).toBe(200);
      const item = res.body.find((i: { _id: number }) => i._id === 221);
      expect(item).toBeDefined();
      expect(item.currentPrice).toBe(2.99);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
