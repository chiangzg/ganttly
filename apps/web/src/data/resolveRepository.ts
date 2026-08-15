/**
 * Repository resolver — the single point that decides local vs remote
 * (spec §12.1 "Repository Factory").
 *
 * For a local {@link ProjectRef} the singleton IndexedDB repository is
 * returned. For a remote ref a {@link RemoteRepository} bound to the
 * instance's HTTP client + workspace + user is returned, cached per
 * `(instanceId, workspaceId)` so repeated lookups reuse the same instance.
 *
 * Navigation-state persistence (`loadNavigationState`/`saveNavigationState`)
 * is always local — see {@link getNavigationRepository} — regardless of which
 * scope the active project lives in.
 */
import { getRepository } from './createRepository';
import { createHttpClient, type HttpClient } from './httpClient';
import { RemoteRepository } from './remoteRepository';
import { isLocalRef, scopeKey, type ProjectRef } from './projectRef';
import type { DataRepository, ProjectPreferencesRepository, ProjectRepository } from './repository';

/** Minimal instance config the resolver needs to build an HTTP client. */
export interface InstanceEndpoint {
  id: string;
  baseUrl: string;
}

export interface ResolveContext {
  instance: InstanceEndpoint;
  userId: string;
}

const remoteCache = new Map<string, RemoteRepository>();
const httpClientCache = new Map<string, HttpClient>();

/**
 * Resolve the {@link ProjectRepository} for a given ref. Returns `null` for a
 * remote ref when the context is incomplete (no userId yet — caller should
 * prompt login).
 */
export function resolveProjectRepository(
  ref: ProjectRef,
  ctx: ResolveContext | null,
): ProjectRepository | null {
  if (isLocalRef(ref)) return getRepository();
  if (!ctx) return null;

  const key = scopeKey(ref);
  let cached = remoteCache.get(key);
  if (!cached) {
    let http = httpClientCache.get(ctx.instance.id);
    if (!http) {
      http = createHttpClient(ctx.instance.baseUrl);
      httpClientCache.set(ctx.instance.id, http);
    }
    cached = new RemoteRepository({
      httpClient: http,
      instanceId: ctx.instance.id,
      workspaceId: ref.workspaceId,
      userId: ctx.userId,
    });
    remoteCache.set(key, cached);
  }
  return cached;
}

/**
 * The navigation-state repository — always the local one, regardless of the
 * active scope. Tabs, favourites and recents are per-device preferences that
 * never sync to the server (spec §12.2).
 */
export function getNavigationRepository(): ProjectPreferencesRepository {
  return getRepository();
}

/** The local repository singleton (also a full {@link DataRepository}). */
export function getLocalRepository(): DataRepository {
  return getRepository();
}

/**
 * Invalidate cached remote repositories for an instance — call after login or
 * logout so a new userId is picked up. The HTTP client is preserved (it only
 * depends on baseUrl).
 */
export function clearRemoteCache(instanceId?: string): void {
  if (!instanceId) {
    remoteCache.clear();
    return;
  }
  for (const [key] of remoteCache) {
    const [inst] = key.split('/');
    if (inst === instanceId) remoteCache.delete(key);
  }
}
