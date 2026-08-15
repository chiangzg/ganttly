/**
 * Transactional outbox publisher (spec §11.2).
 *
 * A background loop drains unpublished `outbox_events` rows, marks them
 * published, and fans them out to the in-process {@link WorkspaceEventBus} for
 * SSE delivery. The drain is transactional with `FOR UPDATE SKIP LOCKED`, so:
 *
 *   - a process crash after `UPDATE published_at` but before bus delivery loses
 *     only the *live* push — the row stays published and clients resume it via
 *     `Last-Event-ID` on reconnect (fault-injection acceptance, spec §17 PR6);
 *   - two publishers (multi-process) never grab the same row.
 *
 * Delivery to the bus happens *after* commit, so subscribers never observe
 * uncommitted data. A row is published exactly once per process: the bus is
 * best-effort live delivery, the outbox is the durable record.
 */
import { and, asc, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import type { ProjectEvent, SseEventType } from '@ganttly/api-contract';
import type { Db } from '../../db/client';
import { outboxEvents } from '../../db/schema';
import type { WorkspaceEventBus } from './bus';

/** Minimal logger surface so the module stays decoupled from pino directly. */
export interface PublisherLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface OutboxPublisherOptions {
  pollIntervalMs: number;
  batchSize: number;
  retentionDays: number;
  /** Warn when unpublished backlog exceeds this many rows. */
  lagAlertThreshold: number;
  /** How often to prune published rows / sample the backlog. */
  maintenanceIntervalMs: number;
  logger: PublisherLogger;
}

export interface BacklogStats {
  unpublished: number;
  oldestAgeSeconds: number;
}

export interface OutboxPublisher {
  start(): void;
  stop(): void;
  /** Trigger an immediate drain (no-op if one is already in flight). */
  wake(): void;
  /** Drain one batch; resolves when the bus fan-out completes. */
  drainOnce(): Promise<void>;
  /** Delete published rows older than the retention window. */
  cleanupOnce(): Promise<void>;
  /** Count unpublished rows + age of the oldest (for metrics/alerts). */
  collectBacklog(): Promise<BacklogStats>;
}

export interface OutboxRow {
  sequence: number;
  id: string;
  workspaceId: string;
  projectId: string | null;
  type: string;
  payload: unknown;
  createdAt: Date;
}

/** Pure projection of an outbox row onto the spec §11.1 event shape. */
export function mapOutboxRowToEvent(row: OutboxRow): ProjectEvent {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const actor = (payload.actor as { type: 'web' | 'mcp' | 'system'; id: string } | undefined) ?? {
    type: 'system',
    id: 'unknown',
  };
  const revision =
    typeof payload.revision === 'number'
      ? String(payload.revision)
      : (payload.revision as string | undefined);
  return {
    id: row.sequence,
    type: row.type as SseEventType,
    workspaceId: row.workspaceId,
    projectId: row.projectId ?? undefined,
    revision,
    actor,
    operationId: payload.operationId as string | undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createOutboxPublisher(
  db: Db,
  bus: WorkspaceEventBus,
  options: OutboxPublisherOptions,
): OutboxPublisher {
  const {
    pollIntervalMs,
    batchSize,
    retentionDays,
    lagAlertThreshold,
    maintenanceIntervalMs,
    logger,
  } = options;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let draining: Promise<void> | null = null;
  let stopped = false;

  async function drainOnce(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      let rows: OutboxRow[] = [];
      try {
        rows = await db.transaction(async (tx) => {
          const fetched = await tx
            .select({
              sequence: outboxEvents.sequence,
              id: outboxEvents.id,
              workspaceId: outboxEvents.workspaceId,
              projectId: outboxEvents.projectId,
              type: outboxEvents.type,
              payload: outboxEvents.payloadJsonb,
              createdAt: outboxEvents.createdAt,
            })
            .from(outboxEvents)
            .where(isNull(outboxEvents.publishedAt))
            .orderBy(asc(outboxEvents.sequence))
            .limit(batchSize)
            .for('update', { skipLocked: true });
          if (fetched.length === 0) return fetched as OutboxRow[];
          await tx
            .update(outboxEvents)
            .set({ publishedAt: new Date() })
            .where(
              inArray(
                outboxEvents.sequence,
                fetched.map((r) => r.sequence),
              ),
            );
          return fetched as OutboxRow[];
        });
      } catch (err) {
        logger.error('outbox drain failed', { err });
      }
      for (const row of rows) {
        try {
          bus.publish(mapOutboxRowToEvent(row));
        } catch (err) {
          // A single listener throw must not abort the rest of the batch.
          logger.error('outbox bus publish failed', { err, sequence: row.sequence });
        }
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  async function cleanupOnce(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      await db
        .delete(outboxEvents)
        .where(and(isNotNull(outboxEvents.publishedAt), lt(outboxEvents.createdAt, cutoff)));
    } catch (err) {
      logger.error('outbox cleanup failed', { err });
    }
  }

  async function collectBacklog(): Promise<BacklogStats> {
    try {
      const [row] = await db
        .select({
          unpublished: sql<number>`count(*)::int`,
          oldest: sql<number>`coalesce(extract(epoch from (now() - min(${outboxEvents.createdAt})))::int, 0)`,
        })
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt));
      return {
        unpublished: row?.unpublished ?? 0,
        oldestAgeSeconds: row?.oldest ?? 0,
      };
    } catch (err) {
      logger.error('outbox backlog sample failed', { err });
      return { unpublished: 0, oldestAgeSeconds: 0 };
    }
  }

  async function maintenance(): Promise<void> {
    await cleanupOnce();
    const stats = await collectBacklog();
    if (stats.unpublished >= lagAlertThreshold) {
      logger.warn('outbox backlog exceeds threshold', {
        unpublished: stats.unpublished,
        oldestAgeSeconds: stats.oldestAgeSeconds,
        threshold: lagAlertThreshold,
      });
    }
  }

  return {
    start() {
      if (pollTimer || stopped) return;
      pollTimer = setInterval(() => void drainOnce(), pollIntervalMs);
      // Don't keep the event loop alive solely for the publisher — the Fastify
      // server is the lifecycle owner. Tests stop explicitly via stop().
      pollTimer.unref?.();
      maintenanceTimer = setInterval(() => void maintenance(), maintenanceIntervalMs);
      maintenanceTimer.unref?.();
      logger.info('outbox publisher started', { pollIntervalMs, batchSize, retentionDays });
    },

    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      pollTimer = null;
      maintenanceTimer = null;
    },

    wake() {
      void drainOnce();
    },

    drainOnce,

    cleanupOnce,

    collectBacklog,
  };
}
