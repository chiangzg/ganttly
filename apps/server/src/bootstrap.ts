/**
 * Server composition root (spec §3.2 `bootstrap.ts`).
 *
 * Wires CORS, observability, the optional database pool, health and instance
 * discovery. Returning the unbuilt-then-built instance lets tests use Fastify
 * `inject()` without binding a port.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config';
import databasePlugin from './plugins/database';
import { observabilityPlugin } from './plugins/observability';
import { healthRoutes } from './routes/health';
import { instanceRoutes } from './routes/instance';

export interface BuildServerOptions {
  /**
   * Register the Drizzle pool. Default `true`. Tests that exercise pure routes
   * (e.g. /health/live, discovery) pass `false` to avoid opening a connection.
   */
  registerDatabase?: boolean;
}

export async function buildServer(
  config: AppConfig,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Tag every log line with the stable instance id (spec §15). pino keeps
      // pid/hostname when `base` is an object; only `base: null` drops them.
      base: { instance_id: config.instanceId },
    },
    requestIdHeader: 'x-request-id',
    // 10 MiB matches the project document limit (spec §9.4); routes enforce the
    // finer-grained task/batch limits themselves.
    bodyLimit: config.maxProjectBytes,
  });

  await app.register(cors, {
    // No credentialed cross-origin traffic is allowed when no origins are
    // configured; the web app's origin must be whitelisted explicitly.
    origin: config.allowedWebOrigins.length ? config.allowedWebOrigins : false,
    credentials: true,
  });

  await app.register(observabilityPlugin, { instanceId: config.instanceId });

  if (options.registerDatabase !== false) {
    await app.register(databasePlugin, { databaseUrl: config.databaseUrl });
  }

  await app.register(healthRoutes);
  await app.register(instanceRoutes, { config });

  return app;
}
