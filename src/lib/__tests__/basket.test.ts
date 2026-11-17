import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { setupTestDB, clearDB, teardownTestDB } from '../../api/__tests__/helpers';
import BotRun from '../../models/BotRun';
import BotSettings from '../../models/BotSettings';
import Integration, { IntegrationProvider } from '../../models/Integration';
import { encrypt } from '../crypto';

// Both external baskets are mocked. The adapters themselves, the location gate,
// the guardrails and the BotRun record all run for real.
const cart = vi.hoisted(() => ({
  addItems: vi.fn(),
  checkCart: vi.fn(),
  cartQuantityByProduct: vi.fn(),
  fetchPrices: vi.fn(),
  normalizeCart: vi.fn(),
  removeItems: vi.fn(),
}));

vi.mock('../knuspr-cart', () => cart);
vi.mock('../knuspr-auth', () => ({
  getKnusprSession: vi.fn().mockResolvedValue('knuspr-session'),
}));

const shopper = vi.hoisted(() => ({
  upsertItem: vi.fn(),
  removeItem: vi.fn(),
  signup: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../easyshopper/client', () => ({
  EasyShopperClient: class {
    upsertItem = shopper.upsertItem;
    removeItem = shopper.removeItem;
    signup = shopper.signup;
    login = shopper.login;
  },
}));

const { addToBasket, undoBasketRun } = await import('../basket');

const KEY = Buffer.alloc(32, 7);

/**
 * A stored store account. Writing a list never creates one, so every EDEKA test
 * has to start connected, exactly like the app does after Settings.
 */
