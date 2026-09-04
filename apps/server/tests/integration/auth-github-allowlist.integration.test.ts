/**
 * GitHub OAuth callback allowlist (integration) — requires TEST_DATABASE_URL.
 *
 * Drives the full callback flow with a fake {@link GitHubOAuthDeps}: a
 * whitelisted id provisions a user + personal workspace and sets the session;
 * an id outside the list is rejected before any database row is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { GITHUB_PROVIDER, type GitHubOAuthDeps, type GitHubUser } from '../../src/auth/github';
import { buildServer } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { users } from '../../src/db/schema';
import { extractCookie, testDatabaseUrl } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

const WHITELISTED_ID = 1001;
const STRANGER_ID = 999999;

function githubUser(id: number): GitHubUser {
  return {
    id,
    login: `user${id}`,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    avatar_url: null,
  };
}

/** Token → user map: exchangeCode echoes the code, fetchUser resolves it. */
function fakeDeps(usersById: Map<number, GitHubUser>): GitHubOAuthDeps {
  return {
    exchangeCode: async (code) => code,
    fetchUser: async (token) => {
      const user = usersById.get(Number(token));
      if (!user) throw new Error(`unknown token ${token}`);
      return user;
    },
  };
}

describe.skipIf(!dbUrl)('github callback allowlist (integration)', () => {
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
        AUTH_MODE: 'github',
        ALLOWED_WEB_ORIGINS: 'http://localhost:5173',
        GITHUB_OAUTH_CLIENT_ID: 'cid',
        GITHUB_OAUTH_CLIENT_SECRET: 'secret',
        SESSION_SECRET: 'a'.repeat(48),
        TOKEN_PEPPER: 'b'.repeat(48),
        ALLOWED_GITHUB_USER_IDS: String(WHITELISTED_ID),
      }),
      {
        githubDeps: fakeDeps(
          new Map([
            [WHITELISTED_ID, githubUser(WHITELISTED_ID)],
            [STRANGER_ID, githubUser(STRANGER_ID)],
          ]),
        ),
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** One full OAuth web-flow round trip as the given GitHub id. */
  async function callbackAs(id: number) {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/github' });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location ?? '').searchParams.get('state') ?? '';
    const cookies = start.headers['set-cookie'] ?? [];
    const stateCookie = (Array.isArray(cookies) ? cookies : [cookies])
      .find((c) => c.startsWith('ganttly_oauth_state='))
      ?.split(';')[0];
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=${id}&state=${encodeURIComponent(state)}`,
      headers: stateCookie ? { cookie: stateCookie } : {},
    });
  }

  it('admits a whitelisted id: provisions user + workspace and sets the session', async () => {
    const res = await callbackAs(WHITELISTED_ID);
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
    expect(me.json().provider).toBe(GITHUB_PROVIDER);

    const rows = await app.db
      .select()
      .from(users)
      .where(eq(users.subject, String(WHITELISTED_ID)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(`user${WHITELISTED_ID}@example.com`);
  });

  it('denies a non-whitelisted id before provisioning: no session, no user row', async () => {
    const res = await callbackAs(STRANGER_ID);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('login_error=not_allowed');
    expect(extractCookie(res.headers['set-cookie'], 'ganttly_session')).toBeUndefined();

    const rows = await app.db
      .select()
      .from(users)
      .where(eq(users.subject, String(STRANGER_ID)));
    expect(rows).toHaveLength(0);
  });
});
