/**
 * In-process event bus (spec §11.2).
 *
 * Fans out published outbox events to SSE subscribers keyed by workspace. This
 * is the "instance event bus" the spec describes; for single-process
 * deployments it is a plain in-memory fan-out. Multi-process fan-out via
 * PostgreSQL `LISTEN/NOTIFY` is a documented future extension
 * (see `docs/ops-runbook.md`) — the bus surface stays stable so only the
 * publisher needs to change.
 *
 * The bus carries already-published, durable events: a row is only published
 * after its `outbox_events.published_at` is committed, so subscribers never
 * observe uncommitted or lost data.
 *
 * Listener invocation is sequential with per-listener error isolation: one
 * subscriber that throws (or writes to a half-closed socket) never prevents
 * delivery to the others.
 */
import type { ProjectEvent } from '@ganttly/api-contract';

type Listener = (event: ProjectEvent) => void;

export interface WorkspaceEventBus {
  /**
   * Subscribe to events for a workspace. Returns an unsubscribe function.
   * Pass `'*'` as `workspaceId` to receive events for all workspaces (used by
   * metrics/tests).
   */
  subscribe(workspaceId: string, listener: Listener): () => void;
  /** Deliver a published event to all matching subscribers. */
  publish(event: ProjectEvent): void;
  /** Total live listeners across all channels (metrics/tests). */
  readonly listenerCount: number;
  /** Remove all listeners (shutdown). */
  close(): void;
}

const ANY = '*';

/**
 * Build a fresh in-process bus. One per server process; shared between the
 * publisher (producer) and the SSE route (consumers) via `app.decorate`.
 */
export function createWorkspaceEventBus(): WorkspaceEventBus {
  // channel -> listeners. The wildcard channel ('*') receives every event.
  const channels = new Map<string, Set<Listener>>();

  const forChannel = (workspaceId: string) => {
    let set = channels.get(workspaceId);
    if (!set) {
      set = new Set();
      channels.set(workspaceId, set);
    }
    return set;
  };

  let total = 0;

  return {
    subscribe(workspaceId, listener) {
      const set = forChannel(workspaceId);
      set.add(listener);
      total += 1;
      return () => {
        if (set.delete(listener)) total -= 1;
        if (set.size === 0) channels.delete(workspaceId);
      };
    },

    publish(event) {
      // Snapshot the matching listeners so a subscriber that (un)subscribes
      // during delivery does not mutate the iteration.
      const targets: Listener[] = [];
      const ws = channels.get(event.workspaceId);
      if (ws) targets.push(...ws);
      const any = channels.get(ANY);
      if (any) targets.push(...any);
      for (const listener of targets) {
        try {
          listener(event);
        } catch {
          // Per-listener isolation: a bad subscriber must not break the others.
        }
      }
    },

    get listenerCount() {
      return total;
    },

    close() {
      channels.clear();
      total = 0;
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** In-process event bus for SSE fan-out (decorated in bootstrap). */
    bus: WorkspaceEventBus;
  }
}
