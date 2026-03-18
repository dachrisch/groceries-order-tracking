import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser } from './helpers';

beforeAll(setupTestDB);
beforeEach(clearDB);
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
