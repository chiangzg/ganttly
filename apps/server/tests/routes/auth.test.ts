import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/bootstrap';
import type { GitHubOAuthDeps, GitHubUser } from '../../src/auth/github';
import { buildTestConfig } from '../helpers';

function githubModeConfig() {
  return buildTestConfig({
    AUTH_MODE: 'github',
    GITHUB_OAUTH_CLIENT_ID: 'cid',
    GITHUB_OAUTH_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 'a'.repeat(48),
    TOKEN_PEPPER: 'b'.repeat(48),
  });
}

describe('auth routes (no database)', () => {
  let devApp: FastifyInstance;
  let githubApp: FastifyInstance;

  beforeAll(async () => {
    devApp = await buildServer(buildTestConfig(), { registerDatabase: false });
    githubApp = await buildServer(githubModeConfig(), { registerDatabase: false });
  });

  afterAll(async () => {
    await Promise.all([devApp.close(), githubApp.close()]);
  });

  it('GET /api/v1/auth/github in dev mode redirects to web app with an error', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/api/v1/auth/github' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login_error=dev_mode_no_github');
  });

  it('GET /api/v1/auth/github in github mode redirects to GitHub and sets the state cookie', async () => {
    const res = await githubApp.inject({ method: 'GET', url: '/api/v1/auth/github' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location?.startsWith('https://github.com/login/oauth/authorize?')).toBe(
      true,
    );
    const location = res.headers.location ?? '';
    expect(new URL(location).searchParams.get('client_id')).toBe('cid');
    // State cookie is set, HttpOnly, SameSite=Lax.
    const cookies = res.headers['set-cookie'] ?? [];
    const stateCookie = (Array.isArray(cookies) ? cookies : [cookies]).find((c) =>
      c.startsWith('ganttly_oauth_state='),
    );
    expect(stateCookie).toBeTruthy();
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('SameSite=Lax');
  });

  it('GET /api/v1/auth/github/callback without a database redirects to the error url', async () => {
    const res = await devApp.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=x&state=y',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login_error=github_login_failed');
  });

  it('POST /api/v1/auth/logout clears the session and returns 204', async () => {
    const res = await devApp.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(204);
  });

  it('POST /api/v1/auth/dev-session returns 404 when AUTH_MODE is not dev', async () => {
    const res = await githubApp.inject({ method: 'POST', url: '/api/v1/auth/dev-session' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('POST /api/v1/auth/dev-session returns 503 when the database is not attached', async () => {
    const res = await devApp.inject({ method: 'POST', url: '/api/v1/auth/dev-session' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UNSUPPORTED_CLIENT');
  });
});

describe('auth routes — GitHub login allowlist (callback gate)', () => {
  const stranger: GitHubUser = {
    id: 999999,
    login: 'stranger',
    name: 'Stranger',
    email: 'stranger@example.com',
    avatar_url: null,
  };

  function fakeDeps(user: GitHubUser): GitHubOAuthDeps {
    return { exchangeCode: async () => 'tok', fetchUser: async () => user };
  }

  function allowlistConfig(userIds: string) {
    return buildTestConfig({
      AUTH_MODE: 'github',
      GITHUB_OAUTH_CLIENT_ID: 'cid',
      GITHUB_OAUTH_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'a'.repeat(48),
      TOKEN_PEPPER: 'b'.repeat(48),
      ALLOWED_GITHUB_USER_IDS: userIds,
    });
  }

  /**
   * One full OAuth web-flow round trip as the stranger: mint a state cookie
   * via the authorize entrypoint, then present it at the callback.
   */
  async function callbackAs(app: FastifyInstance) {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/github' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location ?? '').searchParams.get('state') ?? '';
    const cookies = start.headers['set-cookie'] ?? [];
    const stateCookie = (Array.isArray(cookies) ? cookies : [cookies])
      .find((c) => c.startsWith('ganttly_oauth_state='))
      ?.split(';')[0];
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: stateCookie ? { cookie: stateCookie } : {},
    });
  }

  it('denies a user outside the allowlist: redirect not_allowed, no session', async () => {
    // The db pool is registered (lazy — the denial path never queries) so the
    // callback reaches the allowlist gate instead of failing on
    // database_unavailable. Provisioning-level assertions live in the
    // integration suite.
    const app = await buildServer(allowlistConfig('1001'), { githubDeps: fakeDeps(stranger) });
    try {
      const res = await callbackAs(app);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('login_error=not_allowed');
      const set = res.headers['set-cookie'] ?? [];
      expect((Array.isArray(set) ? set : [set]).some((c) => c.startsWith('ganttly_session='))).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });
});
