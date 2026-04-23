import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser } from './helpers';
import Integration, { IntegrationProvider } from '../../models/Integration';
import * as orderImporter from '../../lib/order-importer';

vi.mock('../../lib/order-importer', () => ({
  importOrders: vi.fn().mockResolvedValue({ importedCount: 0 })
}));

beforeAll(setupTestDB);
beforeEach(async () => {
  await clearDB();
  vi.clearAllMocks();
});
afterAll(teardownTestDB);

describe('POST /api/register', () => {
  it('creates a new user and returns 201 with userId', async () => {
    const res = await registerUser();

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('User created');
    expect(res.body.userId).toBeDefined();
  });

  it('returns 400 when the email is already registered', async () => {
    await registerUser();
    const res = await registerUser(); // same email again

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('User already exists');
  });

  it('returns 400 when required fields are missing or invalid', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ email: 'bad-email', password: '123' }); // no name, invalid email, short password

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/login', () => {
  beforeEach(() => registerUser());

  it('returns 200 and sets httpOnly auth cookies on valid credentials', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'alice@example.com', password: 'secret123' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Alice');
    expect(res.body.user.email).toBe('alice@example.com');

    const cookies = res.headers['set-cookie'] as string[];
    expect(cookies.some((c) => c.startsWith('token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('dkey='))).toBe(true);
    expect(cookies.every((c) => c.includes('HttpOnly'))).toBe(true);
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'alice@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('returns 401 for an unknown email', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'unknown@example.com', password: 'secret123' });

    expect(res.status).toBe(401);
  });

  it('triggers background sync if a Knuspr integration exists and lastSyncAt is old', async () => {
    // 1. Get user
    const userRes = await registerUser({ name: 'Bob', email: 'bob@example.com', password: 'password123' });
    const userId = userRes.body.userId;

    // 2. Create old integration
    await Integration.create({
      userId,
      provider: IntegrationProvider.KNUSPR,
      encryptedCredentials: 'fake-encrypted-data',
      lastSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
    });

    // 3. Login
    await request(app)
      .post('/api/login')
      .send({ email: 'bob@example.com', password: 'password123' });

    // 4. Verify sync was triggered (allow some time for background promise)
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(orderImporter.importOrders).toHaveBeenCalled();
  });

  it('does NOT trigger background sync if lastSyncAt is recent', async () => {
    const userRes = await registerUser({ name: 'Charlie', email: 'charlie@example.com', password: 'password123' });
    const userId = userRes.body.userId;

    await Integration.create({
      userId,
      provider: IntegrationProvider.KNUSPR,
      lastSyncAt: new Date(Date.now() - 30 * 60 * 1000) // 30 mins ago
    });

    await request(app)
      .post('/api/login')
      .send({ email: 'charlie@example.com', password: 'password123' });

    await new Promise(resolve => setTimeout(resolve, 100));
    expect(orderImporter.importOrders).not.toHaveBeenCalled();
  });
});

describe('GET /api/session', () => {
  it('returns user profile (without password) when authenticated', async () => {
    await registerUser();
    const cookies = await loginUser();

    const res = await request(app).get('/api/session').set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Alice');
    expect(res.body.email).toBe('alice@example.com');
    expect(res.body.password).toBeUndefined();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/api/session');

    expect(res.status).toBe(401);
  });
});

describe('POST /api/logout', () => {
  it('responds 200 and clears auth cookies', async () => {
    await registerUser();
    const cookies = await loginUser();

    const res = await request(app).post('/api/logout').set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out');

    // Subsequent session request should be unauthorised
    const sessionRes = await request(app).get('/api/session'); // no cookies
    expect(sessionRes.status).toBe(401);
  });
});
