/**
 * Personal Access Token (PAT) credentials (spec §8.3).
 *
 * PATs authenticate MCP tool calls via `Authorization: Bearer pat_…`. The
 * plaintext token is generated once, shown once, and never persisted: the
 * database keeps only a short recognition `prefix` and
 * `SHA-256(token + ':' + server pepper)`. Tokens are revocable and carry their
 * own scope list; their effective authority is that list intersected with the
 * holder's workspace role (enforced in `modules/access.ts`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { McpScope } from '@ganttly/api-contract';
import { type AuthPrincipal } from './principal';
import type { Db } from '../db/client';
import { personalAccessTokens } from '../db/schema';

/** Token literal prefix so logs/URLs self-describe the credential type. */
export const PAT_TOKEN_PREFIX = 'pat_';
/** Entropy budget: 32 random bytes (256 bit) encoded as base64url. */
const TOKEN_RANDOM_BYTES = 32;
/**
 * Length of the non-secret recognition prefix stored for display
 * (e.g. `pat_7Kp9Qz1a`). Long enough to tell tokens apart, far shorter than
 * the full credential.
 */
const PREFIX_DISPLAY_LENGTH = 12;

/** Generate a new PAT: returns the full plaintext token plus its display prefix. */
export function generatePatToken(): { token: string; prefix: string } {
  const secret = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
  const token = `${PAT_TOKEN_PREFIX}${secret}`;
  return { token, prefix: token.slice(0, PREFIX_DISPLAY_LENGTH) };
}

/** Deterministic hash: `SHA-256(token + ':' + pepper)` as lowercase hex. */
export function hashToken(token: string, pepper: string): string {
  return createHash('sha256').update(`${token}:${pepper}`).digest('hex');
}

/**
 * Parse a `Bearer pat_…` Authorization header and return the raw token, or
 * `null` when the header is absent or not a bearer token.
 */
export function extractBearerToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match && match[1] ? match[1].trim() : null;
}

/** Whether `prefix` could plausibly be the stored prefix of `token`. */
export function prefixMatches(token: string, prefix: string): boolean {
  const actual = token.slice(0, PREFIX_DISPLAY_LENGTH);
  if (actual.length !== prefix.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(prefix));
  } catch {
    return false;
  }
}

/** A PAT row projected onto the data the principal builder needs. */
interface PatRecord {
  id: string;
  userId: string;
  scopes: readonly string[];
  workspaceId: string | null;
  projectId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Resolve an `Authorization` header to a PAT-backed {@link AuthPrincipal}.
 *
 * Returns `null` (never throws) for any failure — missing/ malformed header,
 * unknown token, revoked or expired credential — so the caller decides whether
 * to emit a 401. On success the token's `last_used_at` is stamped. The
 * plaintext token is never logged.
 */
export async function resolvePatPrincipal(
  client: Db,
  authorization: string | undefined | null,
  pepper: string,
): Promise<AuthPrincipal | null> {
  const token = extractBearerToken(authorization);
  if (!token) return null;

  const hash = hashToken(token, pepper);
  const rows = await client
    .select({
      id: personalAccessTokens.id,
      userId: personalAccessTokens.userId,
      scopes: personalAccessTokens.scopes,
      workspaceId: personalAccessTokens.workspaceId,
      projectId: personalAccessTokens.projectId,
      expiresAt: personalAccessTokens.expiresAt,
      revokedAt: personalAccessTokens.revokedAt,
    })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.tokenHash, hash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const record = row as PatRecord;

  const now = new Date();
  if (record.revokedAt !== null) return null;
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) return null;

  // Stamp last-used out-of-band; a failure here must not block the call.
  await client
    .update(personalAccessTokens)
    .set({ lastUsedAt: now })
    .where(eq(personalAccessTokens.id, record.id))
    .catch(() => undefined);

  const principal: AuthPrincipal = {
    actorType: 'pat',
    actorId: record.id,
    userId: record.userId,
    scopes: record.scopes as readonly McpScope[],
  };
  if (record.workspaceId !== null) principal.workspaceId = record.workspaceId;
  if (record.projectId !== null) principal.projectId = record.projectId;
  return principal;
}
