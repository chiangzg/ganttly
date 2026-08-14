/**
 * Prometheus metrics (spec §15) via `prom-client`.
 *
 * A lean registry of the indicators called out in the spec: HTTP latency and
 * status, rate-limit / auth-failure counts, MCP tool usage, live SSE
 * connections, and outbox backlog/age. `/metrics` exposes the text format (see
 * `routes/metrics.ts`). No sensitive data is carried in labels — only the
 * instance id (already public via discovery), HTTP method, route pattern,
 * status code, and tool/actor-kind enums.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { outboxEvents } from '../db/schema';

declare module 'fastify' {
  interface FastifyInstance {
    /** Prometheus metrics registry (decorated in bootstrap). */
    metrics: AppMetrics;
  }
}

export interface AppMetrics {
  registry: Registry;
  httpDurationSeconds: Histogram<string>;
  httpRequestsTotal: Counter<string>;
  rateLimitedTotal: Counter<string>;
  authFailuresTotal: Counter<string>;
  mcpToolCallsTotal: Counter<string>;
  sseConnections: Gauge<string>;
  outboxUnpublished: Gauge<string>;
  outboxLagSeconds: Gauge<string>;
}

/** Build a fresh registry + metric set. One per process (bootstrap). */
export function createMetrics(instanceId: string): AppMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ instance: instanceId });
  collectDefaultMetrics({ register: registry, prefix: 'ganttly_' });

  const httpDurationSeconds = new Histogram({
    name: 'ganttly_http_request_duration_seconds',
    help: 'HTTP request latency in seconds.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const httpRequestsTotal = new Counter({
    name: 'ganttly_http_requests_total',
    help: 'Total HTTP requests by method and status.',
    labelNames: ['method', 'status'],
    registers: [registry],
  });
  const rateLimitedTotal = new Counter({
    name: 'ganttly_rate_limited_total',
    help: 'Requests rejected by the rate limiter (HTTP 429).',
    registers: [registry],
  });
  const authFailuresTotal = new Counter({
    name: 'ganttly_auth_failures_total',
    help: 'Authentication failures by kind.',
    labelNames: ['kind'],
    registers: [registry],
  });
  const mcpToolCallsTotal = new Counter({
    name: 'ganttly_mcp_tool_calls_total',
    help: 'MCP tool invocations served at /mcp.',
    registers: [registry],
  });
  const sseConnections = new Gauge({
    name: 'ganttly_sse_connections',
    help: 'Live SSE event-stream connections.',
    registers: [registry],
  });
  const outboxUnpublished = new Gauge({
    name: 'ganttly_outbox_unpublished',
    help: 'Outbox events awaiting publication.',
    registers: [registry],
  });
  const outboxLagSeconds = new Gauge({
    name: 'ganttly_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event.',
    registers: [registry],
  });

  return {
    registry,
    httpDurationSeconds,
    httpRequestsTotal,
    rateLimitedTotal,
    authFailuresTotal,
    mcpToolCallsTotal,
    sseConnections,
    outboxUnpublished,
    outboxLagSeconds,
  };
}

/**
 * Sample the outbox backlog into the gauges. Called periodically (and after a
 * publisher drain) so `/metrics` reflects near-current queue depth.
 */
export async function collectOutboxMetrics(db: Db, metrics: AppMetrics): Promise<void> {
  try {
    const [row] = await db
      .select({
        unpublished: sql<number>`count(*)::int`,
        oldest: sql<number>`coalesce(extract(epoch from (now() - min(${outboxEvents.createdAt})))::int, 0)`,
      })
      .from(outboxEvents)
      .where(sql`${outboxEvents.publishedAt} is null`);
    metrics.outboxUnpublished.set(row?.unpublished ?? 0);
    metrics.outboxLagSeconds.set(row?.oldest ?? 0);
  } catch {
    // A transient DB error during metrics sampling must not crash the process.
  }
}
