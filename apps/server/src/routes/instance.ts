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
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';

export interface InstanceRoutesOptions {
  config: AppConfig;
}

export const instanceRoutes: FastifyPluginAsync<InstanceRoutesOptions> = async (
  app: FastifyInstance,
  { config },
) => {
  app.get('/.well-known/ganttly-instance', async (_req: FastifyRequest, reply: FastifyReply) => {
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
  });
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
    },
    events: {
      transport: 'sse',
      url: `${apiBase}/events`,
    },
    apiVersions: ['v1'],
    minClientVersion: '0.6.0',
    features: {
      projectImport: true,
      mcp: false, // PR5 wires the MCP endpoint.
      sse: false, // PR6 wires the SSE endpoint.
      teamWorkspaces: false,
    },
  };
}
