import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB, clearDB, teardownTestDB,
  registerUser, loginUser, getSessionUserId, fetchCsrf
} from './helpers';
import BotRun from '../../models/BotRun';
import BotSettings from '../../models/BotSettings';

// No real basket is touched: both store adapters are mocked, while routing,
// auth, CSRF, the location gate and the run record run for real.
const cart = vi.hoisted(() => ({
  addItems: vi.fn(),
  checkCart: vi.fn(),
  cartQuantityByProduct: vi.fn(),
  fetchPrices: vi.fn(),
  normalizeCart: vi.fn(),
  getCart: vi.fn(),
  removeItems: vi.fn(),
}));

vi.mock('../../lib/knuspr-cart', () => cart);
vi.mock('../../lib/knuspr-auth', () => ({
  loginToKnuspr: vi.fn().mockResolvedValue({ session: 'test-session', userId: 99 }),
  getKnusprSession: vi.fn().mockResolvedValue('test-session'),
}));

const shopper = vi.hoisted(() => ({
  upsertItem: vi.fn(),
  removeItem: vi.fn(),
  signup: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../../lib/easyshopper/client', () => ({
  EasyShopperClient: class {
    upsertItem = shopper.upsertItem;
    removeItem = shopper.removeItem;
    signup = shopper.signup;
    login = shopper.login;
  },
}));

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('/api/basket', () => {
  let cookies: string;
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
    userId = await getSessionUserId(cookies);

    cart.addItems.mockReset().mockImplementation(async (_session, lines) => ({ added: lines, failed: [] }));
    cart.checkCart.mockReset().mockResolvedValue({ cartId: 1, totalPrice: 0, items: {} });
    cart.cartQuantityByProduct.mockReset().mockReturnValue(new Map());
    cart.fetchPrices.mockReset().mockResolvedValue(new Map([[101, { price: 2, effectivePrice: 2 }]]));
    cart.normalizeCart.mockReset().mockResolvedValue({ cartId: 1, totalPrice: 0, totalSavings: 0, items: [] });
    cart.removeItems.mockReset().mockResolvedValue({ removed: [{ productId: 101, amount: 2 }], failed: [] });

    shopper.signup.mockReset().mockResolvedValue({ secret: 'secret', deviceId: 'device' });
    shopper.login.mockReset().mockResolvedValue({ token: 'token', userGuid: 'user', storeGuid: 'store' });
    shopper.upsertItem.mockReset().mockResolvedValue({ shoppingListItemGuid: 'row-1' });
    shopper.removeItem.mockReset().mockResolvedValue({});
  });

  async function session() {
    const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
    return { token, cookie: `${cookies}; ${csrfCookies.join('; ')}` };
  }

  /** The list path needs a connected account: writing a list never creates one. */
  async function connectEdeka() {
    const { token, cookie } = await session();
    const res = await request(app)
      .post('/api/easyshopper/connect')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({});
    expect(res.status).toBe(200);
  }

  it('requires a CSRF token for a basket write', async () => {
    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookies)
      .send({ destination: 'knuspr-cart', items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 }] });

    expect(res.status).toBe(403);
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('adds to the Knuspr cart and records the destination', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich' });
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ destination: 'knuspr-cart', items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('added');
    expect(res.body.destination).toBe('knuspr-cart');
    expect(res.body.total).toBe(4);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.guardrail.blocked).toBe(false);
    expect(cart.addItems).toHaveBeenCalledWith('test-session', [{ productId: 101, amount: 2 }]);

    const run = await BotRun.findById(res.body.runId).lean();
    expect(run?.destination).toBe('knuspr-cart');
    expect(run?.items[0]).toMatchObject({ productId: 101, name: 'Milk', qty: 2 });
  });

  it('adds to the EDEKA list and records the destination', async () => {
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    await connectEdeka();
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ destination: 'edeka-list', items: [{ provider: 'edeka', textKey: 'milk', name: 'Milk', qty: 3 }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('added');
    expect(res.body.destination).toBe('edeka-list');
    expect(shopper.upsertItem).toHaveBeenCalledWith('token', 'store', { amount: 3, name: 'Milk' });

    const run = await BotRun.findById(res.body.runId).lean();
    expect(run?.destination).toBe('edeka-list');
    expect(run?.items[0]).toMatchObject({ provider: 'edeka', name: 'Milk', qty: 3 });
  });

  it('rejects a destination the location cannot reach', async () => {
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ destination: 'knuspr-cart', items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Munich only');
    expect(res.body.destination).toBe('knuspr-cart');
    expect(cart.addItems).not.toHaveBeenCalled();
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('refuses the weekly fill away from the delivery area', async () => {
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/bot/fill-week')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('unavailable');
    expect(res.body.error).toContain('Munich only');
    // The fill only knows how to write a cart, so nothing may reach the store.
    expect(cart.addItems).not.toHaveBeenCalled();
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('blocks an over-limit basket without writing', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich', maxItems: 1 });
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({
        destination: 'knuspr-cart',
        items: [
          { provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 },
          { provider: 'knuspr', productId: 102, name: 'Bread', qty: 1 },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.guardrail.blocked).toBe(true);
    expect(res.body.guardrail.reason).toContain('1-item limit');
    expect(cart.addItems).not.toHaveBeenCalled();
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('returns 400 for a cart line without a product id', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich' });
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ destination: 'knuspr-cart', items: [{ provider: 'knuspr', name: 'Milk', qty: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('productId');
  });

  it('undoes a Knuspr run through the cart', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich' });
    let sessionCookies = await session();

    const add = await request(app)
      .post('/api/basket/add')
      .set('Cookie', sessionCookies.cookie)
      .set('x-csrf-token', sessionCookies.token)
      .send({ destination: 'knuspr-cart', items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 2 }] });
    expect(add.status).toBe(200);

    sessionCookies = await session();
    const res = await request(app)
      .post(`/api/basket/undo/${add.body.runId}`)
      .set('Cookie', sessionCookies.cookie)
      .set('x-csrf-token', sessionCookies.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ undone: true, restored: 1 });
    expect(cart.removeItems).toHaveBeenCalledWith(userId, 'test-session', [{ productId: 101, amount: 2 }]);
    const run = await BotRun.findById(add.body.runId).lean();
    expect(run?.status).toBe('undone');
  });

  it('undoes an EDEKA run through the list', async () => {
    await connectEdeka();
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    let sessionCookies = await session();

    const add = await request(app)
      .post('/api/basket/add')
      .set('Cookie', sessionCookies.cookie)
      .set('x-csrf-token', sessionCookies.token)
      .send({ destination: 'edeka-list', items: [{ provider: 'edeka', textKey: 'milk', name: 'Milk', qty: 2 }] });
    expect(add.status).toBe(200);

    sessionCookies = await session();
    const res = await request(app)
      .post(`/api/basket/undo/${add.body.runId}`)
      .set('Cookie', sessionCookies.cookie)
      .set('x-csrf-token', sessionCookies.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ undone: true, restored: 1 });
    expect(shopper.removeItem).toHaveBeenCalledWith('token', 'store', 'row-1');
    const run = await BotRun.findById(add.body.runId).lean();
    expect(run?.status).toBe('undone');
  });

  it('answers 400 for a malformed run id', async () => {
    const { token, cookie } = await session();

    const res = await request(app)
      .post('/api/basket/undo/not-an-id')
      .set('Cookie', cookie)
      .set('x-csrf-token', token);

    expect(res.status).toBe(400);
  });

  it('answers 404 for a run that is not the caller\'s', async () => {    const { token, cookie } = await session();
    const otherUser = new mongoose.Types.ObjectId().toString();
    const run = await BotRun.create({
      userId: otherUser,
      intent: { type: 'plan' },
      destination: 'edeka-list',
      items: [{ provider: 'edeka', name: 'Milk', qty: 1 }],
      status: 'in-cart',
    });

    const res = await request(app)
      .post(`/api/basket/undo/${run._id}`)
      .set('Cookie', cookie)
      .set('x-csrf-token', token);

    expect(res.status).toBe(404);
    expect(shopper.removeItem).not.toHaveBeenCalled();
  });
});
