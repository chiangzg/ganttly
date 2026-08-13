/**
 * Authenticated principal (spec §10 `AuthPrincipal`).
 *
 * Abstracts *who* is making a request so the project service and routes never
 * branch on transport. Today only the Web session flow produces principals
 * (`actorType: 'user'`); PATs (PR5) will add `actorType: 'pat'` and OAuth
 * clients `actorType: 'oauth_client'` without changes downstream.
 */

export type PrincipalActorType = 'user' | 'pat' | 'oauth_client';

export interface AuthPrincipal {
  actorType: PrincipalActorType;
  /** Stable id used as `project_operations.actor_id` (user id today). */
  actorId: string;
  /** The human/workspace member this request acts for. */
  userId: string;
  /** Granted scopes; the Web session grants the full role-gated set. */
  scopes: readonly string[];
  /** PAT/OAuth-client scope restriction; undefined for Web sessions. */
  workspaceId?: string;
  projectId?: string;
}

/**
 * Scopes a Web session effectively holds. The Web user's real authority is
 * gated by their workspace role (viewer/editor/admin/owner) at query time; the
 * scope list exists so PATs (PR5) can narrow it via intersection.
 */
export const WEB_SESSION_SCOPES = [
  'workspace:read',
  'project:read',
  'task:write',
  'project:archive',
] as const;

/** Build the principal for an authenticated Web session user. */
export function webPrincipal(userId: string): AuthPrincipal {
  return { actorType: 'user', actorId: userId, userId, scopes: WEB_SESSION_SCOPES };
}

/**
 * Map a principal onto the `project_operations.actor_type` column
 * (`'web' | 'mcp' | 'system'`). PATs drive MCP tool calls, so they record as
 * `'mcp'`; Web users (and future OAuth clients acting via the REST API) record
 * as `'web'`.
 */
export function operationActorType(principal: AuthPrincipal): 'web' | 'mcp' | 'system' {
  if (principal.actorType === 'pat') return 'mcp';
  return 'web';
}
