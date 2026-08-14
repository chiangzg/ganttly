/**
 * MCP task-tool service integration tests (spec §10.3–10.6). Exercises the
 * ProjectApplicationService MCP methods (createTask/createTasks/updateTask/
 * moveTask/addDependency/removeDependency) against a real database, plus
 * external-source dedup and access control. Requires TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_LIMITS } from '@ganttly/api-contract';
import { createEmptyFile } from '@ganttly/schema';
import type { AuthPrincipal } from '../../src/auth/principal';
import type { ProjectLimits } from '../../src/modules/projects/service';
import { ProjectApplicationService } from '../../src/modules/projects/service';
import {
  outboxEvents,
  projectOperations,
  projects,
  externalReferences,
  workspaceMembers,
} from '../../src/db/schema';
import { buildIntegrationServer, devLogin, type DevSession } from './helpers';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('MCP task tools integration', () => {
  let app: FastifyInstance;
  let session: DevSession;
  let projectId: string;
  let service: ProjectApplicationService;

  beforeAll(async () => {
    app = await buildIntegrationServer();
    await app.db.delete(externalReferences);
    await app.db.delete(outboxEvents);
    await app.db.delete(projectOperations);
    await app.db.delete(projects);
    session = await devLogin(app);

    const limits: ProjectLimits = {
      maxProjectBytes: DEFAULT_LIMITS.maxProjectBytes,
      maxProjectTasks: DEFAULT_LIMITS.maxProjectTasks,
      maxProjectResources: DEFAULT_LIMITS.maxProjectResources,
      maxProjectBaselines: DEFAULT_LIMITS.maxProjectBaselines,
    };
    service = new ProjectApplicationService(app.db, limits);

    // Seed a project via the REST API.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${session.workspaceId}/projects`,
      headers: { 'idempotency-key': 'mcp-seed', cookie: `ganttly_session=${session.cookie}` },
      payload: { file: createEmptyFile({ name: 'MCP target' }) },
    });
    projectId = (res.json() as { summary: { id: string } }).summary.id;
  });
  afterAll(async () => {
    await app.close();
  });

  function patPrincipal(scopes: string[] = ['task:write', 'project:read']): AuthPrincipal {
    return {
      actorType: 'pat',
      actorId: 'pat_test',
      userId: session.userId,
      scopes: scopes as AuthPrincipal['scopes'],
    };
  }

  const base = () => ({
    principal: patPrincipal(),
    workspaceId: session.workspaceId,
    projectId,
    requestId: 'req-test',
  });

  it('createTask adds a task and bumps revision', async () => {
    const outcome = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'First task',
        idempotencyKey: 'ct-1',
      },
    });
    expect(outcome.created).toBe(true);
    expect(outcome.task.name).toBe('First task');
    expect(Number(outcome.revision)).toBeGreaterThan(1);
    expect(outcome.affectedTaskIds).toContain(outcome.task.id);
  });

  it('createTask dedups on an external source (created=false, no revision bump)', async () => {
    const first = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'External',
        idempotencyKey: 'ct-ext-1',
        source: { provider: 'jira', externalId: 'JIRA-100' },
      },
    });
    expect(first.created).toBe(true);
    const revBefore = first.revision;

    const second = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'External retry',
        idempotencyKey: 'ct-ext-2',
        source: { provider: 'jira', externalId: 'JIRA-100' },
      },
    });
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.revision).toBe(revBefore); // no bump on dedup
  });

  it('createTasks creates multiple tasks in one revision bump', async () => {
    const outcome = await service.createTasks({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        idempotencyKey: 'ct-batch-1',
        tasks: [{ name: 'Batch A' }, { name: 'Batch B' }],
      },
    });
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.created)).toBe(true);
    expect(outcome.results.map((r) => r.task.name)).toEqual(['Batch A', 'Batch B']);
  });

  it('createTasks replays an idempotent batch without duplicating', async () => {
    const input = {
      workspaceId: session.workspaceId,
      projectId,
      idempotencyKey: 'ct-batch-replay',
      tasks: [{ name: 'Replay A' }, { name: 'Replay B' }],
    };
    const first = await service.createTasks({ ...base(), input });
    const second = await service.createTasks({ ...base(), input });
    expect(second.results.map((r) => r.task.name)).toEqual(['Replay A', 'Replay B']);
    // Replay must return the original snapshot, not create duplicates.
    const counts = second.snapshot.file.tasks.filter(
      (t) => t.name === 'Replay A' || t.name === 'Replay B',
    );
    expect(counts).toHaveLength(2);
    expect(second.revision).toBe(first.revision);
  });

  it('updateTask changes a whitelisted field', async () => {
    const created = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'ToUpdate',
        idempotencyKey: 'ct-upd',
      },
    });
    const outcome = await service.updateTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        taskId: created.task.id,
        progress: 75,
        idempotencyKey: 'ut-1',
      },
    });
    const updated = outcome.file.tasks.find((t) => t.id === created.task.id)!;
    expect(updated.progress).toBe(75);
  });

  it('moveTask repositions under a new parent', async () => {
    const parent = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'Parent',
        idempotencyKey: 'ct-mv-p',
      },
    });
    const child = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'Child',
        idempotencyKey: 'ct-mv-c',
      },
    });
    const outcome = await service.moveTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        taskId: child.task.id,
        newParentTaskId: parent.task.id,
        position: { kind: 'last' },
        idempotencyKey: 'mt-1',
      },
    });
    const moved = outcome.file.tasks.find((t) => t.id === child.task.id)!;
    expect(moved.parentId).toBe(parent.task.id);
  });

  it('moveTask refuses to move a task into its own descendant', async () => {
    const grandparent = await service.createTask({
      ...base(),
      input: { workspaceId: session.workspaceId, projectId, name: 'GP', idempotencyKey: 'ct-gp' },
    });
    const parent = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'P',
        parentTaskId: grandparent.task.id,
        idempotencyKey: 'ct-p',
      },
    });
    await expect(
      service.moveTask({
        ...base(),
        input: {
          workspaceId: session.workspaceId,
          projectId,
          taskId: grandparent.task.id,
          newParentTaskId: parent.task.id, // parent is a descendant of grandparent
          position: { kind: 'last' },
          idempotencyKey: 'mt-cycle',
        },
      }),
    ).rejects.toThrow(/descendants/);
  });

  it('addDependency and removeDependency manage an edge', async () => {
    const pred = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'Pred',
        idempotencyKey: 'ct-pred',
      },
    });
    const succ = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'Succ',
        idempotencyKey: 'ct-succ',
      },
    });
    const added = await service.addDependency({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        successorTaskId: succ.task.id,
        predecessorTaskId: pred.task.id,
        type: 'FS',
        idempotencyKey: 'ad-1',
      },
    });
    const withDep = added.file.tasks.find((t) => t.id === succ.task.id)!;
    expect(withDep.dependencies.some((d) => d.targetId === pred.task.id)).toBe(true);

    const removed = await service.removeDependency({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        successorTaskId: succ.task.id,
        predecessorTaskId: pred.task.id,
        idempotencyKey: 'rd-1',
      },
    });
    const withoutDep = removed.file.tasks.find((t) => t.id === succ.task.id)!;
    expect(withoutDep.dependencies.some((d) => d.targetId === pred.task.id)).toBe(false);
  });

  it('addDependency rejects a self-loop', async () => {
    const task = await service.createTask({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'SelfLoop',
        idempotencyKey: 'ct-selfloop',
      },
    });
    await expect(
      service.addDependency({
        ...base(),
        input: {
          workspaceId: session.workspaceId,
          projectId,
          successorTaskId: task.task.id,
          predecessorTaskId: task.task.id,
          idempotencyKey: 'ad-selfloop',
        },
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it('addDependency rejects a cycle across tasks', async () => {
    const a = await service.createTask({
      ...base(),
      input: { workspaceId: session.workspaceId, projectId, name: 'A', idempotencyKey: 'cyc-a' },
    });
    const b = await service.createTask({
      ...base(),
      input: { workspaceId: session.workspaceId, projectId, name: 'B', idempotencyKey: 'cyc-b' },
    });
    await service.addDependency({
      ...base(),
      input: {
        workspaceId: session.workspaceId,
        projectId,
        successorTaskId: b.task.id,
        predecessorTaskId: a.task.id,
        idempotencyKey: 'cyc-ab',
      },
    });
    await expect(
      service.addDependency({
        ...base(),
        input: {
          workspaceId: session.workspaceId,
          projectId,
          successorTaskId: a.task.id,
          predecessorTaskId: b.task.id,
          idempotencyKey: 'cyc-ba',
        },
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it('addDependency rejects a missing task (NOT_FOUND)', async () => {
    const task = await service.createTask({
      ...base(),
      input: { workspaceId: session.workspaceId, projectId, name: 'X', idempotencyKey: 'cyc-x' },
    });
    await expect(
      service.addDependency({
        ...base(),
        input: {
          workspaceId: session.workspaceId,
          projectId,
          successorTaskId: task.task.id,
          predecessorTaskId: 'task_does_not_exist',
          idempotencyKey: 'cyc-missing',
        },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects writes from a read-only scope (FORBIDDEN)', async () => {
    await expect(
      service.createTask({
        ...base(),
        principal: patPrincipal(['project:read']), // no task:write
        input: {
          workspaceId: session.workspaceId,
          projectId,
          name: 'No scope',
          idempotencyKey: 'ct-noscope',
        },
      }),
    ).rejects.toThrow(/task:write/);
  });

  it('rejects writes from a non-member (NOT_FOUND, no existence leak)', async () => {
    const other = await devLogin(app, 'dev-user-nonmember'); // different user/workspace
    await expect(
      service.createTask({
        principal: {
          actorType: 'pat',
          actorId: 'pat_other',
          userId: other.userId,
          scopes: ['task:write', 'project:read'] as AuthPrincipal['scopes'],
        },
        workspaceId: other.workspaceId, // wrong workspace
        projectId,
        requestId: 'req-cross',
        input: {
          workspaceId: other.workspaceId,
          projectId,
          name: 'Cross',
          idempotencyKey: 'ct-cross',
        },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('enforces PAT workspace narrowing even when the holder is a member (NOT_FOUND)', async () => {
    // Give the session user a second workspace so membership alone would pass.
    const other = await devLogin(app, 'dev-user-second-ws');
    await app.db
      .insert(workspaceMembers)
      .values({
        workspaceId: other.workspaceId,
        userId: session.userId,
        role: 'editor',
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    // PAT narrowed to the first workspace; call targets the second one.
    const narrowed: AuthPrincipal = {
      ...patPrincipal(),
      workspaceId: session.workspaceId,
    };
    await expect(
      service.createTask({
        principal: narrowed,
        workspaceId: other.workspaceId,
        projectId,
        requestId: 'req-narrow-ws',
        input: {
          workspaceId: other.workspaceId,
          projectId,
          name: 'Narrowed out',
          idempotencyKey: 'ct-narrow-ws',
        },
      }),
    ).rejects.toThrow(/not found/i);

    // Same narrowed PAT still works on its own workspace.
    const outcome = await service.createTask({
      ...base(),
      principal: narrowed,
      input: {
        workspaceId: session.workspaceId,
        projectId,
        name: 'Narrowed in',
        idempotencyKey: 'ct-narrow-ok',
      },
    });
    expect(outcome.created).toBe(true);
  });

  it('enforces PAT project narrowing within the same workspace (NOT_FOUND)', async () => {
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${session.workspaceId}/projects`,
      headers: {
        cookie: `ganttly_session=${session.cookie}`,
        'idempotency-key': 'mcp-narrow-second',
      },
      payload: { file: createEmptyFile({ name: 'Second project' }) },
    });
    const secondId = (second.json() as { summary: { id: string } }).summary.id;

    const narrowed: AuthPrincipal = {
      ...patPrincipal(),
      workspaceId: session.workspaceId,
      projectId,
    };
    await expect(
      service.createTask({
        principal: narrowed,
        workspaceId: session.workspaceId,
        projectId: secondId,
        requestId: 'req-narrow-prj',
        input: {
          workspaceId: session.workspaceId,
          projectId: secondId,
          name: 'Wrong project',
          idempotencyKey: 'ct-narrow-prj',
        },
      }),
    ).rejects.toThrow(/not found/i);
  });
});
