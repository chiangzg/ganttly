/**
 * PAT management integration tests (spec §8.3). Requires TEST_DATABASE_URL;
 * self-skips otherwise so the unit suite stays green without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type * as inject from 'light-my-request';
import { createEmptyFile } from '@ganttly/schema';
import { DEV_TOKEN_PEPPER } from '../../src/config';
import { resolvePatPrincipal } from '../../src/auth/pat';
import { personalAccessTokens } from '../../src/db/schema';
import { buildIntegrationServer, devLogin, type DevSession } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('PAT management integration', () => {
  let app: FastifyInstance;
  let session: DevSession;

  beforeAll(async () => {
    app = await buildIntegrationServer();
    await app.db.delete(personalAccessTokens);
    session = await devLogin(app);
  });
  afterAll(async () => {
    await app.close();
  });

  async function authed(opts: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    payload?: unknown;
  }): Promise<inject.Response> {
    const options: inject.InjectOptions = {
      method: opts.method,
      url: opts.url,
      headers: { cookie: `ganttly_session=${session.cookie}` },
    };
    if (opts.payload !== undefined) options.payload = opts.payload as inject.InjectPayload;
    return app.inject(options);
  }

  async function createPat(
    overrides: Record<string, unknown> = {},
  ): Promise<{ token: string; id: string }> {
    const res = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: { name: 'test token', scopes: ['task:write', 'project:read'], ...overrides },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; pat: { id: string } };
    return { token: body.token, id: body.pat.id };
  }

  it('rejects PAT management without a session (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/tokens' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a PAT and returns the plaintext token exactly once', async () => {
    const res = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: { name: 'CI bot', scopes: ['task:write'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      token: string;
      pat: { id: string; name: string; tokenPrefix: string; scopes: string[] };
    };
    expect(body.token.startsWith('pat_')).toBe(true);
    expect(body.pat.name).toBe('CI bot');
    expect(body.pat.scopes).toEqual(['task:write']);
    expect(body.pat.tokenPrefix.startsWith('pat_')).toBe(true);
    // The prefix is a strict prefix of the token (recognition aid).
    expect(body.token.startsWith(body.pat.tokenPrefix)).toBe(true);
  });

  it("lists a user's tokens without secrets", async () => {
    await createPat({ name: 'list-check' });
    const res = await authed({ method: 'GET', url: '/api/v1/me/tokens' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tokens: Array<{ name: string; tokenPrefix: string }> };
    expect(body.tokens.some((t) => t.name === 'list-check')).toBe(true);
    // No token field ever appears in list output.
    expect(JSON.stringify(body)).not.toContain('"token"');
  });

  it('resolves a valid PAT to a pat principal', async () => {
    const { token } = await createPat({ name: 'resolve-check' });
    const principal = await resolvePatPrincipal(app.db, `Bearer ${token}`, DEV_TOKEN_PEPPER);
    expect(principal).not.toBeNull();
    expect(principal?.actorType).toBe('pat');
    expect(principal?.userId).toBe(session.userId);
    expect(principal?.scopes).toContain('task:write');
  });

  it('returns null for a revoked token', async () => {
    const { token, id } = await createPat({ name: 'revoke-check' });
    const res = await authed({ method: 'DELETE', url: `/api/v1/me/tokens/${id}` });
    expect(res.statusCode).toBe(204);
    const principal = await resolvePatPrincipal(app.db, `Bearer ${token}`, DEV_TOKEN_PEPPER);
    expect(principal).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const { token } = await createPat({
      name: 'expired-check',
      expiresAt: '2000-01-01T00:00:00Z',
    });
    const principal = await resolvePatPrincipal(app.db, `Bearer ${token}`, DEV_TOKEN_PEPPER);
    expect(principal).toBeNull();
  });

  it('returns null for a bogus bearer header', async () => {
    const principal = await resolvePatPrincipal(
      app.db,
      'Bearer pat_not-a-real-token',
      DEV_TOKEN_PEPPER,
    );
    expect(principal).toBeNull();
  });

  it('forbids revoking another user token (404, no existence leak)', async () => {
    const { id } = await createPat({ name: 'cross-user' });
    const other = await devLogin(app, 'dev-user-revoke-other'); // a different user
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${id}`,
      headers: { cookie: `ganttly_session=${other.cookie}` },
    });
    expect(res.statusCode).toBe(404);
    // The original owner can still resolve their token.
    const listed = await authed({ method: 'GET', url: '/api/v1/me/tokens' });
    const body = listed.json() as { tokens: { id: string }[] };
    expect(body.tokens.some((t) => t.id === id)).toBe(true);
  });

  it('rejects an invalid scope value at creation (422)', async () => {
    const res = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: { name: 'bad', scopes: ['bogus:scope'] },
    });
    expect(res.statusCode).toBe(422);
  });

  // --- narrowing validation (spec §8.3: may only narrow to own accesses) ----
  it('creates a PAT narrowed to the own workspace', async () => {
    const res = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: {
        name: 'narrow-ws',
        scopes: ['task:write'],
        workspaceId: session.workspaceId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pat: { workspaceId?: string } };
    expect(body.pat.workspaceId).toBe(session.workspaceId);
  });

  it('rejects narrowing to a workspace the caller is not a member of (404)', async () => {
    const other = await devLogin(app, 'dev-user-foreign-ws'); // different user/workspace
    const res = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: {
        name: 'narrow-foreign',
        scopes: ['task:write'],
        workspaceId: other.workspaceId,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects narrowing to an unknown project (404)', async () => {
    const res = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: {
        name: 'narrow-missing',
        scopes: ['project:read'],
        workspaceId: session.workspaceId,
        projectId: 'prj_does-not-exist',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a PAT narrowed to an own project, rejecting foreign ones (404)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${session.workspaceId}/projects`,
      headers: {
        cookie: `ganttly_session=${session.cookie}`,
        'idempotency-key': 'pat-narrow-own',
      },
      payload: { file: createEmptyFile({ name: 'PAT narrowing target' }) },
    });
    expect(create.statusCode).toBe(201);
    const projectId = (create.json() as { summary: { id: string } }).summary.id;

    const ok = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: {
        name: 'narrow-prj',
        scopes: ['project:read'],
        workspaceId: session.workspaceId,
        projectId,
      },
    });
    expect(ok.statusCode).toBe(200);

    // Another user's project id must not be acceptable.
    const other = await devLogin(app, 'dev-user-foreign-prj');
    const foreignCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${other.workspaceId}/projects`,
      headers: {
        cookie: `ganttly_session=${other.cookie}`,
        'idempotency-key': 'pat-narrow-foreign',
      },
      payload: { file: createEmptyFile({ name: 'Foreign' }) },
    });
    const foreignId = (foreignCreate.json() as { summary: { id: string } }).summary.id;
    const rejected = await authed({
      method: 'POST',
      url: '/api/v1/me/tokens',
      payload: {
        name: 'narrow-foreign-prj',
        scopes: ['project:read'],
        workspaceId: session.workspaceId,
        projectId: foreignId,
      },
    });
    expect(rejected.statusCode).toBe(404);
  });
});
