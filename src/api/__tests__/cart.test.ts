import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB, clearDB, teardownTestDB,
  registerUser, loginUser, getSessionUserId,
} from './helpers';
import Integration from '../../models/Integration';

// NOTE: vi.mock calls are hoisted to the top of the module by Vitest.
// They must be at module level — never inside it() blocks.

vi.mock('../../lib/knuspr-auth', () => ({
  loginToKnuspr: vi.fn().mockResolvedValue({ session: 'test-session', userId: 99 }),
}));

// Mock decrypt so we don't need real key derivation in tests.
vi.mock('../../lib/crypto', () => ({
  decrypt: vi.fn().mockReturnValue(JSON.stringify({ email: 'user@example.com', password: 'pw123' })),
  encrypt: vi.fn().mockReturnValue('encrypted'),
  deriveKey: vi.fn().mockReturnValue('testkey'),
}));

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('POST /api/cart/add', () => {
  let cookies: string;
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    vi.unstubAllGlobals();
    await registerUser();
    cookies = await loginUser();
    userId = await getSessionUserId(cookies);
  });

  it('returns 404 when Knuspr is not connected', async () => {
    const res = await request(app)
      .post('/api/cart/add')
      .set('Cookie', cookies)
      .send({ productId: '12345', count: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Knuspr not connected/);
  });

  it('returns 400 when productId is missing', async () => {
    const res = await request(app)
      .post('/api/cart/add')
      .set('Cookie', cookies)
      .send({ count: 1 });

    expect(res.status).toBe(400);
  });

  it('calls the real Knuspr cart endpoint and returns cart on success', async () => {
    await Integration.create({
      userId,
      provider: 'knuspr',
      encryptedCredentials: 'encrypted',
      encryptedHeaders: null,
    });

    const mockCartResponse = {
      data: {
        cartId: 111,
        totalPrice: 1.49,
        totalSavings: 0,
        items: {
          '12345': {
            productId: 12345,
            productName: 'Test Milk',
            price: 1.49,
            quantity: 1,
            imgPath: '/images/grocery/products/12345/img.jpg',
            textualAmount: '1 l',
            multipack: null,
          },
        },
      },
    };

    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, json: async () => mockCartResponse })
    );

    const res = await request(app)
      .post('/api/cart/add')
      .set('Cookie', cookies)
      .send({ productId: '12345', count: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cart.cartId).toBe(111);
    expect(res.body.cart.totalPrice).toBe(1.49);
    expect(res.body.cart.items).toHaveLength(1);
    expect(res.body.cart.items[0].productId).toBe(12345);
    expect(res.body.cart.items[0].productName).toBe('Test Milk');
    expect(res.body.cart.items[0].imgUrl).toBe('https://www.knuspr.de/images/grocery/products/12345/img.jpg');
    expect(res.body.cart.items[0].multipack).toBeUndefined();

    const fetchMock = vi.mocked(fetch);
    const [addUrl, addInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(addUrl).toBe('https://www.knuspr.de/api/v1/cart/item');
    const addBody = JSON.parse(addInit.body as string);
    expect(addBody.productId).toBe(12345);  // number, not string
    expect(addBody.source).toBe('reorder');
    expect(addBody.actionId).toBeNull();

    const [checkUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(checkUrl).toBe('https://www.knuspr.de/services/frontend-service/v2/cart-review/check-cart');
  });

  it('returns success: true with cart: null when check-cart fails', async () => {
    await Integration.create({
      userId,
      provider: 'knuspr',
      encryptedCredentials: 'encrypted',
      encryptedHeaders: null,
    });

    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '' })
      .mockRejectedValueOnce(new Error('network error'))
    );

    const res = await request(app)
      .post('/api/cart/add')
      .set('Cookie', cookies)
      .send({ productId: '12345', count: 1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cart).toBeNull();
  });

  it('returns error when Knuspr add call fails', async () => {
    await Integration.create({
      userId,
      provider: 'knuspr',
      encryptedCredentials: 'encrypted',
      encryptedHeaders: null,
    });

    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'Out of stock' })
    );

    const res = await request(app)
      .post('/api/cart/add')
      .set('Cookie', cookies)
      .send({ productId: '12345', count: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/409/);
  });
});
