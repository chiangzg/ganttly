/**
 * Subscribes the web client to remote workspace events (spec §11.3).
 *
 * Opens one SSE stream for the active remote+authenticated scope and dispatches
 * events to the project/catalog stores:
 *  - current project, already incorporated locally (the echo of this client's
 *    own save) → ignored, so an ordinary edit neither raises the banner nor
 *    triggers a redundant full reload;
 *  - current project, clean → reload snapshot + reset history (case a);
 *  - current project, dirty → raise the "remote has updates" flag (case b);
 *  - any other project → debounced catalog refresh (case c).
 *
 * The event/revision decision lives in
 * {@link useProjectStore.getState().handleRemoteChange} so it is testable
 * without a stream.
 *
 * On `resync_required` the cursor is unusable, so the stream is closed and a
 * fresh one (no `Last-Event-ID`) is reopened after the client re-fetches state.
 * Local scope and unauthenticated remote scopes keep no stream.
 */
import { useEffect, useRef } from 'react';
import type { ProjectEvent } from '@ganttly/api-contract';
import { createEventStream, type RemoteEventStream } from '@/data/sseClient';
import { isLocalRef, refEqual, type ProjectRef } from '@/data/projectRef';
import { useAuthStore } from '@/store/useAuthStore';
import { useInstanceStore } from '@/store/useInstanceStore';
import { useProjectCatalogStore } from '@/store/useProjectCatalogStore';
import { useProjectStore } from '@/store/useProjectStore';
import { useScopeStore } from '@/store/useScopeStore';

/** Coalesce a burst of catalog refreshes into one trailing call. */
const REFRESH_DEBOUNCE_MS = 400;
/** Reopen delay after a resync (lets the refresh/reload settle first). */
const RESYNC_REOPEN_MS = 1000;

export function useRemoteEvents(): void {
  const activeScope = useScopeStore((s) => s.activeScope);
  const profile = useAuthStore((s) => s.authByInstance[activeScope.instanceId] ?? undefined);
  const streamRef = useRef<RemoteEventStream | null>(null);

  useEffect(() => {
    const { instanceId, workspaceId } = activeScope;
    if (isLocalRef(activeScope)) return;
    const instance = useInstanceStore.getState().findInstance(instanceId);
    if (!instance) return;
    if (!useAuthStore.getState().getProfile(instanceId)) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void useProjectCatalogStore.getState().refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const handleEvent = (event: ProjectEvent) => {
      const ps = useProjectStore.getState();
      const current = ps.activeProjectRef;
      const isCurrent =
        !!current &&
        !!event.projectId &&
        refEqual(current, {
          instanceId,
          workspaceId,
          projectId: event.projectId,
        } satisfies ProjectRef);
      if (isCurrent) {
        // Revision-aware: the store ignores the echo of this client's own save
        // (and any event the local copy already covers) instead of mistaking it
        // for a foreign change.
        void ps.handleRemoteChange(current, event.revision);
      } else {
        scheduleRefresh();
      }
    };

    const open = () => {
      streamRef.current = createEventStream({
        baseUrl: instance.baseUrl,
        workspaceId,
        onEvent: handleEvent,
        onResync: () => {
          // Cursor unusable: re-fetch state, then reset the stream cursor.
          void useProjectCatalogStore.getState().refresh();
          const ps = useProjectStore.getState();
          if (!ps.dirty) void ps.reloadFromRemote();
          streamRef.current?.close();
          streamRef.current = null;
          if (!closed) reopenTimer = setTimeout(open, RESYNC_REOPEN_MS);
        },
      });
    };

    open();

    return () => {
      closed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reopenTimer) clearTimeout(reopenTimer);
      streamRef.current?.close();
      streamRef.current = null;
    };
    // Re-run when the scope or its auth profile changes.
  }, [activeScope, profile]);
}
