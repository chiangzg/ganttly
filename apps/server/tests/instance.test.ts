import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instanceDiscoverySchema } from '@ganttly/api-contract';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/bootstrap';
import { buildDiscovery } from '../src/routes/instance';
import { buildTestConfig } from './helpers';

describe('buildDiscovery', () => {
  it('produces a contract-valid descriptor', () => {
    const discovery = buildDiscovery(buildTestConfig());
    expect(instanceDiscoverySchema.safeParse(discovery).success).toBe(true);
  });

  it('derives mcp/events URLs from PUBLIC_BASE_URL and trims trailing slash', () => {
    const d = buildDiscovery(buildTestConfig({ PUBLIC_BASE_URL: 'http://localhost:3001/' }));
    expect(d.baseUrl).toBe('http://localhost:3001');
    expect(d.apiBaseUrl).toBe('http://localhost:3001/api/v1');
    expect(d.mcp.url).toBe('http://localhost:3001/mcp');
    expect(d.events.url).toBe('http://localhost:3001/api/v1/events');
  });

  it('advertises the mcp/sse features as wired (PR5/PR6)', () => {
    const d = buildDiscovery(buildTestConfig());
    expect(d.features.mcp).toBe(true);
    expect(d.features.sse).toBe(true);
    expect(d.features.projectImport).toBe(true);
    expect(d.auth.providers).toEqual(['github']);
  });

  it('advertises devLogin only for AUTH_MODE=dev', () => {
    expect(buildDiscovery(buildTestConfig()).auth.devLogin).toBe(true);
    expect(
      buildDiscovery(
        buildTestConfig({
          AUTH_MODE: 'github',
          GITHUB_OAUTH_CLIENT_ID: 'client-id',
          GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
          SESSION_SECRET: 'x'.repeat(32),
          TOKEN_PEPPER: 'x'.repeat(32),
        }),
      ).auth.devLogin,
    ).toBe(false);
  });
});

describe('GET /.well-known/ganttly-instance', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(buildTestConfig(), { registerDatabase: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with a contract-valid descriptor', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/ganttly-instance' });
    expect(res.statusCode).toBe(200);
    const parsed = instanceDiscoverySchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.instanceId).toBe('inst_test');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('discovery CORS', () => {
  // buildTestConfig allowlists only http://localhost:5173 — a foreign origin
  // must still read the public descriptor, while /api/v1 keeps the strict
  // credentialed allowlist.
  it('reflects any Origin on the discovery endpoint even when the allowlist misses', async () => {
    const app = await buildServer(buildTestConfig(), { registerDatabase: false });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/ganttly-instance',
        headers: { origin: 'https://web.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://web.example.com');
      // Public metadata read — no credentialed CORS on this endpoint.
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('answers CORS preflight on the discovery endpoint', async () => {
    const app = await buildServer(buildTestConfig(), { registerDatabase: false });
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/.well-known/ganttly-instance',
        headers: {
          origin: 'https://web.example.com',
          'access-control-request-method': 'GET',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://web.example.com');
      expect(String(res.headers['access-control-allow-methods'])).toMatch(/GET/);
    } finally {
      await app.close();
    }
  });

  it('keeps the credentialed allowlist policy for /api/v1 when ALLOWED_WEB_ORIGINS is empty', async () => {
    const app = await buildServer(buildTestConfig({ ALLOWED_WEB_ORIGINS: '' }), {
      registerDatabase: false,
    });
    try {
      const discovery = await app.inject({
        method: 'GET',
        url: '/.well-known/ganttly-instance',
        headers: { origin: 'https://web.example.com' },
      });
      expect(discovery.statusCode).toBe(200);
      expect(discovery.headers['access-control-allow-origin']).toBe('https://web.example.com');

      const api = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { origin: 'https://web.example.com' },
      });
      expect(api.statusCode).toBe(401);
      expect(api.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
