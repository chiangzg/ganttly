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
import type {
  AddDependencyInput,
  ApplyCommandResponse,
  CreateTaskInput,
  CreateTasksInput,
  MoveTaskInput,
  ProjectSnapshotResponse,
  RemoveDependencyInput,
  UpdateTaskInput,
} from '@ganttly/api-contract';
import {
  type Dependency,
  type DependencyType,
  type GanttlyFile,
  type Task,
  createDefaultTask,
  formatAjvErrors,
  normalizeFile,
  validateGanttlyFile,
} from '@ganttly/schema';
import { applyProjectCommand, wouldCreateCycle, type ProjectCommand } from '@ganttly/domain';
import { type AuthPrincipal, operationActorType } from '../../auth/principal';
import type { Db, Tx } from '../../db/client';
import { outboxEvents, projectOperations, projects } from '../../db/schema';
import { newEventId, newOperationId, newProjectId, newTaskId } from '../../id';
import { requireMembership, requireScope } from '../access';
import { HttpError } from '../errors';
import { findExternalReference, recordExternalReference } from './external';
import { canonicalRequestHash } from './idempotency';
import { isSelfOrDescendant, moveInsertIndex, planInsertion } from './ordering';
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
      await requireMembership(tx, params.principal, params.workspaceId, 'editor', params.projectId);
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
    return this.mutateProject({
      principal: params.principal,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      idempotencyKey: params.idempotencyKey,
      requestId: params.requestId,
      action: commandAction(params.command),
      requestHash,
      apply: (current, ctx) => {
        const outcome = applyProjectCommand(current, params.command as ProjectCommand, ctx);
        return {
          file: outcome.file,
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        };
      },
    });
  }

  // --- MCP task tools (spec §10.3–10.6) -------------------------------------
  //
  // These share the §7.1 transactional chokepoint with the Web command flow.
  // Each is scope-gated (`task:write`) and workspace-membership-gated, applies
  // the relevant domain command(s) to the loaded file, validates once and
  // writes once — so MCP writes and Web writes produce identical排期 semantics.

  async createTask(params: McpMutationParams<CreateTaskInput>): Promise<CreateTaskOutcome> {
    const { principal, workspaceId, projectId, input, requestId } = params;
    requireScope(principal, 'task:write');
    const requestHash = canonicalRequestHash(input);
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, principal, workspaceId, 'editor', projectId);
      const replayed = await this.tryReplay(
        tx,
        principal,
        workspaceId,
        input.idempotencyKey,
        requestHash,
      );
      if (replayed) return replayed as CreateTaskOutcome;

      const row = await lockProject(tx, workspaceId, projectId);
      const current = row.fileJsonb as GanttlyFile;
      const ctx = commandContext(principal);

      const result = await applyCreateToFileSync(current, ctx, {
        workspaceId,
        tx,
        item: input,
      });

      if (result.created) {
        const canonical = withDefaultViewState(result.file);
        this.checkLimits(canonical);
        assertValid(canonical);
        const newRevision = row.revision + 1;
        await tx
          .update(projects)
          .set({
            fileJsonb: canonical,
            summaryJsonb: computeProjectStats(canonical),
            revision: newRevision,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, projectId));
        if (input.source) {
          await recordExternalReference(tx, {
            workspaceId,
            projectId,
            entityId: result.taskId,
            entityType: 'task',
            provider: input.source.provider,
            externalId: input.source.externalId,
            source: input.source,
          });
        }
        const outcome: CreateTaskOutcome = {
          created: true,
          task: canonical.tasks.find((t) => t.id === result.taskId)!,
          snapshot: await this.buildSnapshotFor(tx, projectId),
          revision: String(newRevision),
          affectedTaskIds: result.affectedTaskIds,
          adjustments: result.adjustments,
        };
        const operationId = newOperationId();
        await this.recordOperation(tx, {
          operationId,
          workspaceId,
          projectId,
          principal,
          action: 'create_task',
          requestHash,
          idempotencyKey: input.idempotencyKey,
          expectedRevision: row.revision,
          resultRevision: newRevision,
          summary: { createdTaskId: result.taskId },
          response: outcome,
          requestId,
        });
        await this.emitOutbox(tx, {
          workspaceId,
          projectId,
          type: 'project.updated',
          payload: { projectId, revision: newRevision, command: true },
          principal,
          operationId,
        });
        return outcome;
      }

      // Dedup hit: no revision bump, but record for idempotent replay.
      const outcome: CreateTaskOutcome = {
        created: false,
        task: result.existingTask!,
        snapshot: buildSnapshot(row),
        revision: String(row.revision),
        affectedTaskIds: [],
        adjustments: [],
      };
      await this.recordOperation(tx, {
        operationId: newOperationId(),
        workspaceId,
        projectId,
        principal,
        action: 'create_task',
        requestHash,
        idempotencyKey: input.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: row.revision,
        summary: { dedup: true },
        response: outcome,
        requestId,
      });
      return outcome;
    });
  }

  async createTasks(params: McpMutationParams<CreateTasksInput>): Promise<CreateTasksOutcome> {
    return this.db.transaction(async (tx) => {
      const { principal, workspaceId, projectId, input, requestId } = params;
      requireScope(principal, 'task:write');
      await requireMembership(tx, principal, workspaceId, 'editor', projectId);
      const requestHash = canonicalRequestHash(input);
      const replayed = await this.tryReplay(
        tx,
        principal,
        workspaceId,
        input.idempotencyKey,
        requestHash,
      );
      if (replayed) return replayed as CreateTasksOutcome;

      const row = await lockProject(tx, workspaceId, projectId);
      const ctx = commandContext(principal);
      let file = row.fileJsonb as GanttlyFile;
      const results: SingleCreateResult[] = [];

      for (const item of input.tasks) {
        const result = await applyCreateToFileSync(file, ctx, {
          workspaceId,
          tx,
          item,
        });
        file = result.file;
        results.push(result);
        if (result.created && item.source) {
          await recordExternalReference(tx, {
            workspaceId,
            projectId,
            entityId: result.taskId,
            entityType: 'task',
            provider: item.source.provider,
            externalId: item.source.externalId,
            source: item.source,
          });
        }
      }

      const canonical = withDefaultViewState(file);
      this.checkLimits(canonical);
      assertValid(canonical);
      const newRevision = row.revision + 1;
      await tx
        .update(projects)
        .set({
          fileJsonb: canonical,
          summaryJsonb: computeProjectStats(canonical),
          revision: newRevision,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));

      const snapshot = await this.buildSnapshotFor(tx, projectId);
      const response: CreateTasksOutcome = {
        snapshot,
        revision: String(newRevision),
        results: results.map((r) => ({
          created: r.created,
          task: canonical.tasks.find((t) => t.id === r.taskId)!,
          affectedTaskIds: r.affectedTaskIds,
          adjustments: r.adjustments,
        })),
      };
      const operationId = newOperationId();
      await this.recordOperation(tx, {
        operationId,
        workspaceId,
        projectId,
        principal,
        action: 'create_tasks',
        requestHash,
        idempotencyKey: input.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: newRevision,
        summary: { count: results.length },
        response,
        requestId,
      });
      await this.emitOutbox(tx, {
        workspaceId,
        projectId,
        type: 'project.updated',
        payload: { projectId, revision: newRevision, command: true },
        principal,
        operationId,
      });
      return response;
    });
  }

  async updateTask(params: McpMutationParams<UpdateTaskInput>): Promise<ApplyCommandResponse> {
    const { input } = params;
    requireScope(params.principal, 'task:write');
    return this.mutateProject({
      principal: params.principal,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      idempotencyKey: input.idempotencyKey,
      requestId: params.requestId,
      action: 'update_task',
      requestHash: canonicalRequestHash(input),
      apply: (current, ctx) => {
        const patch: Partial<Task> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.start !== undefined) patch.start = input.start;
        if (input.duration !== undefined) patch.duration = input.duration;
        if (input.progress !== undefined) patch.progress = input.progress;
        if (input.isMilestone !== undefined) patch.isMilestone = input.isMilestone;
        if (input.note !== undefined) patch.note = input.note;
        if (input.color !== undefined) patch.color = input.color;
        if (input.overtimeDates !== undefined) patch.overtimeDates = input.overtimeDates;
        if (input.constraints !== undefined) patch.constraints = input.constraints;
        if (input.assignments !== undefined) patch.assignments = input.assignments;
        const outcome = applyProjectCommand(
          current,
          { kind: 'updateTask', taskId: input.taskId, patch },
          ctx,
        );
        return {
          file: outcome.file,
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        };
      },
    });
  }

  async moveTask(params: McpMutationParams<MoveTaskInput>): Promise<ApplyCommandResponse> {
    const { input } = params;
    requireScope(params.principal, 'task:write');
    return this.mutateProject({
      principal: params.principal,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      idempotencyKey: input.idempotencyKey,
      requestId: params.requestId,
      action: 'move_task',
      requestHash: canonicalRequestHash(input),
      apply: (current, ctx) => {
        if (
          input.newParentTaskId !== null &&
          isSelfOrDescendant(current.tasks, input.taskId, input.newParentTaskId)
        ) {
          throw new HttpError(
            ApiErrorCode.VALIDATION_FAILED,
            'Cannot move a task into itself or one of its descendants',
          );
        }
        const insertIndex = moveInsertIndex(
          current.tasks,
          input.newParentTaskId,
          input.position,
          input.taskId,
        );
        const outcome = applyProjectCommand(
          current,
          {
            kind: 'moveTaskWithRollup',
            taskId: input.taskId,
            newParentId: input.newParentTaskId,
            newOrder: insertIndex,
          },
          ctx,
        );
        return {
          file: outcome.file,
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        };
      },
    });
  }

  async addDependency(
    params: McpMutationParams<AddDependencyInput>,
  ): Promise<ApplyCommandResponse> {
    const { input } = params;
    requireScope(params.principal, 'task:write');
    return this.mutateProject({
      principal: params.principal,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      idempotencyKey: input.idempotencyKey,
      requestId: params.requestId,
      action: 'add_dependency',
      requestHash: canonicalRequestHash(input),
      apply: (current, ctx) => {
        const successor = current.tasks.find((t) => t.id === input.successorTaskId);
        if (!successor) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Task not found');
        if (!current.tasks.some((t) => t.id === input.predecessorTaskId)) {
          throw new HttpError(ApiErrorCode.NOT_FOUND, 'Task not found');
        }
        if (
          wouldCreateCycle(current.tasks, {
            successorId: input.successorTaskId,
            predecessorId: input.predecessorTaskId,
          })
        ) {
          throw new HttpError(ApiErrorCode.VALIDATION_FAILED, 'Dependency would create a cycle');
        }
        const dependency: Dependency = {
          targetId: input.predecessorTaskId,
          type: (input.type ?? 'FS') as DependencyType,
          lag: input.lag ?? 0,
        };
        const outcome = applyProjectCommand(
          current,
          { kind: 'addDependency', successorId: input.successorTaskId, dependency },
          ctx,
        );
        return {
          file: outcome.file,
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        };
      },
    });
  }

  async removeDependency(
    params: McpMutationParams<RemoveDependencyInput>,
  ): Promise<ApplyCommandResponse> {
    const { input } = params;
    requireScope(params.principal, 'task:write');
    return this.mutateProject({
      principal: params.principal,
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      idempotencyKey: input.idempotencyKey,
      requestId: params.requestId,
      action: 'remove_dependency',
      requestHash: canonicalRequestHash(input),
      apply: (current, ctx) => {
        const outcome = applyProjectCommand(
          current,
          {
            kind: 'deleteDependency',
            successorId: input.successorTaskId,
            targetId: input.predecessorTaskId,
          },
          ctx,
        );
        return {
          file: outcome.file,
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        };
      },
    });
  }

  /**
   * The shared §7.1 transactional core. Opens a transaction, checks membership,
   * replays idempotency, locks the row FOR UPDATE, invokes `apply` to evolve
   * the file, validates + writes once, records the operation and outbox event.
   * Used by the Web command endpoint and the MCP update/move/dependency tools.
   */
  private async mutateProject(opts: {
    principal: AuthPrincipal;
    workspaceId: string;
    projectId: string;
    idempotencyKey?: string;
    requestId: string;
    action: string;
    requestHash: string;
    apply: (
      current: GanttlyFile,
      ctx: { now: string; today: string; actorId: string },
    ) => {
      file: GanttlyFile;
      affectedTaskIds: string[];
      adjustments: ApplyCommandResponse['adjustments'];
    };
  }): Promise<ApplyCommandResponse> {
    return this.db.transaction(async (tx) => {
      await requireMembership(tx, opts.principal, opts.workspaceId, 'editor', opts.projectId);
      const replayed = await this.tryReplay(
        tx,
        opts.principal,
        opts.workspaceId,
        opts.idempotencyKey,
        opts.requestHash,
      );
      if (replayed) return replayed as ApplyCommandResponse;

      const locked = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, opts.projectId), eq(projects.workspaceId, opts.workspaceId)))
        .for('update')
        .limit(1);
      const row = locked[0];
      if (!row) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');

      const current = row.fileJsonb as GanttlyFile;
      const ctx = commandContext(opts.principal);
      const outcome = opts.apply(current, ctx);
      const canonical = withDefaultViewState(outcome.file);
      this.checkLimits(canonical);
      assertValid(canonical);

      const newRevision = row.revision + 1;
      await tx
        .update(projects)
        .set({
          fileJsonb: canonical,
          summaryJsonb: computeProjectStats(canonical),
          revision: newRevision,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, opts.projectId));

      const response: ApplyCommandResponse = {
        ...(await this.buildSnapshotFor(tx, opts.projectId)),
        affectedTaskIds: outcome.affectedTaskIds,
        adjustments: outcome.adjustments,
      };
      const operationId = newOperationId();
      await this.recordOperation(tx, {
        operationId,
        workspaceId: opts.workspaceId,
        projectId: opts.projectId,
        principal: opts.principal,
        action: opts.action,
        requestHash: opts.requestHash,
        idempotencyKey: opts.idempotencyKey,
        expectedRevision: row.revision,
        resultRevision: newRevision,
        summary: {
          stats: computeProjectStats(canonical),
          affectedTaskIds: outcome.affectedTaskIds,
          adjustments: outcome.adjustments,
        },
        response,
        requestId: opts.requestId,
      });
      await this.emitOutbox(tx, {
        workspaceId: opts.workspaceId,
        projectId: opts.projectId,
        type: 'project.updated',
        payload: { projectId: opts.projectId, revision: newRevision, command: true },
        principal: opts.principal,
        operationId,
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
      await requireMembership(tx, params.principal, params.workspaceId, 'editor', params.projectId);
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
      await requireMembership(tx, params.principal, params.workspaceId, 'owner', params.projectId);
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
      const operationId = newOperationId();
      await this.recordOperation(tx, {
        operationId,
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
        principal: params.principal,
        operationId,
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
    const operationId = newOperationId();
    await this.recordOperation(tx, {
      operationId,
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
      principal: opts.principal,
      operationId,
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
      /** Operation id; generated by the caller so the outbox event can reference it. */
      operationId: string;
      workspaceId: string;
      projectId: string;
      principal: AuthPrincipal;
      action: string;
      requestHash: string | null;
      idempotencyKey?: string;
      expectedRevision: number | null;
      resultRevision: number;
      summary: Record<string, unknown>;
      response:
        | ProjectSnapshotResponse
        | ApplyCommandResponse
        | CreateTaskOutcome
        | CreateTasksOutcome
        | null;
      requestId: string;
    },
  ): Promise<void> {
    await tx.insert(projectOperations).values({
      id: opts.operationId,
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
      /** Principal that caused the change; embedded as the event actor. */
      principal: AuthPrincipal;
      /** Operation id to correlate the event with its operation-log row. */
      operationId: string;
    },
  ): Promise<void> {
    // Embed the actor + operationId in the payload so the SSE layer can build
    // the spec §11.1 event shape without joining project_operations.
    const payload: Record<string, unknown> = {
      ...opts.payload,
      actor: { type: operationActorType(opts.principal), id: opts.principal.actorId },
      operationId: opts.operationId,
    };
    await tx.insert(outboxEvents).values({
      id: newEventId(),
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      type: opts.type,
      payloadJsonb: payload,
      createdAt: new Date(),
      publishedAt: null,
    });
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// MCP helper types & functions (module-level, pure or tx-scoped)
// ---------------------------------------------------------------------------

export interface McpMutationParams<TInput> {
  principal: AuthPrincipal;
  workspaceId: string;
  projectId: string;
  input: TInput;
  requestId: string;
}

export interface CreateTaskOutcome {
  created: boolean;
  task: Task;
  snapshot: ProjectSnapshotResponse;
  revision: string;
  affectedTaskIds: string[];
  adjustments: ApplyCommandResponse['adjustments'];
}

export interface CreateTasksOutcome {
  snapshot: ProjectSnapshotResponse;
  revision: string;
  results: Array<{
    created: boolean;
    task: Task;
    affectedTaskIds: string[];
    adjustments: ApplyCommandResponse['adjustments'];
  }>;
}

/** Internal result of creating one task (single or batch). */
interface SingleCreateResult {
  created: boolean;
  taskId: string;
  file: GanttlyFile;
  affectedTaskIds: string[];
  adjustments: ApplyCommandResponse['adjustments'];
  /** Set when a dedup hit returned an existing task. */
  existingTask?: Task;
}

type Adjustment = ApplyCommandResponse['adjustments'][number];

function commandContext(principal: AuthPrincipal): {
  now: string;
  today: string;
  actorId: string;
} {
  return { now: new Date().toISOString(), today: todayString(), actorId: principal.actorId };
}

/** Extract a stable action label from a command for the operation log. */
function commandAction(command: unknown): string {
  if (typeof command === 'object' && command && 'kind' in command) {
    return String((command as { kind: unknown }).kind);
  }
  return 'command';
}

/** Throw VALIDATION_FAILED when the canonical file is invalid. */
function assertValid(file: GanttlyFile): void {
  const result = validateGanttlyFile(file);
  if (!result.ok) {
    throw new HttpError(
      ApiErrorCode.VALIDATION_FAILED,
      `Command produced an invalid project: ${formatAjvErrors(result.errors)}`,
    );
  }
}

/** SELECT … FOR UPDATE the project row; NOT_FOUND if missing. */
async function lockProject(tx: Tx, workspaceId: string, projectId: string) {
  const locked = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .for('update')
    .limit(1);
  const row = locked[0];
  if (!row) throw new HttpError(ApiErrorCode.NOT_FOUND, 'Project not found');
  return row;
}

/**
 * Apply one task creation to the evolving file in memory. Performs the
 * external-source dedup check (async, tx-scoped) and, on a miss, builds the
 * task via `createDefaultTask`, inserts it at the right sibling order, then
 * applies `addDependency` for each requested dependency so the scheduler runs.
 * Returns the next file plus the created/existing task id and metadata.
 */
async function applyCreateToFileSync(
  file: GanttlyFile,
  ctx: { now: string; today: string; actorId: string },
  opts: {
    workspaceId: string;
    tx: Tx;
    item: CreateTasksInput['tasks'][number];
  },
): Promise<SingleCreateResult> {
  const { item, workspaceId, tx } = opts;

  // External dedup.
  if (item.source) {
    const existing = await findExternalReference(tx, {
      workspaceId,
      provider: item.source.provider,
      externalId: item.source.externalId,
      entityType: 'task',
    });
    const existingTask = existing ? file.tasks.find((t) => t.id === existing.entityId) : undefined;
    if (existingTask) {
      return {
        created: false,
        taskId: existingTask.id,
        file,
        affectedTaskIds: [],
        adjustments: [],
        existingTask,
      };
    }
  }

  const parentId = item.parentTaskId ?? null;
  const plan = planInsertion(file.tasks, parentId, item.afterTaskId ?? null);

  // Shift higher-order siblings up by one to keep orders collision-free.
  let evolved: GanttlyFile = {
    ...file,
    tasks: file.tasks.map((t) =>
      t.parentId === parentId && t.order >= plan.shiftThreshold ? { ...t, order: t.order + 1 } : t,
    ),
  };

  const taskId = newTaskId();
  const base = createDefaultTask({
    id: taskId,
    name: item.name,
    start: item.start ?? ctx.today,
    parentId,
    order: plan.order,
  });
  const newTask: Task = {
    ...base,
    duration: item.duration ?? base.duration,
    isMilestone: item.isMilestone ?? base.isMilestone,
    progress: item.progress ?? base.progress,
    constraints: base.constraints,
    assignments: [],
    dependencies: [],
    customFields: {},
  };
  if (item.note !== undefined) newTask.note = item.note;
  if (item.color !== undefined) newTask.color = item.color;
  if (item.assignments !== undefined) newTask.assignments = [...item.assignments];

  const affected = new Set<string>([taskId]);
  const adjustments: Adjustment[] = [];

  const addOutcome = applyProjectCommand(
    evolved,
    { kind: 'addTask', task: newTask, parentId, order: plan.order },
    ctx,
  );
  evolved = addOutcome.file;
  adjustments.push(...addOutcome.adjustments);

  // Add each dependency via the domain command so the scheduler runs.
  for (const dep of item.dependencies ?? []) {
    const dependency: Dependency = {
      targetId: dep.predecessorTaskId,
      type: (dep.type ?? 'FS') as DependencyType,
      lag: dep.lag ?? 0,
    };
    const depOutcome = applyProjectCommand(
      evolved,
      { kind: 'addDependency', successorId: taskId, dependency },
      ctx,
    );
    evolved = depOutcome.file;
    depOutcome.affectedTaskIds.forEach((id) => affected.add(id));
    adjustments.push(...depOutcome.adjustments);
  }

  return {
    created: true,
    taskId,
    file: evolved,
    affectedTaskIds: [...affected],
    adjustments,
  };
}
