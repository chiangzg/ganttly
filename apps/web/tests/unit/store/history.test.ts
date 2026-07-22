import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  useProjectStore,
  addTaskCommand,
  deleteTaskCommand,
  updateTaskCommand,
  updateTaskWithRollupCommand,
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

  it('addDependencyCommand cascades: successor reschedules to satisfy the new FS dep', () => {
    const store = useProjectStore.getState;
    // t1 ends 1/9; t2 starts 1/5. FS dep t2→t1 means t2 must start 1/12 (next
    // working day after t1.end). The cascade should move t2 forward.
    store().dispatch(addTaskCommand(makeTask('t1'), null, 0));
    store().dispatch(addTaskCommand(makeTask('t2'), null, 1));
    store().dispatch(addDependencyCommand('t2', { targetId: 't1', type: 'FS', lag: 0 }));
    const t2 = store().file.tasks.find((t) => t.id === 't2')!;
    expect(t2.dependencies).toHaveLength(1);
    expect(t2.start).toBe('2026-01-12'); // rescheduled
    // Undo restores both the dependency AND the original start (atomic).
    store().undo();
    const t2Undo = store().file.tasks.find((t) => t.id === 't2')!;
    expect(t2Undo.dependencies).toHaveLength(0);
    expect(t2Undo.start).toBe('2026-01-05'); // original restored
  });

  it('updateTaskWithRollupCommand cascades: moving a predecessor reschedules successors', () => {
    const store = useProjectStore.getState;
    // Set up t1 (1/5-1/9) → t2 (FS, 1/12-1/16) so the dep is already satisfied.
    store().dispatch(
      addTaskCommand(
        makeTask('t1', { start: '2026-01-05', end: '2026-01-09', duration: 5 }),
        null,
        0,
      ),
    );
    store().dispatch(
      addTaskCommand(
        makeTask('t2', { start: '2026-01-12', end: '2026-01-16', duration: 5 }),
        null,
        1,
      ),
    );
    store().dispatch(addDependencyCommand('t2', { targetId: 't1', type: 'FS', lag: 0 }));
    // t2 should still be at 1/12 (dep already satisfied, no move).
    expect(store().file.tasks.find((t) => t.id === 't2')!.start).toBe('2026-01-12');
    // Now move t1 later by a week: 1/12 → 1/16. t2 must follow to 1/19.
    store().dispatch(
      updateTaskWithRollupCommand('t1', { start: '2026-01-12', end: '2026-01-16', duration: 5 }),
    );
    expect(store().file.tasks.find((t) => t.id === 't2')!.start).toBe('2026-01-19');
    // Undo moves t2 back atomically with t1.
    store().undo();
    expect(store().file.tasks.find((t) => t.id === 't1')!.start).toBe('2026-01-05');
    expect(store().file.tasks.find((t) => t.id === 't2')!.start).toBe('2026-01-12');
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

describe('updateTaskWithRollupCommand', () => {
  beforeEach(async () => {
    await reset();
  });

  it('should cascade progress changes to parent', async () => {
    const store = useProjectStore.getState;
    // Create parent and child
    store().dispatch(addTaskCommand(makeTask('parent'), null, 0));
    store().dispatch(
      addTaskCommand(
        makeTask('child', { parentId: 'parent', duration: 5, progress: 0 }),
        'parent',
        0,
      ),
    );

    // Update child progress to 80
    store().dispatch(updateTaskWithRollupCommand('child', { progress: 80 }));

    const parent = store().file.tasks.find((t) => t.id === 'parent');
    expect(parent!.progress).toBe(80);
  });

  it('should undo both child and parent changes', async () => {
    const store = useProjectStore.getState;
    // Create parent and child
    store().dispatch(addTaskCommand(makeTask('parent'), null, 0));
    store().dispatch(
      addTaskCommand(
        makeTask('child', { parentId: 'parent', duration: 5, progress: 0 }),
        'parent',
        0,
      ),
    );

    // Update child progress
    store().dispatch(updateTaskWithRollupCommand('child', { progress: 80 }));
    expect(store().file.tasks.find((t) => t.id === 'child')!.progress).toBe(80);
    expect(store().file.tasks.find((t) => t.id === 'parent')!.progress).toBe(80);

    // Undo should restore both
    store().undo();
    expect(store().file.tasks.find((t) => t.id === 'child')!.progress).toBe(0);
    expect(store().file.tasks.find((t) => t.id === 'parent')!.progress).toBe(0);
  });
});
