/**
 * Database plugin — decorates the Fastify instance with a Drizzle {@link Db}
 * pool and closes it cleanly on shutdown (spec §3.2 `plugins/database.ts`).
 *
 * Registration is optional so the health/live route and pure unit tests can
 * build a server without a database connection.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createDb, type Db } from '../db/client';

export interface DatabasePluginOptions {
  databaseUrl: string;
  /** Max pool connections; defaults to 10 for the API. */
  max?: number;
}

const databasePlugin = fp(
  async (app: FastifyInstance, options: DatabasePluginOptions) => {
    const db: Db = createDb(options.databaseUrl, { max: options.max ?? 10 });
    app.decorate('db', db);
    app.addHook('onClose', async () => {
      await db.$client.end({ timeout: 5 });
    });
  },
  { name: 'database' },
);

export default databasePlugin;

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}
