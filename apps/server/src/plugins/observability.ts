/**
 * Observability plugin (spec §15).
 *
 * Fastify already generates `request.id` and ships structured Pino logging.
 * This plugin:
 *   - echoes the request id back on every response as `x-request-id`, so a
 *     client can correlate an error body (`error.requestId`) with logs;
 *   - tags each request log with the stable `instance_id`, so multi-instance
 *     deployments can filter traces.
 *
 * `/health/live` deliberately avoids any external dependency (spec §14.2); the
 * `ready` probe — not this plugin — is what checks the database.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Stable per-instance tag, mirrored into structured logs (spec §15). */
    instanceId?: string;
  }
}

export interface ObservabilityOptions {
  instanceId: string;
}

// Wrapped in fastify-plugin so the hooks attach to the parent (root) instance
// and apply to every route, regardless of where the plugin is registered.
// Without fp, Fastify encapsulates the hooks into an empty child scope.
export const observabilityPlugin = fp<ObservabilityOptions>(
  async (app: FastifyInstance, options) => {
    // Stable instance tag on every request log line.
    app.addHook('onRequest', async (request) => {
      request.instanceId = options.instanceId;
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
