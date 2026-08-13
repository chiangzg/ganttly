/**
 * ProjectApplicationService (spec §7 / §19) — the single transactional chokepoint
 * shared by the Web REST API and (later) MCP tool calls.
 *
 * Every mutation runs the §7.1 flow inside one PostgreSQL transaction:
 *   membership check → idempotency replay → normalize + strip viewState →
 *   AJV validate → limit checks → SELECT ... FOR UPDATE → If-Match compare →
 *   write file_jsonb + summary_jsonb + revision → project_operations →
 *   outbox_events → COMMIT.
 *
 * Project + operation + outbox commit atomically; a failure rolls back all
 * three. The outbox rows are written here (PR3); the publisher/SSE consumer is
 * PR6.
 */
import { and, eq } from 'drizzle-orm';
import { ApiErrorCode } from '@ganttly/api-contract';
import type { ApplyCommandResponse, ProjectSnapshotResponse } from '@ganttly/api-contract';
import {
  type GanttlyFile,
  formatAjvErrors,
  normalizeFile,
  validateGanttlyFile,
} from '@ganttly/schema';
import { applyProjectCommand, type ProjectCommand } from '@ganttly/domain';
import { type AuthPrincipal, operationActorType } from '../../auth/principal';
import type { Db, Tx } from '../../db/client';
import { outboxEvents, projectOperations, projects } from '../../db/schema';
import { newEventId, newOperationId, newProjectId } from '../../id';
import { requireMembership } from '../access';
import { HttpError } from '../errors';
import { canonicalRequestHash } from './idempotency';
import { buildSnapshot } from './repository';
import { computeProjectStats } from './summary';
import { withDefaultViewState } from './viewState';

/** Limits enforced per project document (spec §9.4). */
export interface ProjectLimits {
  maxProjectBytes: number;
  maxProjectTasks: number;
  maxProjectResources: number;
  maxProjectBaselines: number;
}

export interface CreateProjectParams {
  principal: AuthPrincipal;
  workspaceId: string;
  /** Untyped document body; validated inside the transaction. */
  file: unknown;
  /**
   * Optional project name override (import flow sends a user-edited name that
   * may differ from `file.project.name`). When set, it becomes both the stored
   * `projects.name` and `file.project.name`.
   */
  name?: string;
  sourceType?: string;
  sourceClientId?: string;
  idempotencyKey?: string;
  requestId: string;
}

export interface SaveProjectParams {
  principal: AuthPrincipal;
  workspaceId: string;
  projectId: string;
  file: unknown;
  /** Expected revision, from the `If-Match` header. */
  expectedRevision: string;
  idempotencyKey?: string;
  requestId: string;
}

export interface ApplyCommandParams {
  principal: AuthPrincipal;
  workspaceId: string;
  projectId: string;
  command: unknown;
  idempotencyKey?: string;
  requestId: string;
}

export interface ProjectMutationParams {
  principal: AuthPrincipal;
  workspaceId: string;
  projectId: string;
  idempotencyKey?: string;
  requestId: string;
}

export class ProjectApplicationService {
  constructor(
    private readonly db: Db,
    private readonly limits: ProjectLimits,
  ) {}

  // --- create / import ------------------------------------------------------
  async createProject(params: CreateProjectParams): Promise<ProjectSnapshotResponse> {
    const requestHash = canonicalRequestHash(params.file);
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, params.principal, params.workspaceId, 'editor');
      const replayed = await this.tryReplay(
        tx,
        params.principal,
        params.workspaceId,
        params.idempotencyKey,
        requestHash,
      );
      if (replayed) return replayed as ProjectSnapshotResponse;

      const file = this.canonicalizeAndValidate(params.file);
      this.checkLimits(file);
      if (params.name !== undefined) {
        file.project = { ...file.project, name: params.name };
      }

