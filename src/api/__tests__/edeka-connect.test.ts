import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// The store client is mocked: these tests are about *when* an account may be
// created, and a real signup would put a user in the shop's database.
const shopper = vi.hoisted(() => ({
  signup: vi.fn(),
  login: vi.fn(),
  upsertItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('../../lib/easyshopper/client', () => ({
  EasyShopperClient: class {
    signup = shopper.signup;
    login = shopper.login;
    upsertItem = shopper.upsertItem;
    removeItem = shopper.removeItem;
  },
}));

import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser, fetchCsrf, getSessionUserId } from './helpers';
import BotSettings from '../../models/BotSettings';
import BotRun from '../../models/BotRun';
import Integration from '../../models/Integration';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

let cookies = '';
let userId = '';

async function withCsrf() {
  const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
  return { cookie: `${cookies}; ${csrfCookies.join('; ')}`, token };
}

beforeEach(async () => {
  await clearDB();
  shopper.signup.mockReset().mockResolvedValue({ secret: 'secret', deviceId: 'device' });
  shopper.login.mockReset().mockResolvedValue({ token: 'token', userGuid: 'user', storeGuid: 'store' });
  shopper.upsertItem.mockReset().mockResolvedValue({ shoppingListItemGuid: 'row-1' });
  shopper.removeItem.mockReset().mockResolvedValue({});

  await registerUser();
  cookies = await loginUser();
  userId = await getSessionUserId(cookies);
});

describe('an EDEKA account is never created as a side effect', () => {
  it('refuses a basket written to the list when nothing is connected', async () => {
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    const { cookie, token } = await withCsrf();

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ destination: 'edeka-list', items: [{ provider: 'edeka', name: 'Milk', qty: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('edeka-not-connected');
    expect(res.body.error).toContain('Connect EDEKA');
    expect(shopper.signup).not.toHaveBeenCalled();
    expect(shopper.upsertItem).not.toHaveBeenCalled();
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('refuses a list plan when nothing is connected', async () => {
    const { cookie, token } = await withCsrf();

    const res = await request(app)
      .post('/api/easyshopper/list/plan')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ lines: ['Milch'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('edeka-not-connected');
    expect(shopper.signup).not.toHaveBeenCalled();
  });
});

describe('POST /api/easyshopper/connect', () => {
  it('creates the account once and is idempotent', async () => {
    const { cookie, token } = await withCsrf();

    const first = await request(app)
      .post('/api/easyshopper/connect')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({});

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ connected: true, alreadyConnected: false });
    expect(shopper.signup).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post('/api/easyshopper/connect')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({});

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ connected: true, alreadyConnected: true });
    // A second tap must not register a second device user.
    expect(shopper.signup).toHaveBeenCalledTimes(1);
    expect(await Integration.countDocuments({ userId })).toBe(1);
  });

  it('makes the basket work afterwards', async () => {
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    const { cookie, token } = await withCsrf();

    await request(app)
      .post('/api/easyshopper/connect')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({});

    const res = await request(app)
      .post('/api/basket/add')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ destination: 'edeka-list', items: [{ provider: 'edeka', name: 'Milk', qty: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('added');
    expect(shopper.upsertItem).toHaveBeenCalledWith('token', 'store', { amount: 2, name: 'Milk' });
  });
});
