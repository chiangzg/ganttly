import { describe, expect, it } from 'vitest';
import {
  addResourceCommand,
  updateResourceCommand,
  deleteResourceCommand,
  moveResourceCommand,
  assignResourceCommand,
  unassignResourceCommand,
} from '@/store/useProjectStore';
import { createEmptyFile } from '@ganttly/schema';
import type { GanttlyFile, Task, Resource } from '@ganttly/schema';

function makeFile(overrides: Partial<GanttlyFile> = {}): GanttlyFile {
  return { ...createEmptyFile({ name: 't' }), ...overrides };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-09',
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

const alice: Resource = { id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' };
const bob: Resource = { id: 'r2', name: 'Bob', capacity: 0.8, role: '设计' };
const carol: Resource = { id: 'r3', name: 'Carol', capacity: 1.0, role: '测试' };

describe('addResourceCommand', () => {
  it('adds a resource on apply and removes it on invert', () => {
    const cmd = addResourceCommand(alice);
    const file = makeFile();
    const next = cmd.apply(file);
    expect(next.resources).toHaveLength(1);
    expect(next.resources.find((r) => r.id === 'r1')).toEqual(alice);
    const restored = cmd.invert(next);
    expect(restored.resources).toHaveLength(0);
  });
});

describe('updateResourceCommand', () => {
  it('patches fields and restores them on invert', () => {
    const file = makeFile({ resources: [alice] });
    const cmd = updateResourceCommand('r1', { capacity: 0.5, role: '设计' });
    const next = cmd.apply(file);
    const nextRes = next.resources.find((r) => r.id === 'r1')!;
    expect(nextRes.capacity).toBe(0.5);
    expect(nextRes.role).toBe('设计');
    expect(nextRes.name).toBe('Alice'); // untouched
    const restored = cmd.invert(next);
    const restoredRes = restored.resources.find((r) => r.id === 'r1')!;
    expect(restoredRes.capacity).toBe(1.0);
    expect(restoredRes.role).toBe('前端');
  });

  it('is a no-op when the resource does not exist', () => {
    const file = makeFile({ resources: [alice] });
    const cmd = updateResourceCommand('nope', { capacity: 0.1 });
    expect(cmd.apply(file)).toBe(file);
  });
});

describe('deleteResourceCommand', () => {
  it('removes the resource and cascades assignment cleanup', () => {
    const file = makeFile({
      resources: [alice],
      tasks: [
        makeTask('t1', { assignments: [{ resourceId: 'r1', load: 50 }] }),
        makeTask('t2', {
          assignments: [
            { resourceId: 'r1', load: 30 },
            { resourceId: 'r2', load: 20 },
          ],
        }),
      ],
    });
    const cmd = deleteResourceCommand('r1');
    const next = cmd.apply(file);
    expect(next.resources).toHaveLength(0);
    const t1 = next.tasks.find((t) => t.id === 't1')!;
    const t2 = next.tasks.find((t) => t.id === 't2')!;
    expect(t1.assignments).toHaveLength(0);
    expect(t2.assignments).toHaveLength(1);
    expect(t2.assignments[0]!.resourceId).toBe('r2');
  });

  it('restores the resource on invert', () => {
    const file = makeFile({ resources: [alice] });
    const cmd = deleteResourceCommand('r1');
    const next = cmd.apply(file);
    const restored = cmd.invert(next);
    expect(restored.resources).toHaveLength(1);
    expect(restored.resources[0]!.id).toBe('r1');
  });

  it('restores resource order and complete assignments across undo and redo', () => {
    const file = makeFile({
      resources: [bob, alice, carol],
      tasks: [
        makeTask('t1', {
          assignments: [
            { resourceId: 'r2', load: 20 },
            { resourceId: 'r1', load: 50 },
            { resourceId: 'r3', load: 30 },
          ],
        }),
        makeTask('t2', { assignments: [{ resourceId: 'r1', load: 75 }] }),
      ],
    });
    const cmd = deleteResourceCommand('r1');

    const deleted = cmd.apply(file);
    const restored = cmd.invert(deleted);
    expect(restored.resources).toEqual(file.resources);
    expect(restored.tasks.map((task) => task.assignments)).toEqual(
      file.tasks.map((task) => task.assignments),
    );

    const redone = cmd.apply(restored);
    const restoredAgain = cmd.invert(redone);
    expect(restoredAgain.resources).toEqual(file.resources);
    expect(restoredAgain.tasks.map((task) => task.assignments)).toEqual(
      file.tasks.map((task) => task.assignments),
    );
  });
});

describe('moveResourceCommand', () => {
  it('moves a resource to the target index', () => {
    const file = makeFile({ resources: [alice, bob, carol] });
    const next = moveResourceCommand('r1', 2).apply(file);
    expect(next.resources.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('supports moving up', () => {
    const file = makeFile({ resources: [alice, bob, carol] });
    const next = moveResourceCommand('r3', 0).apply(file);
    expect(next.resources.map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
  });

  it('is a no-op when the effective position is unchanged', () => {
    const file = makeFile({ resources: [alice, bob, carol] });
    expect(moveResourceCommand('r2', 1).apply(file)).toBe(file);
  });

  it('clamps an out-of-range index', () => {
    const file = makeFile({ resources: [alice, bob, carol] });
    const next = moveResourceCommand('r1', 99).apply(file);
    expect(next.resources.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('is a no-op when the resource does not exist', () => {
    const file = makeFile({ resources: [alice] });
    expect(moveResourceCommand('nope', 0).apply(file)).toBe(file);
  });

  it('restores the original order on invert (undo)', () => {
    const file = makeFile({ resources: [alice, bob, carol] });
    const cmd = moveResourceCommand('r1', 2);
    const next = cmd.apply(file);
    expect(next.resources.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
    const restored = cmd.invert(next);
    expect(restored.resources).toEqual(file.resources);
  });
});

describe('assignResourceCommand', () => {
  it('adds an assignment to a task', () => {
    const file = makeFile({ tasks: [makeTask('t1')] });
    const cmd = assignResourceCommand('t1', { resourceId: 'r1', load: 60 });
    const next = cmd.apply(file);
    const t1 = next.tasks.find((t) => t.id === 't1')!;
    expect(t1.assignments).toHaveLength(1);
    expect(t1.assignments[0]).toEqual({ resourceId: 'r1', load: 60 });
  });

  it('updates load when the resource is already assigned (no duplicate)', () => {
    const file = makeFile({
      tasks: [makeTask('t1', { assignments: [{ resourceId: 'r1', load: 30 }] })],
    });
    const cmd = assignResourceCommand('t1', { resourceId: 'r1', load: 70 });
    const next = cmd.apply(file);
    const t1 = next.tasks.find((t) => t.id === 't1')!;
    expect(t1.assignments).toHaveLength(1);
    expect(t1.assignments[0]!.load).toBe(70);
  });
});

describe('unassignResourceCommand', () => {
  it('removes the assignment and restores it on invert', () => {
    const file = makeFile({
      tasks: [
        makeTask('t1', {
          assignments: [
            { resourceId: 'r1', load: 50 },
            { resourceId: 'r2', load: 30 },
          ],
        }),
      ],
    });
    const cmd = unassignResourceCommand('t1', 'r1');
    const next = cmd.apply(file);
    const nextTask = next.tasks.find((t) => t.id === 't1')!;
    expect(nextTask.assignments).toHaveLength(1);
    expect(nextTask.assignments[0]!.resourceId).toBe('r2');
    const restored = cmd.invert(next);
    const restoredTask = restored.tasks.find((t) => t.id === 't1')!;
    expect(restoredTask.assignments).toHaveLength(2);
    // restored assignment preserves its original load
    const r1 = restoredTask.assignments.find((a) => a.resourceId === 'r1');
    expect(r1?.load).toBe(50);
  });

  it('is a no-op when the assignment does not exist', () => {
    const file = makeFile({ tasks: [makeTask('t1')] });
    const cmd = unassignResourceCommand('t1', 'r1');
    expect(cmd.apply(file)).toBe(file);
  });
});
