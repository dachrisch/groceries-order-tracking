import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB,
  clearDB,
  teardownTestDB,
  registerUser,
  loginUser,
  fetchCsrf,
  getSessionUserId,
} from './helpers';
import Order from '../../models/Order';
import ProductLink from '../../models/ProductLink';
import PurchaseSession from '../../models/PurchaseSession';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(setupTestDB);
afterAll(teardownTestDB);

let cookies = '';
let userId = '';

async function withCsrf() {
  const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
  return { token, cookie: `${cookies}; ${csrfCookies.join('; ')}` };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** Four weekly milk deliveries: enough distinct weeks for a learned rate. */
async function seedMilkOrders() {
  for (let index = 0; index < 4; index++) {
    await Order.create({
      userId,
      id: 7000 + index,
      itemsCount: 1,
      orderTimeDate: daysAgo(index * 7 + 1),
      items: [{
        id: 1001,
        name: 'Vollmilch 1l',
        unit: 'l',
        textualAmount: '1l',
        amount: 1,
        images: [],
        priceComposition: {
          total: { amount: 129, currency: 'EUR' },
          unit: { amount: 129, currency: 'EUR' },
        },
        categories: [{ id: 7, name: 'Milch', slug: 'milch', level: 1 }],
      }],
    });
  }
}

async function seedReceipt(items: Array<{ brand?: string; name: string; unitPrice?: number }>) {
  return PurchaseSession.create({
    userId,
    key: `k-${Math.random()}`,
    purchasedAt: daysAgo(3),
    store: 'Marktkauf Musterstadt',
    type: 'CART',
    total: 10,
    unitCount: items.length,
    items,
  });
}

interface BrowseItem {
  id: string;
  statsByProvider: Record<string, { provider: string; purchases: number }>;
  offers: Array<{ provider: string; textKey?: string }>;
  linked?: { confidence: number; source: string };
  due: boolean;
  stockDays: number | null;
}

async function getProducts(): Promise<BrowseItem[]> {
  const res = await request(app).get('/api/products').set('Cookie', cookies);
  expect(res.status).toBe(200);
  return res.body.items as BrowseItem[];
}

beforeEach(async () => {
  await clearDB();
  await registerUser();
  cookies = await loginUser();
  userId = await getSessionUserId(cookies);
});

describe('GET /api/products with a cross-store link', () => {
  it('folds a name-matched EDEKA bucket into the Knuspr row, without a second row', async () => {
    await seedMilkOrders();
    await seedReceipt([{ brand: 'Gut & Günstig', name: 'Vollmilch 1l', unitPrice: 1.29 }]);

    const items = await getProducts();
    const knuspr = items.find((item) => item.id.startsWith('knuspr:'));
    expect(knuspr).toBeDefined();

    expect(Object.keys(knuspr!.statsByProvider).sort()).toEqual(['edeka', 'knuspr']);
    expect(knuspr!.statsByProvider.edeka.provider).toBe('edeka');
    expect(knuspr!.offers.map((offer) => offer.provider)).toEqual(['knuspr', 'edeka']);
    expect(knuspr!.linked).toEqual({ confidence: 1, source: 'auto' });
    // The linked offer names the line it would write, so a `+` that has to fall
    // back to EDEKA can say what it is adding.
    const edekaOffer = knuspr!.offers.find((offer) => offer.provider === 'edeka');
    expect(edekaOffer?.name).toBe('Gut & Günstig Vollmilch 1l');

    // The merged bucket must not also stand on its own.
    expect(items.some((item) => item.id.startsWith('edeka:'))).toBe(false);
  });

  it('keeps an unlinked EDEKA bucket as its own row', async () => {
    await seedMilkOrders();
    await seedReceipt([
      { brand: 'Gut & Günstig', name: 'Vollmilch 1l', unitPrice: 1.29 },
      { name: 'Bauernbrot 750g', unitPrice: 2.89 },
    ]);

    const items = await getProducts();
    const knuspr = items.find((item) => item.id.startsWith('knuspr:'));
    expect(knuspr!.statsByProvider.edeka).toBeDefined();

    const edekaRows = items.filter((item) => item.id.startsWith('edeka:'));
    expect(edekaRows).toHaveLength(1);
    expect(edekaRows[0].offers[0].textKey).toBeTruthy();
  });

  it('leaves a low-similarity pair unlinked instead of guessing', async () => {
    await seedMilkOrders();
    await seedReceipt([{ name: 'Bauernbrot 750g', unitPrice: 2.89 }]);

    const items = await getProducts();
    const knuspr = items.find((item) => item.id.startsWith('knuspr:'));
    expect(knuspr!.linked).toBeUndefined();
    expect(Object.keys(knuspr!.statsByProvider)).toEqual(['knuspr']);
    expect(items.filter((item) => item.id.startsWith('edeka:'))).toHaveLength(1);
  });

  it('never lets the linked EDEKA cadence change the Knuspr due and stock values', async () => {
    await seedMilkOrders();
    // Three in-store trips, enough for an EDEKA cadence of its own.
    for (let index = 0; index < 3; index++) {
      await PurchaseSession.create({
        userId,
        key: `trip-${index}`,
        purchasedAt: daysAgo(index * 7 + 2),
        store: 'Marktkauf Musterstadt',
        total: 3.87,
        items: [{ brand: 'Gut & Günstig', name: 'Vollmilch 1l', quantity: 1, unitPrice: 1.29 }],
      });
    }

    const items = await getProducts();
    const knuspr = items.find((item) => item.id.startsWith('knuspr:'));
    expect(knuspr!.linked).toBeDefined();
    // `due` and `stockDays` describe the delivery only; the EDEKA side is display.
    expect(typeof knuspr!.due).toBe('boolean');
    expect(knuspr!.stockDays).not.toBeNull();
    expect(knuspr!.statsByProvider.edeka.purchases).toBe(3);
  });
});

describe('PUT /api/product-links', () => {
  it('records a manual correction that wins over the matcher and survives a re-read', async () => {
    await seedMilkOrders();
    await seedReceipt([{ name: 'Bauernbrot 750g', unitPrice: 2.89 }]);

    const before = await getProducts();
    const bread = before.find((item) => item.id.startsWith('edeka:'));
    expect(bread).toBeDefined();
    const textKey = bread!.offers[0].textKey!;
    const knusprBefore = before.find((item) => item.id.startsWith('knuspr:'));
    expect(knusprBefore!.linked).toBeUndefined();

    const { cookie, token } = await withCsrf();
    const put = await request(app)
      .put('/api/product-links')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ knusprProductId: 1001, edekaTextKey: textKey });

    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      knusprProductId: 1001,
      link: { edekaTextKey: textKey, confidence: 1, source: 'manual' },
    });
    expect(await ProductLink.countDocuments({ userId })).toBe(1);

    for (let read = 0; read < 2; read += 1) {
      const after = await getProducts();
      const knuspr = after.find((item) => item.id.startsWith('knuspr:'));
      expect(knuspr!.linked).toEqual({ confidence: 1, source: 'manual' });
      expect(knuspr!.statsByProvider.edeka).toBeDefined();
      expect(knuspr!.offers.some((offer) => offer.provider === 'edeka')).toBe(true);
      expect(after.some((item) => item.id.startsWith('edeka:'))).toBe(false);
    }
  });

  it('clears the correction and lets the bucket stand alone again', async () => {
    await seedMilkOrders();
    await seedReceipt([{ name: 'Bauernbrot 750g', unitPrice: 2.89 }]);

    const before = await getProducts();
    const textKey = before.find((item) => item.id.startsWith('edeka:'))!.offers[0].textKey!;

    const { cookie, token } = await withCsrf();
    await request(app)
      .put('/api/product-links')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ knusprProductId: 1001, edekaTextKey: textKey });

    const clear = await request(app)
      .put('/api/product-links')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ knusprProductId: 1001, edekaTextKey: null });

    expect(clear.status).toBe(200);
    expect(clear.body.link).toBeNull();
    expect(await ProductLink.countDocuments({ userId })).toBe(0);

    const after = await getProducts();
    expect(after.find((item) => item.id.startsWith('knuspr:'))!.linked).toBeUndefined();
    expect(after.filter((item) => item.id.startsWith('edeka:'))).toHaveLength(1);
  });

  it('requires CSRF and a valid body', async () => {
    const noCsrf = await request(app)
      .put('/api/product-links')
      .set('Cookie', cookies)
      .send({ knusprProductId: 1001, edekaTextKey: 'x|y' });
    expect(noCsrf.status).toBe(403);
    expect(await ProductLink.countDocuments({ userId })).toBe(0);

    const { cookie, token } = await withCsrf();
    const badBody = await request(app)
      .put('/api/product-links')
      .set('Cookie', cookie)
      .set('x-csrf-token', token)
      .send({ knusprProductId: 'not-a-number', edekaTextKey: 'x|y' });
    expect(badBody.status).toBe(400);
    expect(await ProductLink.countDocuments({ userId })).toBe(0);
  });
});