async function connectStore(userId: string) {
  await Integration.create({
    userId,
    provider: IntegrationProvider.EASySHOPPER,
    encryptedCredentials: encrypt(
      JSON.stringify({ secret: 'secret', deviceId: 'device', uniqueDeviceId: 'device-id', storeGuid: 'store' }),
      KEY
    ),
  });
}
const EMPTY_CART = { cartId: 1, totalPrice: 0, totalSavings: 0, items: [] };

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('addToBasket', () => {
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    userId = new mongoose.Types.ObjectId().toString();

    cart.checkCart.mockReset().mockResolvedValue({ cartId: 1, totalPrice: 0, items: {} });
    cart.normalizeCart.mockReset().mockResolvedValue(EMPTY_CART);
    cart.cartQuantityByProduct.mockReset().mockReturnValue(new Map());
    cart.fetchPrices.mockReset().mockResolvedValue(new Map());
    cart.addItems.mockReset().mockImplementation(async (_session, lines) => ({ added: lines, failed: [] }));
    cart.removeItems.mockReset().mockResolvedValue({ removed: [], failed: [] });

    shopper.signup.mockReset().mockResolvedValue({ secret: 'secret', deviceId: 'device' });
    shopper.login.mockReset().mockResolvedValue({ token: 'token', userGuid: 'user', storeGuid: 'store' });
    shopper.upsertItem.mockReset().mockResolvedValue({});
    shopper.removeItem.mockReset().mockResolvedValue({});
  });

  it('writes a Knuspr cart line and records a run with the location snapshot', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich' });
    cart.fetchPrices.mockResolvedValue(new Map([[101, { price: 2, effectivePrice: 2 }]]));

    const result = await addToBasket(userId, {
      destination: 'knuspr-cart',
      items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 2 }],
      derivedKey: KEY,
    });

    expect(result.status).toBe('added');
    expect(result.destination).toBe('knuspr-cart');
    expect(result.total).toBe(4);
    expect(result.added).toHaveLength(1);
    expect(cart.addItems).toHaveBeenCalledWith('knuspr-session', [{ productId: 101, amount: 2 }]);

    const run = await BotRun.findById(result.runId).lean();
    expect(run?.destination).toBe('knuspr-cart');
    expect(run?.status).toBe('in-cart');
    expect(run?.totalPrice).toBe(4);
    expect(run?.locationContext).toMatchObject({ source: 'home', city: 'Munich', country: 'DE' });
    expect(run?.items[0]).toMatchObject({ productId: 101, provider: 'knuspr', name: 'Milk', qty: 2 });
  });

  it('writes an EDEKA list line through the list client and records the run', async () => {
    await connectStore(userId);
    await BotSettings.create({ userId, homeCity: 'Berlin' });
    shopper.upsertItem.mockResolvedValue({ shoppingListItemGuid: 'row-1' });

    const result = await addToBasket(userId, {
      destination: 'edeka-list',
      items: [
        { provider: 'edeka', textKey: 'milk', name: 'Milk', qty: 3 },
        // A cart line cannot be invented into a list row.
        { provider: 'knuspr', productId: 101, name: 'Butter', qty: 1 },
      ],
      derivedKey: KEY,
    });

    expect(result.status).toBe('added');
    expect(result.destination).toBe('edeka-list');
    expect(result.total).toBe(0);
    expect(result.skipped).toEqual([{ name: 'Butter', reason: 'knuspr items cannot go to edeka-list' }]);
    expect(shopper.upsertItem).toHaveBeenCalledWith('token', 'store', { amount: 3, name: 'Milk' });

    const run = await BotRun.findById(result.runId).lean();
    expect(run?.destination).toBe('edeka-list');
    expect(run?.locationContext).toMatchObject({ source: 'home', city: 'Berlin', country: 'DE' });
    expect(run?.items[0]).toMatchObject({
      provider: 'edeka',
      textKey: 'milk',
      name: 'Milk',
      qty: 3,
      listItemGuid: 'row-1',
    });
  });

  it('records a checklist without touching either store', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich' });

    const result = await addToBasket(userId, {
      destination: 'checklist',
      items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 }],
      derivedKey: KEY,
    });

    expect(result.status).toBe('added');
    expect(cart.addItems).not.toHaveBeenCalled();
    expect(shopper.upsertItem).not.toHaveBeenCalled();
    const run = await BotRun.findById(result.runId).lean();
    expect(run?.destination).toBe('checklist');
  });

  it('refuses a Knuspr destination while the shopper is in Berlin', async () => {
    await BotSettings.create({ userId, homeCity: 'Berlin' });

    const result = await addToBasket(userId, {
      destination: 'knuspr-cart',
      items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 }],
      derivedKey: KEY,
    });

    expect(result.status).toBe('unavailable');
    expect(result.error).toContain('Munich only');
    expect(result.runId).toBeNull();
    expect(cart.addItems).not.toHaveBeenCalled();
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('blocks an over-limit basket before writing anything', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich', maxItems: 1 });
    cart.fetchPrices.mockResolvedValue(new Map([
      [101, { price: 1, effectivePrice: 1 }],
      [102, { price: 1, effectivePrice: 1 }],
    ]));

    const result = await addToBasket(userId, {
      destination: 'knuspr-cart',
      items: [
        { provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 },
        { provider: 'knuspr', productId: 102, name: 'Bread', qty: 1 },
      ],
      derivedKey: KEY,
    });

    expect(result.status).toBe('blocked');
    expect(result.guardrail.blocked).toBe(true);
    expect(result.guardrail.reason).toContain('1-item limit');
    expect(cart.addItems).not.toHaveBeenCalled();
    expect(await BotRun.countDocuments({ userId })).toBe(0);
  });

  it('blocks a basket over the euro limit', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich', maxEuro: 5 });
    cart.fetchPrices.mockResolvedValue(new Map([[101, { price: 9, effectivePrice: 9 }]]));

    const result = await addToBasket(userId, {
      destination: 'knuspr-cart',
      items: [{ provider: 'knuspr', productId: 101, name: 'Oil', qty: 1 }],
      derivedKey: KEY,
    });

    expect(result.status).toBe('blocked');
    expect(result.guardrail.reason).toContain('over the €5.00 limit');
    expect(result.total).toBe(9);
    expect(cart.addItems).not.toHaveBeenCalled();
  });

  it('skips what is already in the cart', async () => {
    await BotSettings.create({ userId, homeCity: 'Munich' });
    cart.cartQuantityByProduct.mockReturnValue(new Map([[101, 2]]));

    const result = await addToBasket(userId, {
      destination: 'knuspr-cart',
      items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 }],
      derivedKey: KEY,
    });

    expect(result.status).toBe('nothing-to-add');
    expect(result.skipped).toEqual([{ name: 'Milk', reason: 'already in the cart' }]);
    expect(cart.addItems).not.toHaveBeenCalled();
  });
});

