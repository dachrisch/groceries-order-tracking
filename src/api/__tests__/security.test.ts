import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser } from './helpers';

// Mock getKnusprSession to avoid needing actual credentials
vi.mock('../../lib/knuspr-auth', async () => {
  const actual = await vi.importActual('../../lib/knuspr-auth') as Record<string, unknown>;
  return {
    ...actual,
    getKnusprSession: vi.fn().mockResolvedValue('fake-session-token'),
  };
});

describe('Security - SSRF Protection', () => {
  let cookies: string;

  beforeEach(async () => {
    await setupTestDB();
    await clearDB();
    await registerUser();
    cookies = await loginUser();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  it('returns 400 for invalid product ID format (SSRF attempt)', async () => {
    const invalidIds = [
      '../../etc/passwd',
      'google.com',
      '123;drop table users',
      '<script>alert(1)</script>',
      'with spaces',
    ];

    for (const id of invalidIds) {
      const res = await request(app)
        .get(`/api/products/${encodeURIComponent(id)}/price`)
        .set('Cookie', cookies);
      
      expect(res.status, `Failed for ID: ${id}`).toBe(400);
      expect(res.body.error).toBe('Invalid product ID format');
    }
  });

  it('allows valid product IDs', async () => {
    // We mock fetch globally to avoid actual network calls
    const globalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { price: 100 } }),
    } as Response);

    const validIds = ['12345', 'abc-def-123', 'PROD-123'];

    for (const id of validIds) {
      const res = await request(app)
        .get(`/api/products/${id}/price`)
        .set('Cookie', cookies);
      
      // It shouldn't be 400. It might be 200 if fetch succeeds.
      expect(res.status).not.toBe(400);
    }

    global.fetch = globalFetch;
  });
});

describe('Security - CSRF Protection', () => {
  let cookies: string;

  beforeEach(async () => {
    await setupTestDB();
    await clearDB();
    await registerUser();
    cookies = await loginUser();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  it('fails state-changing requests without CSRF token', async () => {
    const res = await request(app)
      .post('/api/cart/add')
      .set('x-test-enable-csrf', 'true')
      .set('Cookie', cookies)
      .send({ id: '123', quantity: 1 });
    
    expect(res.status).toBe(403);
  });

  it('allows state-changing requests with valid CSRF token', async () => {
    // 1. Get token
    const tokenRes = await request(app)
      .get('/api/csrf-token')
      .set('Cookie', cookies);
    
    const token = tokenRes.body.token;
    const resCookies = tokenRes.headers['set-cookie'] as string[];

    // 2. Perform request
    // Use only the JWT token from cookies and the fresh CSRF cookie
    const jwtCookie = cookies.split('; ').find(c => c.startsWith('token='));
    const combinedCookies = [jwtCookie, ...resCookies].join('; ');

    const res = await request(app)
      .post('/api/cart/add')
      .set('x-test-enable-csrf', 'true')
      .set('Cookie', combinedCookies)
      .set('x-csrf-token', token)
      .send({ id: '123', quantity: 1 });
    
    expect(res.status).not.toBe(403);
  });
});
