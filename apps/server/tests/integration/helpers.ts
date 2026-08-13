/**
 * Shared helpers for server integration tests (require TEST_DATABASE_URL).
 *
 * These build a real server against the test database and authenticate via the
 * dev-session bootstrap, so each test can issue cookie-authenticated requests
 * through Fastify `inject()`.
 */
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';

export function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ganttly_test'
  );
}

export async function buildIntegrationServer(): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: testDatabaseUrl(),
    PUBLIC_BASE_URL: 'http://localhost:3001',
    WEB_APP_URL: 'http://localhost:5173',
    GANTTLY_INSTANCE_ID: 'inst_test',
    GANTTLY_INSTANCE_NAME: 'ganttly Test',
    AUTH_MODE: 'dev',
    ALLOWED_WEB_ORIGINS: 'http://localhost:5173',
  });
  return buildServer(config);
}

/** Extract a cookie value from a Set-Cookie header (or array of them). */
export function extractCookie(
  setCookie: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!setCookie) return undefined;
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  const line = lines.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  return line.split(';')[0]!.slice(name.length + 1);
}

export interface DevSession {
  cookie: string;
  userId: string;
  workspaceId: string;
}

/** Authenticate via the dev-session endpoint and return the session cookie. */
export async function devLogin(app: FastifyInstance): Promise<DevSession> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/dev-session' });
  if (res.statusCode !== 200) {
    throw new Error(`dev-session failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json() as { userId: string; workspaceId: string };
  const cookie = extractCookie(res.headers['set-cookie'], 'ganttly_session');
  if (!cookie) throw new Error('dev-session did not set ganttly_session cookie');
  return { cookie, userId: body.userId, workspaceId: body.workspaceId };
}
