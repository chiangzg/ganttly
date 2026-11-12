/**
 * CORS preflight must mirror the full REST surface. @fastify/cors defaults to
 * GET/HEAD/POST only — without an explicit `methods` option every cross-origin
 * PUT (document save / rename) and DELETE fails with "Failed to fetch" right
 * after a seemingly-valid 204 preflight, because the browser checks
 * Access-Control-Allow-Methods before dispatching the actual request.
 *
 * Non-DB server so these run in the plain unit suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/bootstrap';
import { buildTestConfig } from '../helpers';

const WEB_ORIGIN = 'http://localhost:5173';

describe('cors preflight', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(buildTestConfig(), { registerDatabase: false });
  });

  afterAll(async () => {
    await app.close();
  });

  function preflight(
    method: string,
    url: string,
    extraHeaders: string,
  ): Promise<{
    status: number;
    allowOrigin: string | undefined;
    allowMethods: string | undefined;
    allowCredentials: string | undefined;
  }> {
    return (async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url,
        headers: {
          origin: WEB_ORIGIN,
          'access-control-request-method': method,
          'access-control-request-headers': extraHeaders,
        },
      });
      return {
        status: res.statusCode,
        allowOrigin: res.headers['access-control-allow-origin'] as string | undefined,
        allowMethods: res.headers['access-control-allow-methods'] as string | undefined,
        allowCredentials: res.headers['access-control-allow-credentials'] as string | undefined,
      };
    })();
  }

  it('advertises PUT for the document save / rename preflight', async () => {
    const res = await preflight('PUT', '/api/v1/workspaces/ws_x/projects/prj_x', 'if-match');
    expect(res.status).toBe(204);
    expect(res.allowOrigin).toBe(WEB_ORIGIN);
    expect(res.allowMethods).toContain('PUT');
    expect(res.allowCredentials).toBe('true');
  });

  it('advertises DELETE for the permanent-delete preflight', async () => {
    const res = await preflight('DELETE', '/api/v1/workspaces/ws_x/projects/prj_x', '');
    expect(res.status).toBe(204);
    expect(res.allowMethods).toContain('DELETE');
  });

  it('still allows simple GET cross-origin requests', async () => {
    const res = await preflight('GET', '/api/v1/workspaces/ws_x/projects', '');
    expect(res.status).toBe(204);
    expect(res.allowMethods).toContain('GET');
  });
});
