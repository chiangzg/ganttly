/**
 * Health probes (spec §14.2).
 *
 * - `GET /health/live` — liveness; never touches external dependencies. A 200
 *   here means the process is running and serving. It MUST NOT depend on GitHub
 *   or the database, so a transient DB outage does not get the pod killed.
 * - `GET /health/ready` — readiness; verifies the database connection with a
 *   trivial round-trip. Returns 503 when the database is unreachable or not
 *   attached (e.g. a minimal unit-test build), so load balancers stop sending
 *   traffic.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/health/live', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/health/ready', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!app.hasDecorator('db')) {
      return reply.code(503).send({ status: 'error', checks: { database: 'unavailable' } });
    }
    try {
      await app.db.execute(sql`select 1`);
      return reply.code(200).send({ status: 'ok', checks: { database: 'ok' } });
    } catch (err) {
      app.log.error({ err }, 'health/ready database check failed');
      return reply.code(503).send({ status: 'error', checks: { database: 'fail' } });
    }
  });
};
