/**
 * Same-origin static hosting for the Web client (spec §14.2).
 *
 * When `WEB_DIST_DIR` points at the built `apps/web/dist`, the server serves
 * those assets itself so a single container can host the client + API + MCP +
 * SSE on one origin — the default session-cookie SameSite=Lax then works with
 * zero CORS friction.
 *
 * Behaviour:
 * - Existing files under `root` are served verbatim (hashed assets get a long
 *   max-age; `index.html` is always `no-cache` so SPA updates land).
 * - Anything else (a client-side route like `/projects/abc`) falls through to a
 *   shared not-found handler that returns the SPA shell — EXCEPT paths under the
 *   API/MCP/health/discovery/metrics prefixes, which keep returning a JSON
 *   {@link ApiErrorResponse} so API clients never silently receive HTML.
 */
import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { ApiErrorCode, buildApiError } from '@ganttly/api-contract';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

export interface WebStaticOptions {
  /** Absolute path to the built Web assets (the directory containing index.html). */
  root: string;
}

/** Path prefixes that must always answer JSON, never the SPA shell. */
const JSON_ONLY_PREFIXES = ['/api/', '/mcp', '/health', '/.well-known', '/metrics'];

function isJsonOnlyPath(rawUrl: string): boolean {
  const path = rawUrl.split('?')[0]!;
  return JSON_ONLY_PREFIXES.some((p) => path === p || path.startsWith(p));
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const webStaticPlugin: FastifyPluginCallback<WebStaticOptions> = (app, options) => {
  app.register(fastifyStatic, {
    root: options.root,
    prefix: '/',
    decorateReply: true,
    // Long cache for hashed assets; index.html is forced no-cache below.
    maxAge: ONE_YEAR_SECONDS * 1000,
    setHeaders(res, pathName) {
      if (pathName.endsWith('index.html')) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  });

  // Shared not-found handler: SPA fallback for browser navigation, JSON for API
  // routes and non-GET requests. @fastify/static calls reply.callNotFound() when
  // a requested file does not exist, landing here too.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' || isJsonOnlyPath(request.url)) {
      return reply
        .code(404)
        .send(buildApiError(ApiErrorCode.NOT_FOUND, 'Route not found', request.id));
    }
    return reply.sendFile('index.html');
  });
};

export default fp(webStaticPlugin, { name: 'web-static' });
