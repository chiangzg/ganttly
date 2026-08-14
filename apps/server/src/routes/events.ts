/**
 * SSE event stream (spec §11.1), mounted under `/api/v1`.
 *
 *   GET /events?workspaceId=:workspaceId   workspace change notifications
 *
 * Delivers spec §11.1 `ProjectEvent` frames over a long-lived text/event-stream
 * connection. Resume uses `Last-Event-ID` (= outbox `sequence`); a stale or
 * gapped cursor yields a single `resync_required` control frame so the client
 * can re-fetch fresh state.
 *
 * Auth is the Web session cookie + workspace membership (non-members 404, no
 * existence leak). Events are written directly to the raw response with
 * `reply.hijack()` so Fastify does not own the response lifecycle; the
 * connection is torn down on `request.raw` 'close' to avoid leaking listeners.
 */
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import {
  buildControlFrame,
  buildSseFrame,
  SSE_EVENT_TYPES,
  SSE_HEARTBEAT,
  type ProjectEvent,
  type ResyncReason,
} from '@ganttly/api-contract';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { outboxEvents } from '../db/schema';
import { requireMembership, requirePrincipal } from '../modules/access';
import { mapOutboxRowToEvent, type OutboxRow } from '../modules/events/publisher';

/** Max events replayed on resume before forcing a resync (spec §11.2). */
const REPLAY_CAP = 500;
/** Heartbeat cadence — keeps proxies from closing an idle stream. */
const HEARTBEAT_INTERVAL_MS = 15_000;

export const eventsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (!app.hasDecorator('db')) {
    // SSE needs the database for membership + replay; skip when no pool.
    return;
  }
  const db = app.db;

  app.get('/events', async (request, reply) => {
    const workspaceId = (request.query as { workspaceId?: string }).workspaceId;
    if (!workspaceId) {
      return reply
        .code(400)
        .send({ error: { message: 'workspaceId query parameter is required' } });
    }
    // Membership gate BEFORE hijack — a failure here returns a normal JSON
    // error through the shared error handler.
    await requireMembership(db, requirePrincipal(request), workspaceId);

    const lastEventId = request.headers['last-event-id'];
    const headerValue = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    const parsed = headerValue ? Number.parseInt(headerValue, 10) : Number.NaN;
    const lastSequence = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

    // Take ownership of the raw response.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable buffering in nginx and other reverse proxies.
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const write = (frame: string): boolean => {
      if (closed || res.writableEnded) return false;
      return res.write(frame);
    };
    const endStream = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      if (app.hasDecorator('metrics')) app.metrics.sseConnections.dec();
      if (!res.writableEnded) res.end();
    };

    let lastSent = lastSequence ?? 0;
    const buffer: ProjectEvent[] = [];
    let replayDone = false;

    const send = (event: ProjectEvent): void => {
      write(buildSseFrame(event));
      lastSent = event.id;
    };

    // Subscribe first (buffering) so events published during the replay query
    // are captured, then de-duped via the `lastSent` watermark.
    const unsubscribe = app.bus.subscribe(workspaceId, (event) => {
      if (event.id <= lastSent) return; // de-dup
      if (replayDone) send(event);
      else buffer.push(event);
    });

    const heartbeat = setInterval(() => {
      write(SSE_HEARTBEAT);
    }, HEARTBEAT_INTERVAL_MS);

    request.raw.on('close', endStream);
    res.on('error', endStream);

    // Track the live connection count for /metrics.
    if (app.hasDecorator('metrics')) app.metrics.sseConnections.inc();

    try {
      if (lastSequence !== null) {
        // Gap detection: cursor older than the oldest retained published event
        // means intervening events were pruned and can no longer be replayed.
        const minRow = await db
          .select({ min: sql<number>`min(${outboxEvents.sequence})` })
          .from(outboxEvents)
          .where(
            and(eq(outboxEvents.workspaceId, workspaceId), isNotNull(outboxEvents.publishedAt)),
          );
        const minPublished = minRow[0]?.min;
        if (
          minPublished !== undefined &&
          minPublished !== null &&
          lastSequence < (minPublished as number)
        ) {
          write(buildControlFrame({ type: 'resync_required', reason: 'gap' }));
          endStream();
          return reply;
        }

        // Replay published events after the cursor (CAP+1 to detect overflow).
        const replay = await db
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
          .where(
            and(
              eq(outboxEvents.workspaceId, workspaceId),
              gt(outboxEvents.sequence, lastSequence),
              isNotNull(outboxEvents.publishedAt),
            ),
          )
          .orderBy(asc(outboxEvents.sequence))
          .limit(REPLAY_CAP + 1);

        if (replay.length > REPLAY_CAP) {
          const reason: ResyncReason = 'over_limit';
          write(buildControlFrame({ type: 'resync_required', reason }));
          endStream();
          return reply;
        }
        for (const row of replay as OutboxRow[]) {
          const event = mapOutboxRowToEvent(row);
          if (SSE_EVENT_TYPES.includes(event.type)) send(event);
        }
      }

      // Drain events buffered during the replay, in sequence order.
      buffer.sort((a, b) => a.id - b.id);
      for (const event of buffer) {
        if (event.id > lastSent) send(event);
      }
      buffer.length = 0;
      replayDone = true;
    } catch (err) {
      request.log.error({ err }, 'SSE replay failed');
      endStream();
    }

    return reply;
  });
};
