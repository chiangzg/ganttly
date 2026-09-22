import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/bootstrap';
import type { OidcOAuthDeps, OidcUser } from '../../src/auth/oidc';
import { buildTestConfig } from '../helpers';

const OIDC_ENV = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER_URL: 'https://auth.example.com/application/o/ganttly/',
  OIDC_CLIENT_ID: 'cid',
  OIDC_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'a'.repeat(48),
  TOKEN_PEPPER: 'b'.repeat(48),
};

const FAKE_ENDPOINTS = {
  authorizationEndpoint: 'https://auth.example.com/application/o/authorize/',
  tokenEndpoint: 'https://auth.example.com/application/o/token/',
  userinfoEndpoint: 'https://auth.example.com/application/o/userinfo/',
};

function fakeOidcDeps(): OidcOAuthDeps {
  return {
    discoverEndpoints: async () => FAKE_ENDPOINTS,
    exchangeCode: async () => 'access-token',
    fetchUser: async (): Promise<OidcUser> => ({
      sub: 'oidc-sub-1',
      name: 'Alice',
      preferred_username: 'alice',
      email: 'alice@example.com',
    }),
  };
}

function stateCookieLine(setCookie: string | string[] | undefined): string | undefined {
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  return lines.find((c) => c?.startsWith('ganttly_oauth_state='));
}

describe('auth routes (no database)', () => {
  let devApp: FastifyInstance;
  let oidcApp: FastifyInstance;

  beforeAll(async () => {
    devApp = await buildServer(buildTestConfig(), { registerDatabase: false });
    oidcApp = await buildServer(buildTestConfig(OIDC_ENV), {
      registerDatabase: false,
      oidcDeps: fakeOidcDeps(),
    });
  });

  afterAll(async () => {
    await Promise.all([devApp.close(), oidcApp.close()]);
  });

  it('GET /api/v1/auth/oidc in dev mode redirects to web app with an error', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/api/v1/auth/oidc' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login_error=dev_mode_no_oidc');
  });

  it('GET /api/v1/auth/oidc redirects to the issuer and sets the state cookie', async () => {
    const res = await oidcApp.inject({ method: 'GET', url: '/api/v1/auth/oidc' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location?.startsWith(`${FAKE_ENDPOINTS.authorizationEndpoint}?`)).toBe(true);
    const location = new URL(res.headers.location ?? '');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('cid');
    expect(location.searchParams.get('scope')).toBe('openid profile email');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/api/v1/auth/oidc/callback',
    );
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    // State cookie is set, HttpOnly, SameSite=Lax.
    const stateCookie = stateCookieLine(res.headers['set-cookie']);
    expect(stateCookie).toBeTruthy();
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('SameSite=Lax');
  });

  it('GET /api/v1/auth/oidc bounces back with login_error when discovery fails', async () => {
    const failing: OidcOAuthDeps = {
      ...fakeOidcDeps(),
      discoverEndpoints: async () => {
        throw new Error('issuer unreachable');
      },
    };
    const app = await buildServer(buildTestConfig(OIDC_ENV), {
      registerDatabase: false,
      oidcDeps: failing,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('login_error=oidc_login_failed');
    } finally {
      await app.close();
    }
  });

  it('GET /api/v1/auth/oidc/callback without a database redirects to the error url', async () => {
    const res = await devApp.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/callback?code=x&state=y',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login_error=oidc_login_failed');
  });

  it('POST /api/v1/auth/logout clears the session and returns 204', async () => {
    const res = await devApp.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(204);
  });

  it('POST /api/v1/auth/dev-session returns 404 when AUTH_MODE is not dev', async () => {
    const res = await oidcApp.inject({ method: 'POST', url: '/api/v1/auth/dev-session' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('POST /api/v1/auth/dev-session returns 503 when the database is not attached', async () => {
    const res = await devApp.inject({ method: 'POST', url: '/api/v1/auth/dev-session' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UNSUPPORTED_CLIENT');
  });
});

describe('auth routes — OIDC callback (state gate)', () => {
  it('rejects a mismatched state: redirect to login_error, no session cookie', async () => {
    // The db pool is registered (lazy — this path never queries) so the
    // callback reaches the state check instead of failing on
    // database_unavailable. Provisioning-level assertions live in the
    // integration suite.
    const app = await buildServer(buildTestConfig(OIDC_ENV), { oidcDeps: fakeOidcDeps() });
    try {
      const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc' });
      expect(start.statusCode).toBe(302);
      const state = new URL(start.headers.location ?? '').searchParams.get('state') ?? '';
      const res = await app.inject({
        method: 'GET',
        // A state that never matches the cookie minted above.
        url: `/api/v1/auth/oidc/callback?code=abc&state=${encodeURIComponent(`ff${state.slice(2)}`)}`,
        headers: { cookie: stateCookieLine(start.headers['set-cookie'])?.split(';')[0] ?? '' },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('login_error=oidc_login_failed');
      const set = res.headers['set-cookie'] ?? [];
      expect((Array.isArray(set) ? set : [set]).some((c) => c.startsWith('ganttly_session='))).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });
});
