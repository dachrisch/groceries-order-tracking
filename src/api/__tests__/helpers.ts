import mongoose from 'mongoose';
import request from 'supertest';
import { connectDB } from '../../lib/mongodb';
import Order from '../../models/Order';
import { app } from '../app';

export async function setupTestDB() {
  await connectDB();
}

export async function clearDB() {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export async function teardownTestDB() {
  await mongoose.disconnect();
}

/** Fetch a fresh CSRF token and return { token, cookies } */
export async function fetchCsrf(existingCookies?: string): Promise<{ token: string; cookies: string[] }> {
  let req = request(app).get('/api/csrf-token');
  if (existingCookies) {
    req = req.set('Cookie', existingCookies);
  }
  const res = await req;
  return {
    token: res.body.token,
    cookies: res.headers['set-cookie'] as string[],
  };
}

/** Register a user and return the response */
export async function registerUser(
  data = { name: 'Alice', email: 'alice@example.com', password: 'secret123' }
) {
  const { token, cookies } = await fetchCsrf();
  return request(app)
    .post('/api/register')
    .set('Cookie', cookies)
    .set('x-csrf-token', token)
    .send(data);
}

/** Login and return the Set-Cookie header string (session cookies only) */
export async function loginUser(
  credentials = { email: 'alice@example.com', password: 'secret123' }
): Promise<string> {
  const { token, cookies: csrfCookies } = await fetchCsrf();
  const res = await request(app)
    .post('/api/login')
    .set('Cookie', csrfCookies)
    .set('x-csrf-token', token)
    .send(credentials);
  
  if (res.status !== 200) {
    throw new Error(`Login failed with status ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const loginCookies = res.headers['set-cookie'] as string[];
  if (!loginCookies) {
    throw new Error(`Login failed: No cookies returned`);
  }
  
  // Return only session cookies (token, dkey) to avoid CSRF cookie conflicts later
  return loginCookies.join('; ');
}

/** Get the current user's _id from the session endpoint */
export async function getSessionUserId(cookies: string): Promise<string> {
  const res = await request(app).get('/api/session').set('Cookie', cookies);
  return res.body._id;
}

const DEFAULT_ITEM = {
  id: 1001,
  name: 'Milk',
  unit: 'l',
  textualAmount: '1l',
  amount: 1,
  images: ['https://example.com/milk.jpg'],
  priceComposition: {
    total: { amount: 149, currency: 'EUR' },
    unit: { amount: 149, currency: 'EUR' },
  },
  orderFieldId: 1,
  compensated: false,
};

/** Seed one order into the database for a given userId */
export async function createOrder(
  userId: string,
  overrides: Record<string, unknown> = {}
) {
  return Order.create({
    userId,
    id: Math.floor(Math.random() * 1_000_000),
    itemsCount: 1,
    priceComposition: {
      total: { amount: 4250, currency: 'EUR' },
      goods: { amount: 3999, currency: 'EUR' },
      delivery: { amount: 299, currency: 'EUR' },
      creditsUsed: { amount: 0, currency: 'EUR' },
      courierTip: { amount: 0, currency: 'EUR' },
    },
    orderTime: '2024-01-15T10:00:00',
    orderTimeDate: new Date('2024-01-15T10:00:00'),
    deliveryType: 'standard',
    address: '123 Test St',
    state: 'delivered',
    items: [DEFAULT_ITEM],
    ...overrides,
  });
}
