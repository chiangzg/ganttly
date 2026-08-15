import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/bootstrap';
import { buildTestConfig } from '../helpers';

/**
 * Same-origin static hosting (spec §14.2): the server serves the built Web
 * bundle and falls back to the SPA shell for client-side routes, while API
 * prefixes keep returning JSON errors.
 */
describe('web static plugin', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ganttly-web-'));
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root">SPA</div>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');

    app = await buildServer(buildTestConfig({ WEB_DIST_DIR: root }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves index.html at / with no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA');
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('serves a hashed asset with a long cache max-age', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
    // index.html is the only no-cache resource; everything else is long-lived.
    expect(res.headers['cache-control']).not.toBe('no-cache, no-store, must-revalidate');
  });

  it('falls back to the SPA shell for a deep client-side route', async () => {
    const res = await app.inject({ method: 'GET', url: '/instances/x/workspaces/y/projects/z' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SPA');
  });

  it('returns a JSON ApiErrorResponse for unknown API routes (never the SPA shell)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/no-such-endpoint' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    // Critical: an API client must never receive HTML.
    expect(res.body).not.toContain('SPA');
  });

  it('keeps /health/live working (not shadowed by static)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns JSON for a non-GET on an unknown path', async () => {
    const res = await app.inject({ method: 'POST', url: '/random' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
