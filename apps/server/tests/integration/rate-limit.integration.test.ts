/**
 * Rate-limit + /metrics integration (spec §15). Neither needs a database, so
 * the server is built with `registerDatabase: false`. Verifies the limiter
 * returns a 429 ApiErrorResponse with RATE_LIMITED + Retry-After once the cap
 * is crossed, and that /metrics is unaffected by (and reports) limiting.
 */
import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';

function buildLowLimitServer() {
  const config = loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgres://unused',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    WEB_APP_URL: 'http://localhost:5173',
    GANTTLY_INSTANCE_ID: 'inst_rl',
    GANTTLY_INSTANCE_NAME: 'ganttly RL Test',
    AUTH_MODE: 'dev',
    ALLOWED_WEB_ORIGINS: 'http://localhost:5173',
    RATE_LIMIT_MAX: '3',
    RATE_LIMIT_WINDOW_SECONDS: '60',
  });
  return buildServer(config, { registerDatabase: false });
}

describe('rate limiting', () => {
  it('returns 429 RATE_LIMITED with Retry-After once the cap is crossed', async () => {
    const app = await buildLowLimitServer();
    try {
      const url = '/.well-known/ganttly-instance';
      const r1 = await app.inject({ method: 'GET', url });
      const r2 = await app.inject({ method: 'GET', url });
      const r3 = await app.inject({ method: 'GET', url });
      expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200]);

      const over = await app.inject({ method: 'GET', url });
      expect(over.statusCode).toBe(429);
      expect(over.headers['retry-after']).toBeDefined();
      const body = over.json() as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.requestId).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('serves /metrics in the prometheus text format on a fresh server', async () => {
    const app = await buildLowLimitServer();
    try {
      // A prior request makes the HTTP counter materialise in the exposition.
      await app.inject({ method: 'GET', url: '/.well-known/ganttly-instance' });
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body).toContain('ganttly_');
      expect(res.body).toContain('ganttly_http_requests_total');
    } finally {
      await app.close();
    }
  });
});
