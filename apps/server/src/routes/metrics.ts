/**
 * Prometheus scrape endpoint (spec §15). `GET /metrics` returns the registry
 * in Prometheus text exposition format. No credentials are required — the
 * payload carries only aggregate counters/latencies and the (already public)
 * instance id. Operators should still network-isolate it behind a reverse
 * proxy if they consider even aggregate traffic data sensitive.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppMetrics } from '../modules/metrics';

export interface MetricsRoutesOptions {
  metrics: AppMetrics;
}

export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (
  app: FastifyInstance,
  { metrics },
) => {
  app.get('/metrics', async (_request, reply) => {
    const body = await metrics.registry.metrics();
    return reply.header('Content-Type', metrics.registry.contentType).send(body);
  });
};
