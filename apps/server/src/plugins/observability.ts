/**
 * Observability plugin (spec §15).
 *
 * Fastify already generates `request.id` and ships structured Pino logging.
 * This plugin:
 *   - echoes the request id back on every response as `x-request-id`, so a
 *     client can correlate an error body (`error.requestId`) with logs;
 *   - tags each request log with the stable `instance_id`, so multi-instance
 *     deployments can filter traces;
 *   - records HTTP latency and status into the Prometheus metrics registry.
 *
 * `/health/live` deliberately avoids any external dependency (spec §14.2); the
 * `ready` probe — not this plugin — is what checks the database.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppMetrics } from '../modules/metrics';

declare module 'fastify' {
  interface FastifyRequest {
    /** Stable per-instance tag, mirrored into structured logs (spec §15). */
    instanceId?: string;
    /** High-resolution start timestamp for latency measurement. */
    startedAt?: [number, number];
  }
}

export interface ObservabilityOptions {
  instanceId: string;
  metrics?: AppMetrics;
}

/** A bounded route label so label cardinality stays finite. */
function routeOf(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url as string | undefined;
  if (pattern && pattern.length > 0) return pattern;
  // Unrouted (e.g. 404) — collapse to a constant rather than the raw path.
  return 'unrouted';
}

// Wrapped in fastify-plugin so the hooks attach to the parent (root) instance
// and apply to every route, regardless of where the plugin is registered.
// Without fp, Fastify encapsulates the hooks into an empty child scope.
export const observabilityPlugin = fp<ObservabilityOptions>(
  async (app: FastifyInstance, options) => {
    // Stable instance tag + latency start on every request log line.
    app.addHook('onRequest', async (request) => {
      request.instanceId = options.instanceId;
      request.startedAt = process.hrtime();
    });

    const record = (request: FastifyRequest, reply: FastifyReply): void => {
      if (!options.metrics || !request.startedAt) return;
      const delta = process.hrtime(request.startedAt);
      const seconds = delta[0] + delta[1] / 1e9;
      const method = request.method;
      const route = routeOf(request);
      const status = String(reply.statusCode);
      options.metrics.httpDurationSeconds.labels(method, route, status).observe(seconds);
      options.metrics.httpRequestsTotal.labels(method, status).inc();
    };

    app.addHook('onResponse', async (request, reply) => {
      record(request, reply);
    });
    // Errors that never reach onResponse (e.g. thrown in a handler and handled
    // by the error handler still go through onResponse in Fastify, but keep an
    // onError safety net for aborted requests).
    app.addHook('onError', async (request, reply) => {
      record(request, reply);
    });

    // onSend (not onResponse) — onResponse runs after headers are flushed, so
    // header mutations there are silently lost. onSend runs before the payload
    // is written and must return the (unchanged) payload.
    app.addHook('onSend', async (request, reply, payload) => {
      reply.header('x-request-id', request.id);
      return payload;
    });
  },
  { name: 'observability' },
);
