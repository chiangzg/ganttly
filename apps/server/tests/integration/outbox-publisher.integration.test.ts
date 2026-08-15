/**
 * Outbox publisher integration (spec §11.2 / §17 PR6). Drives the publisher
 * against a real database: emit unpublished rows → drain → assert they are
 * marked published and fanned out to the bus in sequence order, plus cleanup
 * and backlog sampling. Requires TEST_DATABASE_URL; self-skips otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProjectEvent } from '@ganttly/api-contract';
import { eq, isNull } from 'drizzle-orm';
import { outboxEvents } from '../../src/db/schema';
import { newEventId } from '../../src/id';
import { createWorkspaceEventBus } from '../../src/modules/events/bus';
import { createOutboxPublisher, type PublisherLogger } from '../../src/modules/events/publisher';
import { buildIntegrationServer } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

const noopLogger: PublisherLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe.skipIf(!dbUrl)('Outbox publisher integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildIntegrationServer();
    await app.db.delete(outboxEvents);
  });
  afterAll(async () => {
    await app.close();
  });

  async function emit(
    workspaceId: string,
    sequence: { type: string; payload: Record<string, unknown>; projectId?: string | null }[],
  ): Promise<void> {
    for (const item of sequence) {
      await app.db.insert(outboxEvents).values({
        id: newEventId(),
        workspaceId,
        projectId: item.projectId ?? null,
        type: item.type,
        payloadJsonb: item.payload,
        createdAt: new Date(),
        publishedAt: null,
      });
    }
  }

  async function unpublishedCount(): Promise<number> {
    const rows = await app.db
      .select({ sequence: outboxEvents.sequence })
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt));
    return rows.length;
  }

  it('marks drained rows published and fans them out to the bus in order', async () => {
    const bus = createWorkspaceEventBus();
    const received: ProjectEvent[] = [];
    bus.subscribe('ws_drain', (e) => received.push(e));
    const publisher = createOutboxPublisher(app.db, bus, {
      pollIntervalMs: 1000,
      batchSize: 100,
      retentionDays: 7,
      lagAlertThreshold: 1000,
      maintenanceIntervalMs: 60_000,
      logger: noopLogger,
    });

    await emit('ws_drain', [
      {
        type: 'project.created',
        payload: { name: 'A', actor: { type: 'web', id: 'u1' } },
        projectId: 'prj_a',
      },
      {
        type: 'project.updated',
        payload: { revision: 2, actor: { type: 'mcp', id: 'pat' } },
        projectId: 'prj_a',
      },
      {
        type: 'project.updated',
        payload: { revision: 3, actor: { type: 'web', id: 'u1' } },
        projectId: 'prj_a',
      },
    ]);

    await publisher.drainOnce();

    expect(received.map((e) => e.id)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    // Sequence order preserved.
    const ids = received.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(received[0]!.type).toBe('project.created');
    expect(received[1]!.revision).toBe('2');
    expect(received[2]!.actor.type).toBe('web');

    // All drained rows are now published.
    const remaining = await app.db
      .select({ publishedAt: outboxEvents.publishedAt })
      .from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, 'ws_drain'));
    expect(remaining.every((r) => r.publishedAt !== null)).toBe(true);

    publisher.stop();
    bus.close();
  });

  it('collectBacklog reports unpublished count and age', async () => {
    const bus = createWorkspaceEventBus();
    const publisher = createOutboxPublisher(app.db, bus, {
      pollIntervalMs: 1000,
      batchSize: 100,
      retentionDays: 7,
      lagAlertThreshold: 1000,
      maintenanceIntervalMs: 60_000,
      logger: noopLogger,
    });

    await emit('ws_backlog', [
      { type: 'project.updated', payload: { revision: 1 } },
      { type: 'project.updated', payload: { revision: 2 } },
    ]);

    const stats = await publisher.collectBacklog();
    expect(stats.unpublished).toBeGreaterThanOrEqual(2);
    // Freshly-emitted rows must have a near-zero age. `now()` is the Postgres
    // clock while `createdAt` is written from the app server clock, so allow a
    // small skew instead of asserting a strict non-negative value.
    expect(Math.abs(stats.oldestAgeSeconds)).toBeLessThan(60);

    publisher.stop();
    bus.close();
  });

  it('cleanup deletes published rows past retention but keeps unpublished ones', async () => {
    const bus = createWorkspaceEventBus();
    const publisher = createOutboxPublisher(app.db, bus, {
      pollIntervalMs: 1000,
      batchSize: 100,
      retentionDays: 7,
      lagAlertThreshold: 1000,
      maintenanceIntervalMs: 60_000,
      logger: noopLogger,
    });

    // An old published row (createdAt 10 days ago) + a fresh unpublished row.
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await app.db.insert(outboxEvents).values({
      id: newEventId(),
      workspaceId: 'ws_cleanup',
      projectId: null,
      type: 'project.updated',
      payloadJsonb: { revision: 1 },
      createdAt: oldDate,
      publishedAt: oldDate,
    });
    await emit('ws_cleanup', [{ type: 'project.updated', payload: { revision: 2 } }]);
    const beforeUnpublished = await unpublishedCount();

    await publisher.cleanupOnce();

    // The old published row is gone; the fresh unpublished row remains.
    const oldRows = await app.db
      .select({ sequence: outboxEvents.sequence })
      .from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, 'ws_cleanup'));
    const freshUnpublished = await unpublishedCount();
    expect(oldRows).toHaveLength(1); // only the fresh unpublished row left in this ws
    expect(freshUnpublished).toBe(beforeUnpublished); // unpublished untouched

    publisher.stop();
    bus.close();
  });

  it('a fresh drain is a no-op when nothing is pending', async () => {
    const bus = createWorkspaceEventBus();
    const received: ProjectEvent[] = [];
    bus.subscribe('ws_empty', (e) => received.push(e));
    const publisher = createOutboxPublisher(app.db, bus, {
      pollIntervalMs: 1000,
      batchSize: 100,
      retentionDays: 7,
      lagAlertThreshold: 1000,
      maintenanceIntervalMs: 60_000,
      logger: noopLogger,
    });

    await publisher.drainOnce();
    expect(received).toHaveLength(0);

    publisher.stop();
    bus.close();
  });
});
