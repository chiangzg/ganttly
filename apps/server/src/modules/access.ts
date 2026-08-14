/**
 * Access control — workspace membership & role gating (spec §6.3 / §13).
 *
 * The two invariants enforced everywhere a resource is touched:
 *  1. Every query first checks workspace membership (IDOR prevention).
 *  2. Non-members receive 404, not 403, so the existence of a workspace or
 *     project is never leaked to an outsider (spec §16.2).
 */
import { and, eq } from 'drizzle-orm';
import { ApiErrorCode } from '@ganttly/api-contract';
import type { FastifyRequest } from 'fastify';
import type { AuthPrincipal } from '../auth/principal';
import type { Db } from '../db/client';
import { workspaceMembers } from '../db/schema';
import { HttpError } from './errors';

export type WorkspaceRole = 'viewer' | 'editor' | 'admin' | 'owner';

/** Permission ranking (spec §6.3): viewer < editor < admin < owner. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export function meetsRole(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Throw AUTH_REQUIRED when the request carries no authenticated principal. */
export function requirePrincipal(request: FastifyRequest): AuthPrincipal {
  if (!request.principal) {
    throw new HttpError(ApiErrorCode.AUTH_REQUIRED, 'Authentication required');
  }
  return request.principal;
}

/**
 * Minimal query surface so the same helper works against both the connection
 * pool (`app.db`) and an in-flight transaction (`tx`).
 */
type Selectable = Pick<Db, 'select'>;

export async function findMembership(
  client: Selectable,
  userId: string,
  workspaceId: string,
): Promise<{ role: WorkspaceRole } | undefined> {
  const rows = await client
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { role: row.role as WorkspaceRole };
}

/**
 * Ensure the principal is a member of `workspaceId` with at least `minRole`.
 * Non-members get 404 (no existence leak); insufficient role gets 403. Returns
 * the confirmed role on success.
 */
export async function requireMembership(
  client: Selectable,
  principal: AuthPrincipal,
  workspaceId: string,
  minRole: WorkspaceRole = 'viewer',
): Promise<WorkspaceRole> {
  const membership = await findMembership(client, principal.userId, workspaceId);
  if (!membership) {
    throw new HttpError(ApiErrorCode.NOT_FOUND, 'Workspace not found');
  }
  if (!meetsRole(membership.role, minRole)) {
    throw new HttpError(ApiErrorCode.FORBIDDEN, 'Insufficient permissions for this workspace');
  }
  return membership.role;
}

/**
 * Whether a principal holds `scope`. Web sessions implicitly hold the full
 * role-gated scope set; PATs (and future OAuth clients) hold only their granted
 * scopes (spec §6.3: effective authority = token scope ∩ workspace role).
 */
export function hasScope(principal: AuthPrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}

/**
 * Throw FORBIDDEN when the principal lacks `scope`. Used by MCP tool handlers
 * to gate writes/reads before touching the database.
 */
export function requireScope(principal: AuthPrincipal, scope: string): void {
  if (!hasScope(principal, scope)) {
    throw new HttpError(
      ApiErrorCode.FORBIDDEN,
      `This credential lacks the required scope: ${scope}`,
    );
  }
}
