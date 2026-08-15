/**
 * Route path helpers for multi-instance navigation (spec §12.2).
 *
 * All project routes are scoped by instance + workspace so the URL itself
 * identifies which deployment and workspace a project belongs to:
 *   `/instances/:instanceId/workspaces/:workspaceId/projects/:projectId`
 *
 * Old single-segment paths (`/projects/:id`) are redirected to the local
 * scope (see {@link App}) for backward compatibility with bookmarks.
 */
import type { ProjectRef, ScopeRef } from '@/data/projectRef';
import { LOCAL_INSTANCE, LOCAL_WORKSPACE, localRef } from '@/data/projectRef';

export const PROJECTS_BASE = '/instances/:instanceId/workspaces/:workspaceId/projects';

/** Build the full path for a specific project. */
export function buildProjectPath(ref: ProjectRef): string {
  return `/instances/${ref.instanceId}/workspaces/${ref.workspaceId}/projects/${ref.projectId}`;
}

/** Build the path for a scope's project center. */
export function buildScopePath(scope: ScopeRef): string {
  return `/instances/${scope.instanceId}/workspaces/${scope.workspaceId}/projects`;
}

/** Build the trash path for a scope. */
export function buildTrashPath(scope: ScopeRef): string {
  return `${buildScopePath(scope)}/trash`;
}

/** Parse route params into a ProjectRef (or null if invalid). */
export function refFromParams(params: {
  instanceId?: string;
  workspaceId?: string;
  projectId?: string;
}): ProjectRef | null {
  if (!params.instanceId || !params.workspaceId || !params.projectId) return null;
  return {
    instanceId: params.instanceId,
    workspaceId: params.workspaceId,
    projectId: params.projectId,
  };
}

/** Parse route params into a ScopeRef (or null if invalid). */
export function scopeFromParams(params: {
  instanceId?: string;
  workspaceId?: string;
}): ScopeRef | null {
  if (!params.instanceId || !params.workspaceId) return null;
  return { instanceId: params.instanceId, workspaceId: params.workspaceId };
}

/**
 * Build a ProjectRef from a bare project id, defaulting to the local scope.
 * Used by the legacy redirect route (`/projects/:projectId`).
 */
export function localProjectRef(projectId: string): ProjectRef {
  return localRef(projectId);
}

/** Local scope constant for redirect targets. */
export const LOCAL_SCOPE: ScopeRef = {
  instanceId: LOCAL_INSTANCE,
  workspaceId: LOCAL_WORKSPACE,
};
