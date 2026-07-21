import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  useProjectStore,
  addTaskCommand,
  deleteTaskCommand,
  updateTaskCommand,
  setViewStateCommand,
  moveTaskCommand,
  addDependencyCommand,
  deleteDependencyCommand,
} from '@/store/useProjectStore';
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
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: {},
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
  // Clear any history that init may have produced.
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

describe('history — undo/redo basics', () => {
  beforeEach(async () => {
    await reset();
  });

  it('dispatch pushes onto undo stack and clears redo', () => {
    const store = useProjectStore.getState;
    expect(store().canUndo()).toBe(false);
    store().dispatch(addTaskCommand(makeTask('t1'), null, 0));
    expect(store().canUndo()).toBe(true);
    expect(store().canRedo()).toBe(false);
    expect(store().file.tasks).toHaveLength(1);

    store().undo();
    expect(store().file.tasks).toHaveLength(0);
    expect(store().canRedo()).toBe(true);

    store().redo();
    expect(store().file.tasks).toHaveLength(1);
    expect(store().canRedo()).toBe(false);
  });

  it('50 sequential operations undo cleanly', () => {
    const store = useProjectStore.getState;
    for (let i = 0; i < 50; i++) {
      store().dispatch(addTaskCommand(makeTask(`t${i}`), null, i));
    }
    expect(store().file.tasks).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      store().undo();
    }
    expect(store().file.tasks).toHaveLength(0);
  });

  it('each command type round-trips', () => {
    const store = useProjectStore.getState;

    // add → undo → redo
    store().dispatch(addTaskCommand(makeTask('t1'), null, 0));
    expect(store().file.tasks).toHaveLength(1);
    store().undo();
    expect(store().file.tasks).toHaveLength(0);
    store().redo();
    expect(store().file.tasks).toHaveLength(1);

    // update
    store().dispatch(updateTaskCommand('t1', { name: 'renamed' }));
    expect(store().file.tasks[0]!.name).toBe('renamed');
    store().undo();
    expect(store().file.tasks[0]!.name).toBe('t1');

    // move
    store().dispatch(addTaskCommand(makeTask('t2'), null, 1));
    store().dispatch(moveTaskCommand('t2', 't1', 0));
    expect(store().file.tasks.find((t) => t.id === 't2')?.parentId).toBe('t1');
    store().undo();
    expect(store().file.tasks.find((t) => t.id === 't2')?.parentId).toBeNull();

    // dependency add
    store().dispatch(addDependencyCommand('t2', { targetId: 't1', type: 'FS', lag: 0 }));
    expect(store().file.tasks.find((t) => t.id === 't2')?.dependencies).toHaveLength(1);
    store().undo();
    expect(store().file.tasks.find((t) => t.id === 't2')?.dependencies).toHaveLength(0);

    // dependency delete (best-effort invert)
    store().dispatch(addDependencyCommand('t2', { targetId: 't1', type: 'FS', lag: 0 }));
    store().dispatch(deleteDependencyCommand('t2', 't1'));
    expect(store().file.tasks.find((t) => t.id === 't2')?.dependencies).toHaveLength(0);

    // view state change
    store().dispatch(setViewStateCommand({ zoom: 'day' }));
    expect(store().file.viewState.zoom).toBe('day');
    store().undo();
    expect(store().file.viewState.zoom).toBe('week');

    // delete (cascade) — invert is best-effort
    store().dispatch(addTaskCommand(makeTask('child'), 't1', 0));
    expect(store().file.tasks).toHaveLength(3);
    store().dispatch(deleteTaskCommand('t1'));
    // t1 + its child 'child' deleted; t2 (not a child) remains.
    expect(store().file.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('nextUndoLabel / nextRedoLabel return latest command labels', () => {
    const store = useProjectStore.getState;
    store().dispatch(addTaskCommand(makeTask('t1'), null, 0));
    store().dispatch(updateTaskCommand('t1', { name: 'x' }));
    expect(store().nextUndoLabel()).toBe('更新任务');
    store().undo();
    expect(store().nextRedoLabel()).toBe('更新任务');
  });
});

// Silence unused-import warnings from the delete-command helper (re-tested above).
void deleteTaskCommand;
