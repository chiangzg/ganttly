/**
 * MCP Streamable HTTP endpoint (spec §10), mounted at `/mcp`.
 *
 * Stateless: one shared {@link McpServer} + {@link StreamableHTTPServerTransport}
 * serve every request (no session id). Each request is authenticated by a
 * Bearer PAT (resolved to an {@link AuthPrincipal} and attached to the raw Node
 * request as `auth`, which the SDK forwards to tool handlers as `extra.authInfo`).
 *
 * DNS-rebinding defence: the Host header must match an allowed hostname.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { ApiErrorCode } from '@ganttly/api-contract';
import { resolvePatPrincipal } from '../auth/pat';
import { createMcpServer, type McpHandle } from '../modules/mcp/server';
import { ProjectApplicationService, type ProjectLimits } from '../modules/projects/service';
import { DEFAULT_LIMITS } from '@ganttly/api-contract';

export interface McpRoutesOptions {
  config: AppConfig;
}

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (
  app: FastifyInstance,
  { config },
) => {
  if (!app.hasDecorator('db')) {
    // MCP needs the database; skip registration when no pool is attached.
    return;
  }
  const db: Db = app.db;
  const limits: ProjectLimits = {
    maxProjectBytes: config.maxProjectBytes,
    maxProjectTasks: config.maxProjectTasks,
    maxProjectResources: DEFAULT_LIMITS.maxProjectResources,
    maxProjectBaselines: DEFAULT_LIMITS.maxProjectBaselines,
  };
  const service = new ProjectApplicationService(db, limits);
  const handle: McpHandle = createMcpServer({ db, service });
  // One shared server+transport for all stateless requests.
  await handle.server.connect(handle.transport);

  app.all('/mcp', async (request, reply) => {
    // --- DNS-rebinding defence (spec §13) -----------------------------------
    const host = request.host.split(':')[0] ?? '';
    if (!config.allowedMcpHosts.has(host)) {
      return reply.code(403).send({ error: 'Forbidden host' });
    }

    // --- Bearer PAT authentication ------------------------------------------
    const authorization = request.headers.authorization;
    const principal = await resolvePatPrincipal(db, authorization, config.tokenPepper);
    if (!principal) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send(buildApiError(ApiErrorCode.AUTH_REQUIRED, 'A valid PAT is required', request.id));
    }
    // Forward the principal to tool handlers via the SDK's auth channel.
    Object.assign(request.raw, { auth: principal });

    // --- Delegate to the stateless transport --------------------------------
    // Pass the already-parsed body so the transport does not re-read the
    // consumed Fastify stream.
    await handle.transport.handleRequest(request.raw, reply.raw, request.body);
  });
};

function buildApiError(code: ApiErrorCode, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}
