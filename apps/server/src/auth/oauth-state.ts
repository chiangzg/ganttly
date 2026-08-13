/**
 * OAuth `state` CSRF protection (spec §13).
 *
 * A high-entropy random `state` is sent to GitHub *and* stored in a short-lived
 * HttpOnly, SameSite=Lax cookie. On callback we compare the query `state` to
 * the cookie value. The state itself is 128 bits of randomness, so it cannot be
 * predicted; SameSite=Lax prevents a cross-origin attacker from setting a
 * cookie on our domain, so they cannot forge a matching (cookie, code) pair for
 * a victim. The cookie therefore does not need to be signed.
 *
 * Cookie helpers read/write via the `@fastify/cookie` decorators that
 * `@fastify/secure-session` registers transitively.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const OAUTH_STATE_COOKIE = 'ganttly_oauth_state';
const STATE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes

/** Generate a fresh unguessable state token (128 bits). */
export function newState(): string {
  return randomBytes(16).toString('hex');
}

export interface StateCookieOptions {
  secure: boolean;
}

/** Set the state cookie alongside the redirect to GitHub. */
export function setStateCookie(
  reply: FastifyReply,
  state: string,
  options: StateCookieOptions,
): void {
  void reply.setCookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_MAX_AGE_SECONDS,
  });
}

/**
 * Verify the query `state` against the cookie. Returns true only when the
 * cookie is present and equals the query value.
 */
export function verifyStateCookie(request: FastifyRequest, queryState: string): boolean {
  const stored = request.cookies[OAUTH_STATE_COOKIE];
  return typeof stored === 'string' && stored.length > 0 && stored === queryState;
}

/** Clear the state cookie once the flow completes (success or failure). */
export function clearStateCookie(reply: FastifyReply): void {
  void reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
}
