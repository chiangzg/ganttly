/**
 * Health probes (spec §14.2).
 *
 * - `GET /health/live` — liveness; never touches external dependencies. A 200
 *   here means the process is running and serving. It MUST NOT depend on GitHub
 *   or the database, so a transient DB outage does not get the pod killed.
 * - `GET /health/ready` — readiness; verifies the database connection with a
 *   trivial round-trip AND that the applied Drizzle migration count matches the
 *   migrations shipped with the image. Returns 503 when the database is
 *   unreachable, not attached, or behind on migrations, so load balancers stop
 *   sending traffic until `pnpm migrate` has caught up.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

interface ReadyCheckRow {
  n: number;
}

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
    } catch (err) {
      app.log.error({ err }, 'health/ready database check failed');
      return reply.code(503).send({ status: 'error', checks: { database: 'fail' } });
    }

    // Migration version check (spec §14.2): the applied migration count must
    // match the SQL files shipped with the image. Behind → 503 so traffic stops
    // until the explicit `pnpm migrate` release step runs.
    const expected = app.expectedMigrationCount ?? 0;
    let applied = -1;
    try {
      const rows = (await app.db.execute(
        sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
      )) as unknown as ReadyCheckRow[];
      applied = rows[0] ? Number(rows[0].n) : 0;
    } catch (err) {
      // The migrations table does not exist yet — DB reachable but never migrated.
      app.log.error({ err }, 'health/ready migration check failed');
      return reply
        .code(503)
        .send({ status: 'error', checks: { database: 'ok', migrations: 'missing' } });
    }
    if (applied < expected) {
      return reply.code(503).send({
        status: 'error',
        checks: { database: 'ok', migrations: 'behind', expected, applied },
      });
    }
    return reply.code(200).send({ status: 'ok', checks: { database: 'ok', migrations: 'ok' } });
  });
};
