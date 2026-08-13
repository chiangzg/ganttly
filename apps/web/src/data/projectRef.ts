/**
 * Multi-instance project identity (spec §2.2).
 *
 * A project is uniquely identified by the triple `{ instanceId, workspaceId,
 * projectId }`. Local mode is modelled as a virtual instance+workspace so the
 * same machinery serves both local and remote projects.
 *
 * `projectId` must NEVER again be assumed globally unique across instances —
 * tabs, favourites, recents and routes all key off the full ref.
 */

/** Reserved ids for the always-available local workspace (spec §2.2). */
export const LOCAL_INSTANCE = 'local';
export const LOCAL_WORKSPACE = 'local';

export interface ProjectRef {
  instanceId: string;
  workspaceId: string;
  projectId: string;
}

/** A workspace scope — everything except the project id (spec §2.2). */
export interface ScopeRef {
  instanceId: string;
  workspaceId: string;
}

/** Build a local-mode ref from a bare project id. */
export function localRef(projectId: string): ProjectRef {
  return { instanceId: LOCAL_INSTANCE, workspaceId: LOCAL_WORKSPACE, projectId };
}

/** Build a local-mode scope. */
export function localScope(): ScopeRef {
  return { instanceId: LOCAL_INSTANCE, workspaceId: LOCAL_WORKSPACE };
}

export function isLocalRef(ref: { instanceId: string }): boolean {
  return ref.instanceId === LOCAL_INSTANCE;
}

export function refEqual(a: ProjectRef, b: ProjectRef): boolean {
  return (
    a.instanceId === b.instanceId && a.workspaceId === b.workspaceId && a.projectId === b.projectId
  );
}

export function scopeEqual(a: ScopeRef, b: ScopeRef): boolean {
  return a.instanceId === b.instanceId && a.workspaceId === b.workspaceId;
}

/**
 * Stable string key for a ref, used as a localStorage/IndexedDB suffix.
 * `instanceId/workspaceId/projectId` — the segments are nanoid-prefixed ids
 * that never contain `/`, so no escaping is needed.
 */
export function refKey(ref: ProjectRef): string {
  return `${ref.instanceId}/${ref.workspaceId}/${ref.projectId}`;
}

export function scopeKey(scope: ScopeRef): string {
  return `${scope.instanceId}/${scope.workspaceId}`;
}

/** Parse a {@link refKey} string back into a {@link ProjectRef}. */
export function parseRefKey(key: string): ProjectRef | null {
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  const [instanceId, workspaceId, projectId] = parts;
  if (!instanceId || !workspaceId || !projectId) return null;
  return { instanceId, workspaceId, projectId };
}
