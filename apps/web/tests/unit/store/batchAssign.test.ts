import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { useProjectStore, batchAssignResourceCommand } from '@/store/useProjectStore';
import type { Task } from '@ganttly/schema';
import { setRepository } from '@/data/createRepository';
import { IndexedDBRepository } from '@/data/indexeddb';

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-09',
    duration: 5,
    overtimeDates: [],
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

async function reset() {
  const repo = new IndexedDBRepository();
  for (const m of await repo.listProjects()) await repo.deleteProject(m.id);
  setRepository(repo);
  await useProjectStore.getState().init(repo);
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

describe('batchAssignResourceCommand', () => {
  beforeEach(async () => {
    await reset();
  });

  it('assigns multiple independent leaf tasks with a single undo record', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({ ...file, tasks: [makeTask('a'), makeTask('b'), makeTask('c')] }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchAssignResourceCommand(['a', 'c'], { resourceId: 'r1', load: 100 }));
    expect(store().undoStack).toHaveLength(1);
    const assignments = store().file.tasks.map((t) => t.assignments);
    expect(assignments).toEqual([
      [{ resourceId: 'r1', load: 100 }],
      [],
      [{ resourceId: 'r1', load: 100 }],
    ]);

    // One undo restores every task's original assignments.
    store().undo();
    expect(store().file.tasks.every((t) => t.assignments.length === 0)).toBe(true);
  });

  it('skips summary tasks (tasks with children)', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [
          makeTask('parent', { order: 0 }),
          makeTask('child', { parentId: 'parent', order: 0 }),
          makeTask('other', { order: 1 }),
        ],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    // parent + other selected: only the leaf `other` receives the assignment.
    store().dispatch(
      batchAssignResourceCommand(['parent', 'other'], { resourceId: 'r1', load: 80 }),
    );
    const byId = new Map(store().file.tasks.map((t) => [t.id, t]));
    expect(byId.get('parent')!.assignments).toEqual([]);
    expect(byId.get('child')!.assignments).toEqual([]);
    expect(byId.get('other')!.assignments).toEqual([{ resourceId: 'r1', load: 80 }]);

    store().undo();
    expect(store().file.tasks.every((t) => t.assignments.length === 0)).toBe(true);
  });

  it('parent and child both selected: only the child is assigned', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [
          makeTask('parent', { order: 0 }),
          makeTask('child', { parentId: 'parent', order: 0 }),
        ],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(
      batchAssignResourceCommand(['parent', 'child'], { resourceId: 'r1', load: 50 }),
    );
    const byId = new Map(store().file.tasks.map((t) => [t.id, t]));
    expect(byId.get('parent')!.assignments).toEqual([]);
    expect(byId.get('child')!.assignments).toEqual([{ resourceId: 'r1', load: 50 }]);
  });

  it('all-summary selection is a no-op (file untouched, no undo record effect)', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [
          makeTask('parent', { order: 0 }),
          makeTask('child', { parentId: 'parent', order: 0 }),
        ],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });
    const before = JSON.stringify(store().file.tasks);

    store().dispatch(batchAssignResourceCommand(['parent'], { resourceId: 'r1', load: 100 }));
    expect(JSON.stringify(store().file.tasks)).toBe(before);
  });

  it('reassigning the same resource updates its load instead of duplicating', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [
          makeTask('a', { assignments: [{ resourceId: 'r1', load: 30 }] }),
          makeTask('b', { assignments: [{ resourceId: 'r2', load: 10 }] }),
        ],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchAssignResourceCommand(['a', 'b'], { resourceId: 'r1', load: 60 }));
    const byId = new Map(store().file.tasks.map((t) => [t.id, t]));
    expect(byId.get('a')!.assignments).toEqual([{ resourceId: 'r1', load: 60 }]);
    expect(byId.get('b')!.assignments).toEqual([
      { resourceId: 'r2', load: 10 },
      { resourceId: 'r1', load: 60 },
    ]);

    // Undo restores the pre-batch mixes (including b's untouched r2).
    store().undo();
    const after = new Map(store().file.tasks.map((t) => [t.id, t]));
    expect(after.get('a')!.assignments).toEqual([{ resourceId: 'r1', load: 30 }]);
    expect(after.get('b')!.assignments).toEqual([{ resourceId: 'r2', load: 10 }]);
  });

  it('redo re-applies the batch after undo', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({ ...file, tasks: [makeTask('a'), makeTask('b')] }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchAssignResourceCommand(['a', 'b'], { resourceId: 'r1', load: 100 }));
    store().undo();
    expect(store().file.tasks.every((t) => t.assignments.length === 0)).toBe(true);

    store().redo();
    expect(store().file.tasks.every((t) => t.assignments[0]?.resourceId === 'r1')).toBe(true);
  });
});
