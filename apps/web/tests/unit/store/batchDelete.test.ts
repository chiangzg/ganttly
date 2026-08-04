import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { useProjectStore, batchDeleteTasksCommand } from '@/store/useProjectStore';
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

describe('batchDeleteTasksCommand', () => {
  beforeEach(async () => {
    await reset();
  });

  it('deletes multiple independent tasks and one undo restores all', () => {
    const store = useProjectStore.getState;
    // Seed three root tasks.
    store().dispatch({
      label: 'seed',
      apply: (file) => ({ ...file, tasks: [makeTask('a'), makeTask('b'), makeTask('c')] }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });
    expect(store().file.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);

    store().dispatch(batchDeleteTasksCommand(['a', 'c']));
    expect(store().file.tasks.map((t) => t.id)).toEqual(['b']);
    expect(store().undoStack).toHaveLength(1);

    store().undo();
    expect(
      store()
        .file.tasks.map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('cascades descendants: selecting a parent deletes its children too', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [
          makeTask('parent'),
          makeTask('child1', { parentId: 'parent' }),
          makeTask('child2', { parentId: 'parent' }),
          makeTask('sibling'),
        ],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchDeleteTasksCommand(['parent']));
    expect(store().file.tasks.map((t) => t.id)).toEqual(['sibling']);

    store().undo();
    expect(
      store()
        .file.tasks.map((t) => t.id)
        .sort(),
    ).toEqual(['child1', 'child2', 'parent', 'sibling']);
  });

  it('parent+child both selected: deletes the subtree once, not twice', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [makeTask('parent'), makeTask('child', { parentId: 'parent' }), makeTask('other')],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchDeleteTasksCommand(['parent', 'child']));
    // Only 'other' survives — no duplicate-deletion artifacts.
    expect(store().file.tasks.map((t) => t.id)).toEqual(['other']);
    expect(store().undoStack).toHaveLength(1);

    store().undo();
    expect(
      store()
        .file.tasks.map((t) => t.id)
        .sort(),
    ).toEqual(['child', 'other', 'parent']);
  });

  it('trims dependency edges pointing at deleted tasks and restores them on undo', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [
          makeTask('a'),
          makeTask('b'),
          makeTask('c', { dependencies: [{ targetId: 'a', type: 'FS', lag: 0 }] }),
        ],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchDeleteTasksCommand(['a', 'b']));
    const survivor = store().file.tasks.find((t) => t.id === 'c');
    expect(survivor?.dependencies).toEqual([]); // edge to 'a' trimmed

    store().undo();
    const restored = store().file.tasks.find((t) => t.id === 'c');
    expect(restored?.dependencies).toEqual([{ targetId: 'a', type: 'FS', lag: 0 }]);
  });

  it('redo re-applies the batch deletion', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({ ...file, tasks: [makeTask('a'), makeTask('b'), makeTask('c')] }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchDeleteTasksCommand(['a', 'b']));
    store().undo();
    expect(
      store()
        .file.tasks.map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);

    store().redo();
    expect(store().file.tasks.map((t) => t.id)).toEqual(['c']);
  });

  it('produces a single undo record (not one per task)', () => {
    const store = useProjectStore.getState;
    store().dispatch({
      label: 'seed',
      apply: (file) => ({
        ...file,
        tasks: [makeTask('a'), makeTask('b'), makeTask('c'), makeTask('d')],
      }),
      invert: (file) => file,
    });
    useProjectStore.setState({ undoStack: [], redoStack: [] });

    store().dispatch(batchDeleteTasksCommand(['a', 'b', 'c', 'd']));
    expect(store().undoStack).toHaveLength(1);
    expect(store().file.tasks).toHaveLength(0);
  });
});
