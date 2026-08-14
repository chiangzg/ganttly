/**
 * Personal Access Token (PAT) contract (spec §8.3 / §16.2).
 *
 * PATs are the first-version MCP credential: a long-lived, scope-limited,
 * revocable bearer token bound to a user and optionally narrowed to a single
 * workspace or project. The plaintext token is shown exactly once at creation
 * time; the database stores only a display prefix and `SHA-256(token + pepper)`.
 *
 * These schemas validate the REST envelope used by the Web settings UI
 * (`/api/v1/me/tokens`). The token is never persisted or logged beyond its
 * prefix and hash.
 */
import { z } from 'zod';

/**
 * The fixed MCP scope set (spec §8.3). A PAT's effective authority is the
 * intersection of its scopes with the holder's workspace role (spec §6.3).
 */
export const MCP_SCOPES = [
  'workspace:read',
  'project:read',
  'task:write',
  'project:archive',
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export const patScopeSchema = z.enum(MCP_SCOPES);

/**
 * Create a PAT. `workspaceId`/`projectId` optionally narrow the token's reach;
 * when omitted the token is valid across all of the holder's workspaces
 * (still gated per-request by membership and scope).
 */
export const createPatRequestSchema = z.object({
  name: z.string().min(1).max(120),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  scopes: z.array(patScopeSchema).min(1),
  /** ISO 8601 timestamp; omitted = no expiry. */
  expiresAt: z.string().datetime().optional(),
});
export type CreatePatRequest = z.infer<typeof createPatRequestSchema>;

/**
 * Non-secret PAT projection returned by list/get. Never carries the token hash
 * or plaintext — only the short `tokenPrefix` so the user can recognise a token
 * they created (e.g. `pat_7Kp9…`).
 */
export interface PatSummary {
  id: string;
  name: string;
  /** Short, non-secret prefix used to identify the token in lists. */
  tokenPrefix: string;
  scopes: readonly McpScope[];
  workspaceId?: string;
  projectId?: string;
  /** ISO 8601, null when the token never expires. */
  expiresAt: string | null;
  /** ISO 8601, null until first MCP use. */
  lastUsedAt: string | null;
  /** ISO 8601, null until the token is revoked. */
  revokedAt: string | null;
  createdAt: string;
}

/**
 * Response of `POST /me/tokens`. `token` is the full plaintext credential and
 * is returned exactly once — the UI must prompt the user to copy it
 * immediately. Subsequent reads only return {@link PatSummary}.
 */
export interface CreatePatResponse {
  token: string;
  pat: PatSummary;
}
