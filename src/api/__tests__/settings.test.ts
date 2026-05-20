import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB,
  clearDB,
  teardownTestDB,
  registerUser,
  loginUser,
  fetchCsrf,
} from './helpers';

// Mock the external Knuspr API calls so tests are self-contained
vi.mock('../../lib/knuspr-auth', () => ({
  loginToKnuspr: vi.fn().mockResolvedValue({ session: 'mock-session', userId: '12345' }),
}));

vi.mock('../../lib/order-importer', () => ({
  importOrders: vi.fn().mockResolvedValue({ importedCount: 5 }),
}));

beforeAll(setupTestDB);
afterAll(teardownTestDB);

describe('Settings / integrations endpoints', () => {
  let cookies: string;

  beforeEach(async () => {
    await clearDB();
    await registerUser();
    cookies = await loginUser();
  });

  describe('GET /api/settings/integrations', () => {
    it('returns an empty list when no integrations are connected', async () => {
      const res = await request(app)
        .get('/api/settings/integrations')
        .set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 401 when not authenticated', async () => {
      expect(
        (await request(app).get('/api/settings/integrations')).status
      ).toBe(401);
    });
  });

  describe('POST /api/settings/integrations/knuspr', () => {
    it('connects Knuspr and returns 200', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
      const combinedCookies = [cookies, ...csrfCookies].join('; ');

      const res = await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', combinedCookies)
        .set('x-csrf-token', token)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Knuspr connected successfully');
    });

    it('persists the integration so it appears in the list', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
      const combinedCookies = [cookies, ...csrfCookies].join('; ');

      await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', combinedCookies)
        .set('x-csrf-token', token)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      const listRes = await request(app)
        .get('/api/settings/integrations')
        .set('Cookie', cookies);

      expect(listRes.body).toHaveLength(1);
      expect(listRes.body[0].provider).toBe('knuspr');
      expect(listRes.body[0].encryptedCredentials).toBeUndefined(); // sensitive field excluded
    });

    it('returns 400 when email or password is missing', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
      const combinedCookies = [cookies, ...csrfCookies].join('; ');

      const res = await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', combinedCookies)
        .set('x-csrf-token', token)
        .send({ email: 'user@knuspr.de' }); // missing password

      expect(res.status).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf();
      const res = await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', csrfCookies)
        .set('x-csrf-token', token)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/settings/integrations/knuspr', () => {
    it('disconnects Knuspr and removes it from the list', async () => {
      const { token: connectToken, cookies: connectCsrfCookies } = await fetchCsrf(cookies);
      const connectCookies = [cookies, ...connectCsrfCookies].join('; ');

      // Connect first
      await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', connectCookies)
        .set('x-csrf-token', connectToken)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      const { token: deleteToken, cookies: deleteCsrfCookies } = await fetchCsrf(cookies);
      const deleteCombinedCookies = [cookies, ...deleteCsrfCookies].join('; ');

      const deleteRes = await request(app)
        .delete('/api/settings/integrations/knuspr')
        .set('Cookie', deleteCombinedCookies)
        .set('x-csrf-token', deleteToken);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.message).toBe('Knuspr disconnected');

      const listRes = await request(app)
        .get('/api/settings/integrations')
        .set('Cookie', cookies);
      expect(listRes.body).toEqual([]);
    });

    it('returns 200 even when Knuspr was not connected', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
      const combinedCookies = [cookies, ...csrfCookies].join('; ');

      const res = await request(app)
        .delete('/api/settings/integrations/knuspr')
        .set('Cookie', combinedCookies)
        .set('x-csrf-token', token);

      expect(res.status).toBe(200);
    });

    it('returns 401 when not authenticated', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf();
      expect(
        (await request(app)
          .delete('/api/settings/integrations/knuspr')
          .set('Cookie', csrfCookies)
          .set('x-csrf-token', token)).status
      ).toBe(401);
    });
  });

  describe('POST /api/settings/integrations/knuspr/sync', () => {
    it('syncs orders and returns the imported count', async () => {
      const { token: connectToken, cookies: connectCsrfCookies } = await fetchCsrf(cookies);
      const connectCookies = [cookies, ...connectCsrfCookies].join('; ');

      // Connect first
      await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', connectCookies)
        .set('x-csrf-token', connectToken)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      const { token: syncToken, cookies: syncCsrfCookies } = await fetchCsrf(cookies);
      const syncCookies = [cookies, ...syncCsrfCookies].join('; ');

      const res = await request(app)
        .post('/api/settings/integrations/knuspr/sync')
        .set('Cookie', syncCookies)
        .set('x-csrf-token', syncToken);

      expect(res.status).toBe(200);
      expect(res.body.importedCount).toBe(5);
    });

    it('returns 404 when Knuspr is not connected', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf(cookies);
      const combinedCookies = [cookies, ...csrfCookies].join('; ');

      const res = await request(app)
        .post('/api/settings/integrations/knuspr/sync')
        .set('Cookie', combinedCookies)
        .set('x-csrf-token', token);

      expect(res.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const { token, cookies: csrfCookies } = await fetchCsrf();
      expect(
        (await request(app)
          .post('/api/settings/integrations/knuspr/sync')
          .set('Cookie', csrfCookies)
          .set('x-csrf-token', token)).status
      ).toBe(401);
    });
  });
});
