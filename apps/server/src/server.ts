/**
 * Server entry (`pnpm start` / `pnpm dev`).
 *
 * Loads configuration (fail-fast before binding), builds the Fastify instance,
 * listens on the configured port and drains gracefully on SIGTERM/SIGINT.
 *
 * Migrations are an explicit release step (spec §14.1) — this process does NOT
 * auto-migrate on boot; run `pnpm migrate` first during deploy.
 */
import { buildServer } from './bootstrap';
import { loadConfig } from './config';

async function main(): Promise<void> {
  // Fail fast: invalid config must never bind a port or serve traffic.
  const config = loadConfig();
  const app = await buildServer(config);

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'server failed to start');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // ConfigError or listen failure before logger exists lands here.
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
