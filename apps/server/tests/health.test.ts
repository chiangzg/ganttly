import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/bootstrap';
import { buildTestConfig } from './helpers';

describe('health routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // No database pool: /health/live must still work; /health/ready degrades.
    app = await buildServer(buildTestConfig(), { registerDatabase: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health/live returns 200 and carries x-request-id', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('/health/ready reports 503 when no database is attached', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', checks: { database: 'unavailable' } });
  });
});
