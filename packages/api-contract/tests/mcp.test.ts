import { describe, expect, it } from 'vitest';
import {
  addDependencyInput,
  createTaskInput,
  createTaskItemSchema,
  createTasksInput,
  dependencyInputSchema,
  externalSourceSchema,
  getTaskInput,
  listProjectsInput,
  movePositionSchema,
  moveTaskInput,
  removeDependencyInput,
  searchTasksInput,
  updateTaskInput,
} from '../src';

describe('externalSourceSchema', () => {
  it('accepts provider + externalId + optional url', () => {
    expect(
      externalSourceSchema.parse({
        provider: 'jira',
        externalId: 'JIRA-123',
        url: 'https://jira.example/browse/JIRA-123',
      }),
    ).toMatchObject({ provider: 'jira', externalId: 'JIRA-123' });
  });

  it('accepts without url', () => {
    expect(externalSourceSchema.parse({ provider: 'slack', externalId: 't1' }).url).toBeUndefined();
  });

  it('rejects a malformed url', () => {
    expect(() =>
      externalSourceSchema.parse({ provider: 'x', externalId: 'y', url: 'not-a-url' }),
    ).toThrow();
  });
});

describe('dependencyInputSchema', () => {
  it('defaults-free accepts predecessor only', () => {
    expect(dependencyInputSchema.parse({ predecessorTaskId: 't1' })).toMatchObject({
      predecessorTaskId: 't1',
    });
  });

  it('accepts type and lag', () => {
    const parsed = dependencyInputSchema.parse({
      predecessorTaskId: 't1',
      type: 'SS',
      lag: -2,
    });
    expect(parsed.type).toBe('SS');
    expect(parsed.lag).toBe(-2);
  });
});

describe('searchTasksInput', () => {
  it('applies the default limit of 50', () => {
    const parsed = searchTasksInput.parse({ workspaceId: 'ws', projectId: 'prj' });
    expect(parsed.limit).toBe(50);
  });

  it('clamps an over-limit value via rejection (>200)', () => {
    expect(() =>
      searchTasksInput.parse({ workspaceId: 'ws', projectId: 'prj', limit: 201 }),
    ).toThrow();
  });

  it('accepts the maximum limit of 200', () => {
    expect(searchTasksInput.parse({ workspaceId: 'ws', projectId: 'prj', limit: 200 }).limit).toBe(
      200,
    );
  });

  it('rejects a malformed date', () => {
    expect(() =>
      searchTasksInput.parse({ workspaceId: 'ws', projectId: 'prj', startFrom: '2026/01/01' }),
    ).toThrow();
  });
});

describe('createTaskInput', () => {
  const base = { workspaceId: 'ws', projectId: 'prj', idempotencyKey: 'k1' };

  it('accepts a minimal task', () => {
    const parsed = createTaskInput.parse({ ...base, name: 'Design' });
    expect(parsed.name).toBe('Design');
    expect(parsed.source).toBeUndefined();
  });

  it('accepts a task with source + dependencies', () => {
    const parsed = createTaskInput.parse({
      ...base,
      name: 'Build',
      parentTaskId: 'root',
      dependencies: [{ predecessorTaskId: 't1', type: 'FS' }],
      source: { provider: 'gh', externalId: 'issue-5' },
    });
    expect(parsed.dependencies?.[0]?.predecessorTaskId).toBe('t1');
    expect(parsed.source?.provider).toBe('gh');
  });

  it('rejects a malformed start date', () => {
    expect(() => createTaskInput.parse({ ...base, name: 'x', start: '01-01-2026' })).toThrow();
  });

  it('rejects a missing idempotencyKey', () => {
    expect(() => createTaskItemSchema.parse({ name: 'x' })).not.toThrow();
    expect(() =>
      createTaskInput.parse({ workspaceId: 'ws', projectId: 'prj', name: 'x' }),
    ).toThrow();
  });
});

describe('createTasksInput', () => {
  it('accepts a batch of items', () => {
    const parsed = createTasksInput.parse({
      workspaceId: 'ws',
      projectId: 'prj',
      idempotencyKey: 'batch-1',
      tasks: [{ name: 'A' }, { name: 'B' }],
    });
    expect(parsed.tasks).toHaveLength(2);
  });

  it('rejects an empty batch', () => {
    expect(() =>
      createTasksInput.parse({
        workspaceId: 'ws',
        projectId: 'prj',
        idempotencyKey: 'batch-1',
        tasks: [],
      }),
    ).toThrow();
  });
});

describe('updateTaskInput', () => {
  const base = { workspaceId: 'ws', projectId: 'prj', taskId: 't1', idempotencyKey: 'k1' };

  it('accepts a single field change', () => {
    const parsed = updateTaskInput.parse({ ...base, name: 'Renamed' });
    expect(parsed.name).toBe('Renamed');
  });

  it('rejects an empty patch (no field to change)', () => {
    expect(() => updateTaskInput.parse(base)).toThrow();
  });
});

describe('movePositionSchema', () => {
  it('accepts all four position variants', () => {
    expect(movePositionSchema.parse({ kind: 'first' }).kind).toBe('first');
    expect(movePositionSchema.parse({ kind: 'last' }).kind).toBe('last');
    expect(movePositionSchema.parse({ kind: 'before', taskId: 't2' })).toMatchObject({
      kind: 'before',
      taskId: 't2',
    });
    expect(movePositionSchema.parse({ kind: 'after', taskId: 't2' })).toMatchObject({
      kind: 'after',
      taskId: 't2',
    });
  });

  it('rejects before/after without a taskId', () => {
    expect(() => movePositionSchema.parse({ kind: 'before' })).toThrow();
  });
});

describe('moveTaskInput', () => {
  it('accepts a move under a new parent at a position', () => {
    const parsed = moveTaskInput.parse({
      workspaceId: 'ws',
      projectId: 'prj',
      taskId: 't1',
      newParentTaskId: 'p1',
      position: { kind: 'after', taskId: 't0' },
      idempotencyKey: 'k1',
    });
    expect(parsed.position).toMatchObject({ kind: 'after', taskId: 't0' });
  });
});

describe('addDependencyInput / removeDependencyInput', () => {
  it('add accepts successor + predecessor + idempotencyKey', () => {
    const parsed = addDependencyInput.parse({
      workspaceId: 'ws',
      projectId: 'prj',
      successorTaskId: 's1',
      predecessorTaskId: 'p1',
      type: 'FF',
      lag: 1,
      idempotencyKey: 'k1',
    });
    expect(parsed.successorTaskId).toBe('s1');
    expect(parsed.predecessorTaskId).toBe('p1');
  });

  it('remove requires both ids', () => {
    expect(() =>
      removeDependencyInput.parse({
        workspaceId: 'ws',
        projectId: 'prj',
        successorTaskId: 's1',
        idempotencyKey: 'k1',
      }),
    ).toThrow();
  });
});

describe('listProjectsInput / getTaskInput', () => {
  it('list accepts optional query', () => {
    expect(listProjectsInput.parse({ workspaceId: 'ws' }).query).toBeUndefined();
  });

  it('get requires taskId', () => {
    expect(() => getTaskInput.parse({ workspaceId: 'ws', projectId: 'prj' })).toThrow();
  });
});
