import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

// The limiters are off in every other test file. This file turns them on before
// the first request, because the point here is the limit itself.
process.env.RATE_LIMITS = 'on';

import { app } from '../app';
import { setupTestDB, clearDB, teardownTestDB, registerUser, loginUser, fetchCsrf } from './helpers';

beforeAll(setupTestDB);
afterAll(teardownTestDB);

beforeEach(clearDB);

describe('rate limits', () => {
  it('lets a normal browsing session through', async () => {
    await registerUser();
    const cookies = await loginUser();

    // The merged shell reads several endpoints per page; 60 reads is a few
    // minutes of use, not abuse.
    for (let index = 0; index < 60; index += 1) {
      const res = await request(app).get('/api/location').set('Cookie', cookies);
      expect(res.status).toBe(200);
    }
  });

  it('still limits the login endpoint', async () => {
    await registerUser();
    const { token, cookies } = await fetchCsrf();

    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const res = await request(app)
        .post('/api/login')
        .set('Cookie', cookies.join('; '))
        .set('x-csrf-token', token)
        .send({ email: 'nobody@example.com', password: 'wrong-password' });
      statuses.push(res.status);
    }

    // The bucket is shared with the registration above, so assert the shape of
    // the limit rather than an exact index: credentials are checked first, and
    // the door closes well before the general budget would.
    const firstLimited = statuses.indexOf(429);
    expect(statuses).toContain(401);
    expect(firstLimited).toBeGreaterThan(0);
    expect(firstLimited).toBeLessThanOrEqual(10);
  });
});
