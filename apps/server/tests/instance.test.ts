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