describe('undoBasketRun', () => {
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    userId = new mongoose.Types.ObjectId().toString();
    cart.removeItems.mockReset().mockResolvedValue({ removed: [], failed: [] });
    shopper.upsertItem.mockReset().mockResolvedValue({});
    shopper.removeItem.mockReset().mockResolvedValue({});
    shopper.signup.mockReset().mockResolvedValue({ secret: 'secret', deviceId: 'device' });
    shopper.login.mockReset().mockResolvedValue({ token: 'token', userGuid: 'user', storeGuid: 'store' });
  });

  it('removes a Knuspr run from the cart and marks it undone', async () => {
    const run = await BotRun.create({
      userId,
      intent: { type: 'plan' },
      destination: 'knuspr-cart',
      items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 2 }],
      totalPrice: 4,
      status: 'in-cart',
    });
    cart.removeItems.mockResolvedValue({ removed: [{ productId: 101, amount: 2 }], failed: [] });

    const result = await undoBasketRun(userId, String(run._id), { derivedKey: KEY });

    expect(result).toEqual({ status: 'undone', restored: 1 });
    expect(cart.removeItems).toHaveBeenCalledWith(userId, 'knuspr-session', [{ productId: 101, amount: 2 }]);
    const reloaded = await BotRun.findById(run._id).lean();
    expect(reloaded?.status).toBe('undone');
  });

  it('undoes an EDEKA run by guid, falling back to amount 0 for a row without one', async () => {
    await connectStore(userId);
    const run = await BotRun.create({
      userId,
      intent: { type: 'plan' },
      destination: 'edeka-list',
      items: [
        { provider: 'edeka', name: 'Milk', qty: 2, listItemGuid: 'row-1' },
        { provider: 'edeka', name: 'Bread', qty: 1 },
      ],
      totalPrice: 0,
      status: 'in-cart',
    });

    const result = await undoBasketRun(userId, String(run._id), { derivedKey: KEY });

    expect(result).toEqual({ status: 'undone', restored: 2 });
    expect(shopper.removeItem).toHaveBeenCalledWith('token', 'store', 'row-1');
    expect(shopper.upsertItem).toHaveBeenCalledWith('token', 'store', { amount: 0, name: 'Bread' });
    const reloaded = await BotRun.findById(run._id).lean();
    expect(reloaded?.status).toBe('undone');
  });

  it('refuses to undo a run that is no longer open', async () => {
    const run = await BotRun.create({
      userId,
      intent: { type: 'plan' },
      destination: 'knuspr-cart',
      items: [{ provider: 'knuspr', productId: 101, name: 'Milk', qty: 1 }],
      totalPrice: 2,
      status: 'delivered',
    });

    const result = await undoBasketRun(userId, String(run._id), { derivedKey: KEY });

    expect(result.status).toBe('not-undoable');
    expect(cart.removeItems).not.toHaveBeenCalled();
  });

  it('answers not-found for another user\'s run', async () => {
    const otherUser = new mongoose.Types.ObjectId().toString();
    const run = await BotRun.create({
      userId: otherUser,
      intent: { type: 'plan' },
      destination: 'edeka-list',
      items: [{ provider: 'edeka', name: 'Milk', qty: 1 }],
      status: 'in-cart',
    });

    const result = await undoBasketRun(userId, String(run._id), { derivedKey: KEY });

    expect(result.status).toBe('not-found');
    expect(shopper.removeItem).not.toHaveBeenCalled();
  });
});
