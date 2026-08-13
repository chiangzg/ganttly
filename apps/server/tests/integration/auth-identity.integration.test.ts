import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildIntegrationServer, devLogin } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('auth + identity integration', () => {
  let app: FastifyInstance;
  let session: { cookie: string; userId: string; workspaceId: string };

  beforeAll(async () => {
    app = await buildIntegrationServer();
    session = await devLogin(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('provisions a dev user + personal workspace on first dev-session', () => {
    expect(session.userId).toMatch(/^usr_/);
    expect(session.workspaceId).toMatch(/^ws_/);
  });

  it('GET /me returns the authenticated user profile', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `ganttly_session=${session.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(session.userId);
    expect(body.provider).toBe('dev');
  });

  it('GET /workspaces lists the personal workspace with owner role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces',
      headers: { cookie: `ganttly_session=${session.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const ws = res.json().workspaces as Array<{ id: string; role: string; kind: string }>;
    expect(ws.find((w) => w.id === session.workspaceId)?.role).toBe('owner');
  });

  it('rejects unauthenticated /me with 401 AUTH_REQUIRED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('logout clears the session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `ganttly_session=${session.cookie}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
