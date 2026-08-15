/**
 * Shared error-handler semantics (spec §9.1): Fastify-level client errors must
 * keep their 4xx class and carry the ApiErrorResponse envelope instead of
 * collapsing into a generic 500, and the generic 500 must use the contract
 * shape too. Non-DB server so these run in the plain unit suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/bootstrap';
import { buildTestConfig } from '../helpers';

describe('shared error handler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Small body limit so the 413 case does not need a 10 MiB payload.
    app = await buildServer(buildTestConfig({ MAX_PROJECT_BYTES: '2048' }), {
      registerDatabase: false,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps a malformed JSON body onto VALIDATION_FAILED (422), not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/health/live',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.requestId).toBeTruthy();
  });

  it('maps an oversized body onto LIMIT_EXCEEDED (413), not 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/health/live',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(4096) }),
    });
    expect(res.statusCode).toBe(413);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('LIMIT_EXCEEDED');
  });
});
