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

/** Register a user and return the response */
export async function registerUser(
  data = { name: 'Alice', email: 'alice@example.com', password: 'secret123' }
) {
  return request(app).post('/api/register').send(data);
}

/** Login and return the Set-Cookie header string */
export async function loginUser(
  credentials = { email: 'alice@example.com', password: 'secret123' }
): Promise<string> {
  const res = await request(app).post('/api/login').send(credentials);
  return (res.headers['set-cookie'] as string[]).join('; ');
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
