/**
 * Instance discovery (spec §8.1).
 *
 * Serves `GET /.well-known/ganttly-instance` — a fully public descriptor that
 * lets the Web workspace switcher (or an MCP host adding a self-hosted
 * instance) confirm the URL speaks the ganttly protocol before any auth flow.
 *
 * The descriptor is assembled from server config and re-validated against the
 * shared {@link instanceDiscoverySchema} before responding, so a misconfigured
 * instance fails loudly instead of emitting an invalid document.
 */
import {
  INSTANCE_PROTOCOL,
  INSTANCE_PROTOCOL_VERSION,
  type InstanceDiscovery,
  instanceDiscoverySchema,
} from '@ganttly/api-contract';
import type { FastifyCorsOptions } from '@fastify/cors';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Per-route @fastify/cors override, merged over the global options. */
    cors?: FastifyCorsOptions;
  }
}

export interface InstanceRoutesOptions {
  config: AppConfig;
}

export const instanceRoutes: FastifyPluginAsync<InstanceRoutesOptions> = async (
  app: FastifyInstance,
  { config },
) => {
  // The discovery descriptor is public read-only metadata: a browser client
  // must be able to read it from ANY web origin (GitHub Pages frontend, local
  // dev) before the operator can allowlist that origin for credentialed
  // traffic via ALLOWED_WEB_ORIGINS. @fastify/cors supports a per-route
  // `config.cors` override (it cannot be registered twice), so these two
  // routes open a reflected-Origin, credentials-free CORS scope while the
  // global credentialed allowlist for /api/v1 stays untouched. The OPTIONS
  // route only carries that config — the global preflight hook replies to
  // valid preflights before any handler runs.
  const discoveryCors = { origin: true, credentials: false, methods: 'GET,HEAD,OPTIONS' };

  app.options(
    '/.well-known/ganttly-instance',
    { config: { cors: discoveryCors } },
    async (_req: FastifyRequest, reply: FastifyReply) => reply.code(204).send(),
  );

  app.get(
    '/.well-known/ganttly-instance',
    { config: { cors: discoveryCors } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const descriptor: InstanceDiscovery = buildDiscovery(config);
      const parsed = instanceDiscoverySchema.safeParse(descriptor);
      if (!parsed.success) {
        app.log.error(
          { descriptor, issues: parsed.error.issues },
          'instance descriptor failed its own contract — check PUBLIC_BASE_URL/WEB_APP_URL config',
        );
        return reply.code(500).send({ status: 'error' });
      }
      return reply.code(200).send(parsed.data);
    },
  );
};

/**
 * Pure builder so tests can assert the descriptor shape without a live server.
 * Derives all URLs from {@link AppConfig.publicBaseUrl}.
 */
export function buildDiscovery(config: AppConfig): InstanceDiscovery {
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  const apiBase = `${base}/api/v1`;
  return {
    protocol: INSTANCE_PROTOCOL,
    protocolVersion: INSTANCE_PROTOCOL_VERSION,
    instanceId: config.instanceId,
    displayName: config.instanceName,
    baseUrl: base,
    apiBaseUrl: apiBase,
    webAppUrl: config.webAppUrl,
    mcp: {
      url: `${base}/mcp`,
      transport: 'streamable-http',
      authMethods: ['pat'],
    },
    auth: {
      browserModes: ['session'],
      providers: ['github'],
      devLogin: config.authMode === 'dev',
    },
    events: {
      transport: 'sse',
      url: `${apiBase}/events`,
    },
    apiVersions: ['v1'],
    minClientVersion: '0.6.0',
    features: {
      projectImport: true,
      mcp: true,
      sse: true,
      teamWorkspaces: false,
    },
  };
}
