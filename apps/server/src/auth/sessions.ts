/**
 * Stateless session cookie (spec §8.2 / §0 decision: stateless encrypted
 * cookie, no server-side sessions table).
 *
 * Uses `@fastify/secure-session` (libsodium secret-key box). The session key
 * is derived deterministically from `SESSION_SECRET` so deployment only needs
 * the one secret. The cookie carries just the user id and provider — the token
 * is discarded right after the OAuth callback.
 */
import { createHash } from 'node:crypto';

/** Name of the session cookie. */
export const SESSION_COOKIE_NAME = 'ganttly_session';

/** Default session TTL: 7 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Derive a 32-byte libsodium secret-key-box key from `SESSION_SECRET` via
 * SHA-256. This avoids needing a separately managed key file or salt.
 */
export function deriveSessionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** Fields stored in the encrypted session cookie. */
export interface SessionPayload {
  userId: string;
  provider: string;
  loginAt: string;
}

// Type-safe access to the typed session via declaration merging. The fields
// are inlined (rather than `extends SessionPayload`) so the linter does not
// flag an empty interface; they mirror {@link SessionPayload}.
declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
    provider: string;
    loginAt: string;
  }
}
