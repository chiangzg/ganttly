/**
 * Project routes (spec §9.3), mounted under `/api/v1`.
 *
 *   GET    /workspaces/:workspaceId/projects                       list (viewer+)
 *   POST   /workspaces/:workspaceId/projects                       create (editor+)
 *   POST   /workspaces/:workspaceId/projects/import                import (editor+)
 *   GET    /workspaces/:workspaceId/projects/:projectId            get (viewer+)
 *   PUT    /workspaces/:workspaceId/projects/:projectId            save (editor+)
 *   POST   /workspaces/:workspaceId/projects/:projectId/commands   command (editor+)
 *   POST   /workspaces/:workspaceId/projects/:projectId/archive    archive (editor+)
 *   POST   /workspaces/:workspaceId/projects/:projectId/restore    restore (editor+)
 *   DELETE /workspaces/:workspaceId/projects/:projectId            permanent delete (owner)
 *
 * Membership + role gating happens in the service / {@link requireMembership};
 * non-members get 404 (no existence leak). Reads go through the repository;
 * mutations through {@link ProjectApplicationService}, the shared §7.1 core.
 */
import {
  ApiErrorCode,
  DEFAULT_LIMITS,
  applyCommandRequestSchema,
  createProjectRequestSchema,
  importProjectRequestSchema,
  listProjectsQuerySchema,
  saveProjectRequestSchema,
} from '@ganttly/api-contract';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppConfig } from '../config';
import type { Db } from '../db/client';
import { requireMembership, requirePrincipal } from '../modules/access';
import { HttpError } from '../modules/errors';
import { ProjectApplicationService, type ProjectLimits } from '../modules/projects/service';
import { buildSnapshot, getProjectRow, listProjectRows } from '../modules/projects/repository';
import { buildSummary } from '../modules/projects/summary';

export interface ProjectsRoutesOptions {
  config: AppConfig;
}

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || typeof key !== 'string') {
    throw new HttpError(
      ApiErrorCode.VALIDATION_FAILED,
      'Idempotency-Key header is required for this request',
    );
  }
  return key;
}

function ifMatchRevision(request: FastifyRequest): string {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw new HttpError(ApiErrorCode.VALIDATION_FAILED, 'If-Match header is required');
  }
  return value.replace(/^"|"$/g, '');
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

export const projectsRoutes: FastifyPluginAsync<ProjectsRoutesOptions> = async (
  app: FastifyInstance,
  { config },
) => {
  /** The pool, or 503 if no database is attached (keeps non-DB tests honest). */
  function db(): Db {
    if (!app.hasDecorator('db')) {
      throw new HttpError(ApiErrorCode.UNSUPPORTED_CLIENT, 'database unavailable');
    }
    return app.db;
  }

  function service(): ProjectApplicationService {
    const limits: ProjectLimits = {
      maxProjectBytes: config.maxProjectBytes,
      maxProjectTasks: config.maxProjectTasks,
      maxProjectResources: DEFAULT_LIMITS.maxProjectResources,
      maxProjectBaselines: DEFAULT_LIMITS.maxProjectBaselines,
    };
    return new ProjectApplicationService(db(), limits);
  }

  // --- list -----------------------------------------------------------------
  app.get('/workspaces/:workspaceId/projects', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId } = request.params as { workspaceId: string };
    const query = parseBody(listProjectsQuerySchema, request.query);
    await requireMembership(db(), principal, workspaceId, 'viewer');
    const rows = await listProjectRows(db(), workspaceId, query);
    return reply.send({ projects: rows.map(buildSummary) });
  });

  // --- create ---------------------------------------------------------------
  app.post('/workspaces/:workspaceId/projects', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId } = request.params as { workspaceId: string };
    const body = parseBody(createProjectRequestSchema, request.body);
    const snapshot = await service().createProject({
      principal,
      workspaceId,
      file: body.file,
      idempotencyKey: idempotencyKey(request),
      requestId: request.id,
    });
    return reply.code(201).send(snapshot);
  });

  // --- import ---------------------------------------------------------------
  app.post('/workspaces/:workspaceId/projects/import', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId } = request.params as { workspaceId: string };
    const body = parseBody(importProjectRequestSchema, request.body);
    const snapshot = await service().createProject({
      principal,
      workspaceId,
      file: body.file,
      name: body.name,
      sourceType: 'import',
      sourceClientId: body.sourceClientId,
      idempotencyKey: idempotencyKey(request),
      requestId: request.id,
    });
    return reply.code(201).send(snapshot);
  });

  // --- get (returns ETag) ---------------------------------------------------
  app.get('/workspaces/:workspaceId/projects/:projectId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId, projectId } = request.params as {
      workspaceId: string;
      projectId: string;
    };
    await requireMembership(db(), principal, workspaceId, 'viewer', projectId);
    const row = await getProjectRow(db(), workspaceId, projectId);
    if (!row) {
      throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
    }
    const snapshot = buildSnapshot(row);
    void reply.header('ETag', `"${snapshot.revision}"`);
    return reply.send(snapshot);
  });

  // --- save (PUT, If-Match) -------------------------------------------------
  app.put('/workspaces/:workspaceId/projects/:projectId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId, projectId } = request.params as {
      workspaceId: string;
      projectId: string;
    };
    const body = parseBody(saveProjectRequestSchema, request.body);
    const snapshot = await service().saveDocument({
      principal,
      workspaceId,
      projectId,
      file: body.file,
      expectedRevision: ifMatchRevision(request),
      idempotencyKey: request.headers['idempotency-key'] ? idempotencyKey(request) : undefined,
      requestId: request.id,
    });
    void reply.header('ETag', `"${snapshot.revision}"`);
    return reply.send(snapshot);
  });

  // --- structured command ---------------------------------------------------
  app.post('/workspaces/:workspaceId/projects/:projectId/commands', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId, projectId } = request.params as {
      workspaceId: string;
      projectId: string;
    };
    const body = parseBody(applyCommandRequestSchema, request.body);
    const response = await service().applyCommand({
      principal,
      workspaceId,
      projectId,
      command: body.command,
      idempotencyKey: idempotencyKey(request),
      requestId: request.id,
    });
    return reply.send(response);
  });

  // --- archive --------------------------------------------------------------
  app.post('/workspaces/:workspaceId/projects/:projectId/archive', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId, projectId } = request.params as {
      workspaceId: string;
      projectId: string;
    };
    const snapshot = await service().archive({
      principal,
      workspaceId,
      projectId,
      idempotencyKey: idempotencyKey(request),
      requestId: request.id,
    });
    return reply.send(snapshot);
  });

  // --- restore --------------------------------------------------------------
  app.post('/workspaces/:workspaceId/projects/:projectId/restore', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId, projectId } = request.params as {
      workspaceId: string;
      projectId: string;
    };
    const snapshot = await service().restore({
      principal,
      workspaceId,
      projectId,
      idempotencyKey: idempotencyKey(request),
      requestId: request.id,
    });
    return reply.send(snapshot);
  });

  // --- permanent delete (owner only, must be archived) ----------------------
  app.delete('/workspaces/:workspaceId/projects/:projectId', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { workspaceId, projectId } = request.params as {
      workspaceId: string;
      projectId: string;
    };
    await service().deletePermanently({
      principal,
      workspaceId,
      projectId,
      requestId: request.id,
    });
    return reply.code(204).send();
  });
};
