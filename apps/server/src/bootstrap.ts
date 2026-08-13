/**
 * Server composition root (spec §3.2 `bootstrap.ts`).
 *
 * Wires CORS, observability, the optional database pool, health and instance
 * discovery. Returning the unbuilt-then-built instance lets tests use Fastify
 * `inject()` without binding a port.
 */
import { API_PREFIX } from '@ganttly/api-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config';
import type { GitHubOAuthDeps } from './auth/github';
import authPlugin from './plugins/auth';
import databasePlugin from './plugins/database';
import { observabilityPlugin } from './plugins/observability';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { instanceRoutes } from './routes/instance';

export interface BuildServerOptions {
  /**
   * Register the Drizzle pool. Default `true`. Tests that exercise pure routes
   * (e.g. /health/live, discovery) pass `false` to avoid opening a connection.
   */
  registerDatabase?: boolean;
  /**
   * Override the GitHub OAuth network layer (tests inject fakes so the callback
   * can be exercised without hitting GitHub). Defaults to the global-`fetch`
   * implementation configured from `GITHUB_OAUTH_CLIENT_*`.
   */
  githubDeps?: GitHubOAuthDeps;
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

  // Stateless session cookie + principal resolution. Registered before routes
  // so `request.principal` is available to every handler.
  await app.register(authPlugin, {
    sessionSecret: config.sessionSecret,
    secureCookies: config.isProduction,
  });

  if (options.registerDatabase !== false) {
    await app.register(databasePlugin, { databaseUrl: config.databaseUrl });
  }

  await app.register(healthRoutes);
  await app.register(instanceRoutes, { config });

  // API surface lives under /api/v1 (matches the advertised apiBaseUrl).
  await app.register(authRoutes, {
    prefix: API_PREFIX,
    config,
    githubDeps: options.githubDeps,
  });

  return app;
}
