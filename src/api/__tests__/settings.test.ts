import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import {
  setupTestDB,
  clearDB,
  teardownTestDB,
  registerUser,
  loginUser,
} from './helpers';

// Mock the external Knuspr API calls so tests are self-contained
vi.mock('../../lib/knuspr-auth', () => ({
  loginToKnuspr: vi.fn().mockResolvedValue({ sessionCookie: 'mock-session' }),
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
      const res = await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', cookies)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Knuspr connected successfully');
    });

    it('persists the integration so it appears in the list', async () => {
      await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', cookies)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      const listRes = await request(app)
        .get('/api/settings/integrations')
        .set('Cookie', cookies);

      expect(listRes.body).toHaveLength(1);
      expect(listRes.body[0].provider).toBe('knuspr');
      expect(listRes.body[0].encryptedCredentials).toBeUndefined(); // sensitive field excluded
    });

    it('returns 400 when email or password is missing', async () => {
      const res = await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', cookies)
        .send({ email: 'user@knuspr.de' }); // missing password

      expect(res.status).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/settings/integrations/knuspr')
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/settings/integrations/knuspr', () => {
    it('disconnects Knuspr and removes it from the list', async () => {
      // Connect first
      await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', cookies)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      const deleteRes = await request(app)
        .delete('/api/settings/integrations/knuspr')
        .set('Cookie', cookies);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.message).toBe('Knuspr disconnected');

      const listRes = await request(app)
        .get('/api/settings/integrations')
        .set('Cookie', cookies);
      expect(listRes.body).toEqual([]);
    });

    it('returns 200 even when Knuspr was not connected', async () => {
      const res = await request(app)
        .delete('/api/settings/integrations/knuspr')
        .set('Cookie', cookies);

      expect(res.status).toBe(200);
    });

    it('returns 401 when not authenticated', async () => {
      expect(
        (await request(app).delete('/api/settings/integrations/knuspr')).status
      ).toBe(401);
    });
  });

  describe('POST /api/settings/integrations/knuspr/sync', () => {
    it('syncs orders and returns the imported count', async () => {
      // Connect first
      await request(app)
        .post('/api/settings/integrations/knuspr')
        .set('Cookie', cookies)
        .send({ email: 'user@knuspr.de', password: 'knusprpass' });

      const res = await request(app)
        .post('/api/settings/integrations/knuspr/sync')
        .set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body.importedCount).toBe(5);
    });

    it('returns 404 when Knuspr is not connected', async () => {
      const res = await request(app)
        .post('/api/settings/integrations/knuspr/sync')
        .set('Cookie', cookies);

      expect(res.status).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      expect(
        (await request(app).post('/api/settings/integrations/knuspr/sync')).status
      ).toBe(401);
    });
  });
});
