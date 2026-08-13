/**
 * Per-device view-state cache for remote projects (spec §5.2).
 *
 * The server stores a neutral `DEFAULT_REMOTE_VIEW_STATE` and ignores the
 * client-submitted `viewState` on import/PUT — so a project's revision never
 * advances on scroll/selection. The actual per-user view state (zoom level,
 * scroll position, collapsed tasks, selection) is persisted here in
 * `localStorage`, keyed by `userId + ProjectRef`, and overlaid by
 * {@link RemoteRepository.loadProject} onto the file returned to the store.
 *
 * Local projects do not use this — their viewState is part of the saved file.
 */
import { DEFAULT_VIEW_STATE, type ViewState } from '@ganttly/schema';
import type { ProjectRef } from './projectRef';
import { refKey } from './projectRef';

const PREFIX = 'ganttly:view-state';

function storageKey(userId: string, ref: ProjectRef): string {
  return `${PREFIX}:${userId}:${refKey(ref)}`;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or disabled storage — view state is best-effort.
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Load the cached view state, or {@link DEFAULT_VIEW_STATE} if none exists. */
export function loadViewState(userId: string, ref: ProjectRef): ViewState {
  const raw = safeGet(storageKey(userId, ref));
  if (!raw)
    return { ...DEFAULT_VIEW_STATE, collapsedTaskIds: [...DEFAULT_VIEW_STATE.collapsedTaskIds] };
  try {
    const parsed = JSON.parse(raw) as Partial<ViewState>;
    return { ...DEFAULT_VIEW_STATE, ...parsed, collapsedTaskIds: parsed.collapsedTaskIds ?? [] };
  } catch {
    return { ...DEFAULT_VIEW_STATE, collapsedTaskIds: [...DEFAULT_VIEW_STATE.collapsedTaskIds] };
  }
}

/** Persist the view state for a given user+project ref. */
export function saveViewState(userId: string, ref: ProjectRef, viewState: ViewState): void {
  safeSet(storageKey(userId, ref), JSON.stringify(viewState));
}

/** Remove the cached view state (e.g. when a remote project is deleted). */
export function clearViewState(userId: string, ref: ProjectRef): void {
  safeRemove(storageKey(userId, ref));
}
