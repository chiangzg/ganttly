/**
 * OIDC login callback (integration) — requires TEST_DATABASE_URL.
 *
 * Drives the full authorization-code round trip with a fake
 * {@link OidcOAuthDeps}: the start endpoint mints a state cookie, the callback
 * exchanges the code, provisions a user + personal workspace keyed by the
 * issuer URL + `sub`, and sets the session. A second login for the same
 * identity reuses the user row (upsert semantics).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { oidcProviderId, type OidcOAuthDeps, type OidcUser } from '../../src/auth/oidc';
import { buildServer } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { users } from '../../src/db/schema';
import { extractCookie, testDatabaseUrl } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

const ISSUER = 'https://auth.example.com/application/o/ganttly/';
const PROVIDER = oidcProviderId(ISSUER);

function fakeDeps(usersBySub: Map<string, OidcUser>): OidcOAuthDeps {
  return {
    discoverEndpoints: async () => ({
      authorizationEndpoint: 'https://auth.example.com/application/o/authorize/',
      tokenEndpoint: 'https://auth.example.com/application/o/token/',
      userinfoEndpoint: 'https://auth.example.com/application/o/userinfo/',
    }),
    exchangeCode: async (code) => code,
    fetchUser: async (token) => {
      const user = usersBySub.get(token);
      if (!user) throw new Error(`unknown token ${token}`);
      return user;
    },
  };
}

const ALICE: OidcUser = {
  sub: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
  name: 'Alice',
  preferred_username: 'alice',
  email: 'alice@example.com',
};

describe.skipIf(!dbUrl)('oidc login (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(
      loadConfig({
        NODE_ENV: 'development',
        LOG_LEVEL: 'fatal',
        DATABASE_URL: testDatabaseUrl(),
        PUBLIC_BASE_URL: 'http://localhost:3001',
        WEB_APP_URL: 'http://localhost:5173',
        GANTTLY_INSTANCE_ID: 'inst_test',
        GANTTLY_INSTANCE_NAME: 'ganttly Test',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER_URL: ISSUER,
        OIDC_CLIENT_ID: 'cid',
        OIDC_CLIENT_SECRET: 'secret',
        SESSION_SECRET: 'a'.repeat(48),
        TOKEN_PEPPER: 'b'.repeat(48),
        ALLOWED_WEB_ORIGINS: 'http://localhost:5173',
      }),
      { oidcDeps: fakeDeps(new Map([[ALICE.sub, ALICE]])) },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** One full OIDC web-flow round trip as the given `sub`. */
  async function callbackAs(sub: string) {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location ?? '').searchParams.get('state') ?? '';
    const cookies = start.headers['set-cookie'] ?? [];
    const stateCookie = (Array.isArray(cookies) ? cookies : [cookies])
      .find((c) => c.startsWith('ganttly_oauth_state='))
      ?.split(';')[0];
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${encodeURIComponent(sub)}&state=${encodeURIComponent(state)}`,
      headers: stateCookie ? { cookie: stateCookie } : {},
    });
  }

  it('provisions the user + personal workspace and sets the session', async () => {
    const res = await callbackAs(ALICE.sub);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173');
    const sessionCookie = extractCookie(res.headers['set-cookie'], 'ganttly_session');
    expect(sessionCookie).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `ganttly_session=${sessionCookie}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().provider).toBe(PROVIDER);

    const rows = await app.db.select().from(users).where(eq(users.subject, ALICE.sub));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe(PROVIDER);
    expect(rows[0]!.email).toBe('alice@example.com');
    expect(rows[0]!.displayName).toBe('Alice');
  });

  it('reuses the same user row on a second login (upsert by provider+subject)', async () => {
    await callbackAs(ALICE.sub);
    const rows = await app.db.select().from(users).where(eq(users.subject, ALICE.sub));
    expect(rows).toHaveLength(1);
  });
});
