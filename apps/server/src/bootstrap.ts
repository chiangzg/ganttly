/**
 * Server composition root (spec §3.2 `bootstrap.ts`).
 *
 * Wires CORS, observability, the optional database pool, health and instance
 * discovery. Returning the unbuilt-then-built instance lets tests use Fastify
 * `inject()` without binding a port.
 */
import { API_PREFIX, ApiErrorCode, buildApiError, errorCodeToStatus } from '@ganttly/api-contract';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config';
import type { GitHubOAuthDeps } from './auth/github';
import { HttpError } from './modules/errors';
import { createWorkspaceEventBus } from './modules/events/bus';
import { createOutboxPublisher, type OutboxPublisher } from './modules/events/publisher';
import { collectOutboxMetrics, createMetrics } from './modules/metrics';
import authPlugin from './plugins/auth';
import databasePlugin from './plugins/database';
import { observabilityPlugin } from './plugins/observability';
import webStaticPlugin from './plugins/webStatic';
import { authRoutes } from './routes/auth';
import { eventsRoutes } from './routes/events';
import { healthRoutes } from './routes/health';
import { identityRoutes } from './routes/identity';
import { instanceRoutes } from './routes/instance';
import { mcpRoutes } from './routes/mcp';
import { metricsRoutes } from './routes/metrics';
import { patRoutes } from './routes/pats';
import { projectsRoutes } from './routes/projects';

declare module 'fastify' {
  interface FastifyInstance {
    /** Number of migration SQL files shipped with the image (health/ready). */
    expectedMigrationCount?: number;
  }
}

/**
 * Count the `*.sql` files shipped under `apps/server/drizzle`. Resolved relative
 * to this module so it holds for both the tsx-run source (`src/bootstrap.ts`)
 * and the esbuild bundle (single `dist/server.js`, same parent dir → same
 * `../drizzle`). Decorated onto the instance for the `/health/ready` check.
 */
function countShippedMigrations(): number {
  const drizzleDir = fileURLToPath(new URL('../drizzle', import.meta.url));
  try {
    return readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

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

  // Map domain HttpErrors onto the shared ApiErrorResponse body; the rate
  // limiter throws a 429 (Retry-After already set by the plugin); anything else
  // is an unexpected failure logged as a 500 with a plain body.
  app.setErrorHandler(async (err, request, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(errorCodeToStatus[err.code])
        .send(buildApiError(err.code, err.message, request.id, err.details));
    }
    if (err instanceof Error && (err as { statusCode?: number }).statusCode === 429) {
      metrics.rateLimitedTotal.inc();
      return reply
        .code(429)
        .send(buildApiError(ApiErrorCode.RATE_LIMITED, 'Rate limit exceeded', request.id));
    }
    request.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ status: 'error', message: 'Internal server error', requestId: request.id });
  });

  await app.register(cors, {
    // No credentialed cross-origin traffic is allowed when no origins are
    // configured; the web app's origin must be whitelisted explicitly.
    origin: config.allowedWebOrigins.length ? config.allowedWebOrigins : false,
    credentials: true,
  });

  // Prometheus metrics (spec §15). Decorated so routes (SSE/MCP) can record
  // business counters; /metrics exposes the registry text.
  const metrics = createMetrics(config.instanceId);
  app.decorate('metrics', metrics);

  // Rate limiting (spec §15): a global per-IP cap. On exceed the plugin throws
  // (having already set the Retry-After header); the shared error handler maps
  // that onto a RATE_LIMITED ApiErrorResponse.
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: `${config.rateLimitWindowSeconds}s`,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'retry-after': true },
  });

  await app.register(observabilityPlugin, { instanceId: config.instanceId, metrics });

  // Stateless session cookie + principal resolution. Registered before routes
  // so `request.principal` is available to every handler.
  await app.register(authPlugin, {
    sessionSecret: config.sessionSecret,
    secureCookies: config.sessionCookieSecure,
  });

  if (options.registerDatabase !== false) {
    await app.register(databasePlugin, { databaseUrl: config.databaseUrl });
  }

  // Event bus + outbox publisher (spec §11). The bus is decorated onto the
  // instance so the SSE route (PR6/2) can subscribe; the publisher is started
  // once the server is listening and stopped before the pool closes.
  const bus = createWorkspaceEventBus();
  let publisher: OutboxPublisher | null = null;
  app.decorate('bus', bus);
  if (options.registerDatabase !== false) {
    publisher = createOutboxPublisher(app.db, bus, {
      pollIntervalMs: config.outboxPollIntervalMs,
      batchSize: config.outboxBatchSize,
      retentionDays: config.outboxRetentionDays,
      lagAlertThreshold: config.outboxLagAlertThreshold,
      maintenanceIntervalMs: config.outboxMaintenanceIntervalMs,
      logger: app.log,
    });
    app.addHook('onReady', async () => publisher?.start());
    app.addHook('onClose', async () => publisher?.stop());
  }
  app.addHook('onClose', async () => bus.close());

  await app.register(healthRoutes);
  await app.register(instanceRoutes, { config });

  // API surface lives under /api/v1 (matches the advertised apiBaseUrl).
  await app.register(authRoutes, {
    prefix: API_PREFIX,
    config,
    githubDeps: options.githubDeps,
  });
  await app.register(identityRoutes, { prefix: API_PREFIX });
  await app.register(projectsRoutes, { prefix: API_PREFIX, config });
  await app.register(patRoutes, { prefix: API_PREFIX, config });
  await app.register(eventsRoutes, { prefix: API_PREFIX });
  // MCP lives at the root (/mcp), not under /api/v1.
  await app.register(mcpRoutes, { config });

  // Prometheus scrape endpoint (gated by config; no auth).
  if (config.metricsEnabled) {
    await app.register(metricsRoutes, { metrics });
  }

  // Periodically sample the outbox backlog into the metrics gauges.
  if (options.registerDatabase !== false) {
    let metricsTimer: ReturnType<typeof setInterval> | null = null;
    app.addHook('onReady', async () => {
      metricsTimer = setInterval(
        () => void collectOutboxMetrics(app.db, metrics),
        config.outboxMaintenanceIntervalMs,
      );
      metricsTimer.unref?.();
    });
    app.addHook('onClose', async () => {
      if (metricsTimer) clearInterval(metricsTimer);
    });
  }

  // Expose the shipped migration count so /health/ready can detect a DB that
  // has not yet been migrated up to the image's version.
  app.decorate('expectedMigrationCount', countShippedMigrations());

  // Same-origin Web hosting (spec §14.2). Registered LAST so the API/MCP/health/
  // discovery/metrics routes win over its wildcard; the plugin's not-found
  // handler gives browser navigation an SPA shell while keeping API 404s JSON.
  if (config.webDistDir && existsSync(config.webDistDir)) {
    await app.register(webStaticPlugin, { root: config.webDistDir });
  }

  return app;
}
