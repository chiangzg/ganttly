/**
 * Auth plugin (spec §3.2) — wires the stateless session cookie and resolves
 * each request's {@link AuthPrincipal}.
 *
 * Registers `@fastify/secure-session` (which transitively registers
 * `@fastify/cookie`, used for the OAuth state cookie) and decorates every
 * request with `principal` — `null` when unauthenticated. Routes gate on
 * `request.principal` rather than re-parsing the cookie themselves.
 */
import fp from 'fastify-plugin';
import secureSession from '@fastify/secure-session';
import type { FastifyPluginCallback } from 'fastify';
import { type AuthPrincipal, webPrincipal } from '../auth/principal';
import {
  DEFAULT_SESSION_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  deriveSessionKey,
} from '../auth/sessions';

export interface AuthPluginOptions {
  sessionSecret: string;
  /** Set the Secure flag on cookies; true in production. */
  secureCookies: boolean;
  sessionTtlSeconds?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthPrincipal | null;
  }
}

const authPlugin: FastifyPluginCallback<AuthPluginOptions> = (app, options) => {
  app.register(secureSession, {
    key: deriveSessionKey(options.sessionSecret),
    sessionName: 'session',
    cookieName: SESSION_COOKIE_NAME,
    cookie: {
      path: '/',
      httpOnly: true,
      secure: options.secureCookies,
      sameSite: 'lax',
    },
    expiry: options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
  });

  // Resolve the principal once per request. secure-session lazily decrypts the
  // cookie on first `.get()`, so no ordering dependency on its own hooks.
  app.addHook('onRequest', async (request) => {
    const userId = request.session.get('userId');
    request.principal = userId ? webPrincipal(userId) : null;
  });
};

export default fp(authPlugin, { name: 'auth' });
