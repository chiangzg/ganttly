/**
 * PAT management routes (spec §8.3), mounted under `/api/v1`:
 *   POST   /me/tokens        create a PAT (returns plaintext once)
 *   GET    /me/tokens        list the caller's tokens (no secrets)
 *   DELETE /me/tokens/:patId revoke a token
 *
 * These routes are authenticated by the Web session cookie (the user manages
 * their own tokens from the settings UI). MCP callers never reach here — they
 * authenticate with a Bearer PAT against `/mcp` instead.
 */
import { ApiErrorCode, createPatRequestSchema } from '@ganttly/api-contract';
import type { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { requirePrincipal } from '../modules/access';
import { HttpError } from '../modules/errors';
import { PatApplicationService } from '../modules/pats/service';

export interface PatRoutesOptions {
  config: AppConfig;
}

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      ApiErrorCode.VALIDATION_FAILED,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

export const patRoutes: FastifyPluginAsync<PatRoutesOptions> = async (
  app: FastifyInstance,
  { config },
) => {
  function db(): Db {
    if (!app.hasDecorator('db')) {
      throw new HttpError(ApiErrorCode.UNSUPPORTED_CLIENT, 'database unavailable');
    }
    return app.db;
  }

  function service(): PatApplicationService {
    return new PatApplicationService(db(), config.tokenPepper);
  }

  // --- POST /me/tokens ------------------------------------------------------
  app.post('/me/tokens', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseBody(createPatRequestSchema, request.body);
    const result = await service().createPat(principal.userId, body, config.patDefaultTtlDays);
    return reply.send(result);
  });

  // --- GET /me/tokens -------------------------------------------------------
  app.get('/me/tokens', async (request, reply) => {
    const principal = requirePrincipal(request);
    const tokens = await service().listPats(principal.userId);
    return reply.send({ tokens });
  });

  // --- DELETE /me/tokens/:patId --------------------------------------------
  app.delete('/me/tokens/:patId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { patId } = request.params as { patId: string };
    await service().revokePat(principal.userId, patId);
    return reply.code(204).send();
  });
};