      const now = new Date();
      const createdAt = now.toISOString();
      const canonical: GanttlyFile = {
        ...file,
        meta: { ...file.meta, createdAt, updatedAt: createdAt },
      };
      const stats = computeProjectStats(canonical);
      const projectId = newProjectId();
      await tx.insert(projects).values({
        id: projectId,
        workspaceId: params.workspaceId,
        name: canonical.project.name,
        fileJsonb: canonical,
        summaryJsonb: stats,
        revision: 1,
        sourceType: params.sourceType ?? null,
        sourceClientId: params.sourceClientId ?? null,
        createdBy: params.principal.userId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const snapshot = await this.snapshotAndRecord(tx, {
        workspaceId: params.workspaceId,
        projectId,
        principal: params.principal,
        action: params.sourceType ? 'import' : 'create',
        requestHash,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: null,
        resultRevision: 1,
        summary: { stats },
        outboxType: 'project.created',
        outboxPayload: { projectId, name: canonical.project.name },
        requestId: params.requestId,
      });
      return snapshot;
    });
  }

  // --- save (PUT whole document) --------------------------------------------
  async saveDocument(params: SaveProjectParams): Promise<ProjectSnapshotResponse> {
    const requestHash = canonicalRequestHash(params.file);
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, params.principal, params.workspaceId, 'editor');
      const replayed = await this.tryReplay(
        tx,
        params.principal,
        params.workspaceId,
        params.idempotencyKey,
        requestHash,
      );
      if (replayed) return replayed as ProjectSnapshotResponse;

      const file = this.canonicalizeAndValidate(params.file);
      this.checkLimits(file);

      const locked = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, params.projectId), eq(projects.workspaceId, params.workspaceId)))
        .for('update')
        .limit(1);
      const row = locked[0];
      if (!row) {
        throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
      }
      if (String(row.revision) !== params.expectedRevision) {
        throw new HttpError(ApiErrorCode.REVISION_CONFLICT, 'Project revision conflict', {
          actualRevision: String(row.revision),
        });
      }

      const original = row.fileJsonb as GanttlyFile;
      const now = new Date();
      const canonical: GanttlyFile = {
        ...file,
        meta: { ...file.meta, createdAt: original.meta.createdAt, updatedAt: now.toISOString() },
      };
      const stats = computeProjectStats(canonical);
      const newRevision = row.revision + 1;
      await tx
        .update(projects)
        .set({ fileJsonb: canonical, summaryJsonb: stats, revision: newRevision, updatedAt: now })
        .where(eq(projects.id, params.projectId));

      const snapshot = await this.snapshotAndRecord(tx, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        principal: params.principal,
        action: 'save',
        requestHash,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: newRevision,
        summary: { stats },
        outboxType: 'project.updated',
        outboxPayload: { projectId: params.projectId, revision: newRevision },
        requestId: params.requestId,
      });
      return snapshot;
    });
  }

  // --- structured command (POST /commands; shared with MCP in PR5) ----------
  async applyCommand(params: ApplyCommandParams): Promise<ApplyCommandResponse> {
    const requestHash = canonicalRequestHash(params.command);
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, params.principal, params.workspaceId, 'editor');
      const replayed = await this.tryReplay(
        tx,
        params.principal,
        params.workspaceId,
        params.idempotencyKey,
        requestHash,
      );
      if (replayed) return replayed as ApplyCommandResponse;

      const locked = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, params.projectId), eq(projects.workspaceId, params.workspaceId)))
        .for('update')
        .limit(1);
      const row = locked[0];
      if (!row) {
        throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
      }

      const current = row.fileJsonb as GanttlyFile;
      const ctx = {
        now: new Date().toISOString(),
        today: todayString(),
        actorId: params.principal.actorId,
      };
      const outcome = applyProjectCommand(current, params.command as ProjectCommand, ctx);
      const canonical = withDefaultViewState(outcome.file);
      this.checkLimits(canonical);
      const validation = validateGanttlyFile(canonical);
      if (!validation.ok) {
        throw new HttpError(
          ApiErrorCode.VALIDATION_FAILED,
          `Command produced an invalid project: ${formatAjvErrors(validation.errors)}`,
        );
      }

      const now = new Date();
      const stats = computeProjectStats(canonical);
      const newRevision = row.revision + 1;
      await tx
        .update(projects)
        .set({
          fileJsonb: canonical,
          summaryJsonb: stats,
          revision: newRevision,
          updatedAt: now,
        })
        .where(eq(projects.id, params.projectId));

      const response: ApplyCommandResponse = {
        ...(await this.buildSnapshotFor(tx, params.projectId)),
        affectedTaskIds: outcome.affectedTaskIds,
        adjustments: outcome.adjustments,
      };
      await this.recordOperation(tx, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        principal: params.principal,
        action:
          typeof params.command === 'object' && params.command && 'kind' in params.command
            ? String((params.command as { kind: unknown }).kind)
            : 'command',
        requestHash,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: newRevision,
        summary: {
          stats,
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        },
        response,
        requestId: params.requestId,
      });
      await this.emitOutbox(tx, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        type: 'project.updated',
        payload: { projectId: params.projectId, revision: newRevision, command: true },
      });
      return response;
    });
  }

  // --- archive (soft delete) ------------------------------------------------
  async archive(params: ProjectMutationParams): Promise<ProjectSnapshotResponse> {
    return this.softDelete(params, true);
  }

  // --- restore --------------------------------------------------------------
  async restore(params: ProjectMutationParams): Promise<ProjectSnapshotResponse> {
    return this.softDelete(params, false);
  }

  private async softDelete(
    params: ProjectMutationParams,
    archive: boolean,
  ): Promise<ProjectSnapshotResponse> {
    const requestHash = canonicalRequestHash(null);
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, params.principal, params.workspaceId, 'editor');
      const replayed = await this.tryReplay(
        tx,
        params.principal,
        params.workspaceId,
        params.idempotencyKey,
        requestHash,
      );
      if (replayed) return replayed as ProjectSnapshotResponse;

      const locked = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, params.projectId), eq(projects.workspaceId, params.workspaceId)))
        .for('update')
        .limit(1);
      const row = locked[0];
      if (!row) {
        throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
      }
      const now = new Date();
      await tx
        .update(projects)
        .set({ deletedAt: archive ? now : null, updatedAt: now })
        .where(eq(projects.id, params.projectId));

      return this.snapshotAndRecord(tx, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        principal: params.principal,
        action: archive ? 'archive' : 'restore',
        requestHash,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: row.revision,
        summary: { archived: archive },
        outboxType: archive ? 'project.archived' : 'project.restored',
        outboxPayload: { projectId: params.projectId },
        requestId: params.requestId,
      });
    });
  }

  // --- permanent delete (owner only, must be archived) ----------------------
  async deletePermanently(params: ProjectMutationParams): Promise<void> {
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, params.principal, params.workspaceId, 'owner');
      const locked = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, params.projectId), eq(projects.workspaceId, params.workspaceId)))
        .for('update')
        .limit(1);
      const row = locked[0];
      if (!row) {
        throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
      }
      if (!row.deletedAt) {
        throw new HttpError(
          ApiErrorCode.VALIDATION_FAILED,
          'Project must be archived before it can be permanently deleted',
        );
      }
      await tx.delete(projects).where(eq(projects.id, params.projectId));
      await this.recordOperation(tx, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        principal: params.principal,
        action: 'delete',
        requestHash: null,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: row.revision,
        summary: { deleted: true },
        response: null,
        requestId: params.requestId,
      });
      await this.emitOutbox(tx, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        type: 'project.deleted',
        payload: { projectId: params.projectId },
      });
    });
  }

  // --- shared helpers -------------------------------------------------------

  /** normalize → strip viewState → AJV validate. Throws VALIDATION_FAILED. */
  private canonicalizeAndValidate(rawFile: unknown): GanttlyFile {
    const normalized = normalizeFile(rawFile as GanttlyFile);
    const canonical = withDefaultViewState(normalized);
    const result = validateGanttlyFile(canonical);
    if (!result.ok) {
      throw new HttpError(
        ApiErrorCode.VALIDATION_FAILED,
        `Invalid project file: ${formatAjvErrors(result.errors)}`,
      );
    }
    return canonical;
  }

  private checkLimits(file: GanttlyFile): void {
    if (file.tasks.length > this.limits.maxProjectTasks) {
      throw new HttpError(ApiErrorCode.LIMIT_EXCEEDED, 'Project exceeds the task limit', {
        limit: this.limits.maxProjectTasks,
        actual: file.tasks.length,
      });
    }
    if (file.resources.length > this.limits.maxProjectResources) {
      throw new HttpError(ApiErrorCode.LIMIT_EXCEEDED, 'Project exceeds the resource limit', {
        limit: this.limits.maxProjectResources,
        actual: file.resources.length,
      });
    }
    if (file.baselines.length > this.limits.maxProjectBaselines) {
      throw new HttpError(ApiErrorCode.LIMIT_EXCEEDED, 'Project exceeds the baseline limit', {
        limit: this.limits.maxProjectBaselines,
        actual: file.baselines.length,
      });
    }
  }

  /**
   * Idempotency replay: if an operation with this key already exists, return
   * its stored response when the request hashes match, else conflict. Returns
   * `undefined` when there is no key or no prior operation (proceed).
   */
  private async tryReplay(
    tx: Tx,
    principal: AuthPrincipal,
    workspaceId: string,
    idempotencyKey: string | undefined,
    requestHash: string,
  ): Promise<unknown | undefined> {
    if (!idempotencyKey) return undefined;
    const rows = await tx
      .select({
        requestHash: projectOperations.requestHash,
        response: projectOperations.responseJsonb,
      })
      .from(projectOperations)
      .where(
        and(
          eq(projectOperations.workspaceId, workspaceId),
          eq(projectOperations.actorType, operationActorType(principal)),
          eq(projectOperations.actorId, principal.actorId),
          eq(projectOperations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new HttpError(
        ApiErrorCode.IDEMPOTENCY_CONFLICT,
        'Idempotency key reused with a different request body',
      );
    }
    return existing.response ?? undefined;
  }

  /** Re-select the row, build the snapshot, record the operation + outbox. */
  private async snapshotAndRecord(
    tx: Tx,
    opts: {
      workspaceId: string;
      projectId: string;
      principal: AuthPrincipal;
      action: string;
      requestHash: string | null;
      idempotencyKey?: string;
      expectedRevision: number | null;
      resultRevision: number;
      summary: Record<string, unknown>;
      outboxType: string;
      outboxPayload: Record<string, unknown>;
      requestId: string;
    },
  ): Promise<ProjectSnapshotResponse> {
    const snapshot = await this.buildSnapshotFor(tx, opts.projectId);
    await this.recordOperation(tx, {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      principal: opts.principal,
      action: opts.action,
      requestHash: opts.requestHash,
      idempotencyKey: opts.idempotencyKey,
      expectedRevision: opts.expectedRevision,
      resultRevision: opts.resultRevision,
      summary: opts.summary,
      response: snapshot,
      requestId: opts.requestId,
    });
    await this.emitOutbox(tx, {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      type: opts.outboxType,
      payload: opts.outboxPayload,
    });
    return snapshot;
  }

  private async buildSnapshotFor(tx: Tx, projectId: string): Promise<ProjectSnapshotResponse> {
    const rows = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    const row = rows[0];
    if (!row) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found after write');
    return buildSnapshot(row);
  }

  private async recordOperation(
    tx: Tx,
    opts: {
      workspaceId: string;
      projectId: string;
      principal: AuthPrincipal;
      action: string;
      requestHash: string | null;
      idempotencyKey?: string;
      expectedRevision: number | null;
      resultRevision: number;
      summary: Record<string, unknown>;
      response: ProjectSnapshotResponse | ApplyCommandResponse | null;
      requestId: string;
    },
  ): Promise<void> {
    await tx.insert(projectOperations).values({
      id: newOperationId(),
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      actorType: operationActorType(opts.principal),
      actorId: opts.principal.actorId,
      action: opts.action,
      requestHash: opts.requestHash,
      idempotencyKey: opts.idempotencyKey ?? null,
      expectedRevision: opts.expectedRevision,
      resultRevision: opts.resultRevision,
      summaryJsonb: opts.summary,
      responseJsonb: opts.response,
      requestId: opts.requestId,
      createdAt: new Date(),
    });
  }

  private async emitOutbox(
    tx: Tx,
    opts: {
      workspaceId: string;
      projectId: string;
      type: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(outboxEvents).values({
      id: newEventId(),
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      type: opts.type,
      payloadJsonb: opts.payload,
      createdAt: new Date(),
      publishedAt: null,
    });
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}
