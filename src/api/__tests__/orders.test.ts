import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB,
  clearDB,
  teardownTestDB,
  registerUser,
  loginUser,
  getSessionUserId,
  createOrder,
} from './helpers';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('Order endpoints', () => {
  let cookies: string;
  let userId: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
    userId = await getSessionUserId(cookies);
  });

  describe('GET /api/stats', () => {
    it('returns zero totals when no orders exist', async () => {
      const res = await request(app).get('/api/stats').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body.totalOrders).toBe(0);
      expect(res.body.totalSpend).toBe(0);
      expect(res.body.totalItems).toBe(0);
      expect(res.body.distinctItems).toBe(0);
    });

    it('returns correct totals when orders exist', async () => {
      await createOrder(userId, { itemsCount: 3 });

      const res = await request(app).get('/api/stats').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body.totalOrders).toBe(1);
      expect(res.body.totalSpend).toBe(4250);
      expect(res.body.totalItems).toBe(3);
      expect(res.body.distinctItems).toBe(1);
    });

    it('only includes orders belonging to the authenticated user', async () => {
      // Create another user with their own order
      await registerUser({ name: 'Bob', email: 'bob@example.com', password: 'secret123' });
      const bobCookies = await loginUser({ email: 'bob@example.com', password: 'secret123' });
      const bobId = await getSessionUserId(bobCookies);
      await createOrder(bobId);

      const res = await request(app).get('/api/stats').set('Cookie', cookies);
      expect(res.body.totalOrders).toBe(0); // Alice sees none of Bob's orders
    });

    it('returns 401 when not authenticated', async () => {
      expect((await request(app).get('/api/stats')).status).toBe(401);
    });
  });

  describe('GET /api/aggregates', () => {
    it('returns empty array when no orders exist', async () => {
      const res = await request(app).get('/api/aggregates').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('groups orders by year and month', async () => {
      await createOrder(userId, { orderTimeDate: new Date('2024-01-15') });
      await createOrder(userId, { orderTimeDate: new Date('2024-01-28') });
      await createOrder(userId, { orderTimeDate: new Date('2024-02-10') });

      const res = await request(app).get('/api/aggregates').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);

      const jan = res.body.find((m: any) => m._id.month === 1);
      expect(jan.orderCount).toBe(2);
      expect(jan.totalAmount).toBe(8500); // 4250 * 2

      const feb = res.body.find((m: any) => m._id.month === 2);
      expect(feb.orderCount).toBe(1);
    });

    it('returns 401 when not authenticated', async () => {
      expect((await request(app).get('/api/aggregates')).status).toBe(401);
    });
  });

  describe('GET /api/orders', () => {
    it('returns empty array when no orders exist', async () => {
      const res = await request(app).get('/api/orders').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns orders sorted by date descending, without items', async () => {
      const order1 = await createOrder(userId, { orderTimeDate: new Date('2024-01-01') });
      const order2 = await createOrder(userId, { orderTimeDate: new Date('2024-03-01') });

      const res = await request(app).get('/api/orders').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe(order2.id); // most recent first
      expect(res.body[1].id).toBe(order1.id);
      expect(res.body[0].items).toBeUndefined(); // items excluded
    });

    it('returns 401 when not authenticated', async () => {
      expect((await request(app).get('/api/orders')).status).toBe(401);
    });
  });

  describe('GET /api/orders/:id', () => {
    it('returns the full order with items', async () => {
      const order = await createOrder(userId);

      const res = await request(app)
        .get(`/api/orders/${order.id}`)
        .set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(order.id);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('Milk');
    });

    it('returns 404 for an order that does not exist', async () => {
      const res = await request(app)
        .get('/api/orders/999999')
        .set('Cookie', cookies);

      expect(res.status).toBe(404);
    });

    it('returns 404 for an order belonging to another user', async () => {
      await registerUser({ name: 'Bob', email: 'bob@example.com', password: 'secret123' });
      const bobCookies = await loginUser({ email: 'bob@example.com', password: 'secret123' });
      const bobId = await getSessionUserId(bobCookies);
      const bobOrder = await createOrder(bobId);

      const res = await request(app)
        .get(`/api/orders/${bobOrder.id}`)
        .set('Cookie', cookies);

      expect(res.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      expect((await request(app).get('/api/orders/123')).status).toBe(401);
    });
  });

  describe('GET /api/product-trends', () => {
    it('returns empty array when no orders exist', async () => {
      const res = await request(app).get('/api/product-trends').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('groups price history per product across orders', async () => {
      await createOrder(userId, { orderTimeDate: new Date('2024-01-15') });
      await createOrder(userId, { orderTimeDate: new Date('2024-02-15') });

      const res = await request(app).get('/api/product-trends').set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1); // one distinct product (Milk, id 1001)
      expect(res.body[0]._id.name).toBe('Milk');
      expect(res.body[0].count).toBe(2); // purchased twice
      expect(res.body[0].prices).toHaveLength(2);
    });

    it('returns 401 when not authenticated', async () => {
      expect((await request(app).get('/api/product-trends')).status).toBe(401);
    });
  });
});
