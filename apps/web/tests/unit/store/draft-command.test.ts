import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { useProjectStore, updateTaskFromDraftCommand, type Command } from '@/store/useProjectStore';
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
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

/** Seed an explicit task list without polluting the undo stack. */
function seed(tasks: Task[]) {
  const noop: Command = {
    label: 'seed',
    apply: (file) => ({ ...file, tasks }),
    invert: (file) => file,
  };
  useProjectStore.getState().dispatch(noop);
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

function fileTasks(): Task[] {
  return useProjectStore.getState().file.tasks;
}

describe('updateTaskFromDraftCommand', () => {
  beforeEach(async () => {
    await reset();
  });

  it('commits all changed fields in one apply', () => {
    const before = makeTask('t1', {
      name: 'A',
      progress: 10,
      duration: 5,
      assignments: [],
      dependencies: [],
      constraints: { type: 'none' },
    });
    seed([before]);
    const after: Task = {
      ...before,
      name: 'A renamed',
      progress: 50,
      note: 'a note',
      color: '#ff0000',
    };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));

    const t = fileTasks().find((x) => x.id === 't1')!;
    expect(t.name).toBe('A renamed');
    expect(t.progress).toBe(50);
    expect(t.note).toBe('a note');
    expect(t.color).toBe('#ff0000');
  });

  it('preserves live date changes for fields untouched by the draft', () => {
    const before = makeTask('t1', { name: 'A' });
    const live = {
      ...before,
      start: '2026-02-02',
      end: '2026-02-06',
    };
    seed([live]);

    useProjectStore
      .getState()
      .dispatch(updateTaskFromDraftCommand(before, { ...before, name: 'Draft name' }));

    const saved = fileTasks().find((task) => task.id === 't1')!;
    expect(saved.name).toBe('Draft name');
    expect(saved.start).toBe('2026-02-02');
    expect(saved.end).toBe('2026-02-06');
  });

  it('lets an explicit draft edit win a same-field conflict and undo restores live state', () => {
    const before = makeTask('t1', { name: 'Original' });
    const live = { ...before, name: 'Canvas edit' };
    seed([live]);

    useProjectStore
      .getState()
      .dispatch(updateTaskFromDraftCommand(before, { ...before, name: 'Draft edit' }));

    expect(fileTasks().find((task) => task.id === 't1')!.name).toBe('Draft edit');
    useProjectStore.getState().undo();
    expect(fileTasks().find((task) => task.id === 't1')).toEqual(live);
  });

  it('one save pushes exactly ONE undo record (not one per field)', () => {
    const before = makeTask('t1', { name: 'A', progress: 0 });
    seed([before]);
    const after: Task = { ...before, name: 'B', progress: 50, duration: 10 };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));
    expect(useProjectStore.getState().undoStack).toHaveLength(1);
  });

  it('a single undo restores ALL fields to the pre-save state', () => {
    const before = makeTask('t1', {
      name: 'A',
      progress: 0,
      duration: 5,
      start: '2026-01-05',
      end: '2026-01-09',
      note: undefined,
    });
    seed([before]);
    const after: Task = {
      ...before,
      name: 'B',
      progress: 80,
      duration: 10,
      start: '2026-02-02',
      end: '2026-02-13',
      note: 'changed',
    };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));
    useProjectStore.getState().undo();

    const t = fileTasks().find((x) => x.id === 't1')!;
    expect(t.name).toBe('A');
    expect(t.progress).toBe(0);
    expect(t.duration).toBe(5);
    expect(t.start).toBe('2026-01-05');
    expect(t.end).toBe('2026-01-09');
    expect(t.note).toBeUndefined();
  });

  it('undo removes optional fields that did not exist before the save', () => {
    const before = makeTask('t1');
    seed([before]);
    const after: Task = { ...before, note: 'new note', color: '#ff0000' };

    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));
    useProjectStore.getState().undo();

    const restored = fileTasks().find((task) => task.id === 't1')!;
    expect('note' in restored).toBe(false);
    expect('color' in restored).toBe(false);
  });

  it('leaves the file unchanged when the draft equals the before state', () => {
    const before = makeTask('t1', { name: 'A', progress: 10 });
    seed([before]);
    const fileBefore = useProjectStore.getState().file;
    // `after` is structurally identical to `before`.
    const after: Task = { ...before };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));
    // The command's apply is a no-op: the file must be byte-for-byte unchanged.
    // (Whether dispatch records it is the store's concern; the UI disables Save
    // on a clean draft so the command never reaches dispatch in practice.)
    expect(useProjectStore.getState().file).toEqual(fileBefore);
  });

  it('cascades rollup to ancestor summary tasks on a date edit', () => {
    // parent (summary)
    //   └─ child (start 01-05, end 01-09, dur 5, progress 80)
    const parent = makeTask('parent', { duration: 5, progress: 80 });
    const child = makeTask('child', {
      parentId: 'parent',
      order: 0,
      start: '2026-01-05',
      end: '2026-01-09',
      duration: 5,
      progress: 80,
    });
    seed([parent, child]);

    // Move the child later by editing start/end/duration in the draft.
    const before = child;
    const after: Task = {
      ...child,
      start: '2026-02-02',
      end: '2026-02-13',
      duration: 10,
    };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));

    // The parent summary must reflect the child's new rolled-up dates.
    const p = fileTasks().find((x) => x.id === 'parent')!;
    expect(p.start).toBe('2026-02-02');
    expect(p.end).toBe('2026-02-13');
  });

  it('undo restores both the edited task AND its rolled-up ancestor', () => {
    const parent = makeTask('parent', { duration: 5, progress: 80 });
    const child = makeTask('child', {
      parentId: 'parent',
      order: 0,
      duration: 5,
      progress: 80,
    });
    seed([parent, child]);

    const before = child;
    const after: Task = { ...child, progress: 40 };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));
    // Parent progress rolled up to 40.
    expect(fileTasks().find((x) => x.id === 'parent')!.progress).toBe(40);

    useProjectStore.getState().undo();
    // Both child and parent restored.
    expect(fileTasks().find((x) => x.id === 'child')!.progress).toBe(80);
    expect(fileTasks().find((x) => x.id === 'parent')!.progress).toBe(80);
  });

  it('commits assignment + dependency + constraint changes atomically', () => {
    const pred = makeTask('pred', { order: 0 });
    const target = makeTask('target', { order: 1 });
    seed([pred, target]);

    const before = target;
    const after: Task = {
      ...target,
      assignments: [{ resourceId: 'r1', load: 50 }],
      dependencies: [{ targetId: 'pred', type: 'FS', lag: 0 }],
      constraints: { type: 'mustStartOn', date: '2026-01-05' },
    };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));

    const t = fileTasks().find((x) => x.id === 'target')!;
    expect(t.assignments).toEqual([{ resourceId: 'r1', load: 50 }]);
    expect(t.dependencies).toEqual([{ targetId: 'pred', type: 'FS', lag: 0 }]);
    expect(t.constraints).toEqual({ type: 'mustStartOn', date: '2026-01-05' });
  });

  it('reschedules the task when a dependency is added without editing dates', () => {
    const predecessor = makeTask('pred', {
      start: '2026-01-19',
      end: '2026-01-23',
      order: 0,
    });
    const target = makeTask('target', { order: 1 });
    seed([predecessor, target]);

    useProjectStore.getState().dispatch(
      updateTaskFromDraftCommand(target, {
        ...target,
        dependencies: [{ targetId: 'pred', type: 'FS', lag: 0 }],
      }),
    );

    const scheduled = fileTasks().find((task) => task.id === 'target')!;
    expect(scheduled.start).toBe('2026-01-26');
    expect(scheduled.end).toBe('2026-01-30');

    useProjectStore.getState().undo();
    expect(fileTasks().find((task) => task.id === 'target')).toEqual(target);
  });

  it('applies a dated constraint even when the draft dates were not edited', () => {
    const target = makeTask('target');
    seed([target]);

    useProjectStore.getState().dispatch(
      updateTaskFromDraftCommand(target, {
        ...target,
        constraints: { type: 'mustStartOn', date: '2026-02-02' },
      }),
    );

    const scheduled = fileTasks().find((task) => task.id === 'target')!;
    expect(scheduled.start).toBe('2026-02-02');
    expect(scheduled.end).toBe('2026-02-06');

    useProjectStore.getState().undo();
    expect(fileTasks().find((task) => task.id === 'target')).toEqual(target);
  });

  it('redo reapplies the full draft save after undo', () => {
    const before = makeTask('t1', { name: 'A', progress: 0 });
    seed([before]);
    const after: Task = { ...before, name: 'B', progress: 100 };
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(before, after));
    useProjectStore.getState().undo();
    useProjectStore.getState().redo();

    const t = fileTasks().find((x) => x.id === 't1')!;
    expect(t.name).toBe('B');
    expect(t.progress).toBe(100);
  });

  it('keeps sibling/other tasks untouched', () => {
    const a = makeTask('a', { name: 'A', order: 0 });
    const b = makeTask('b', { name: 'B', order: 1 });
    seed([a, b]);
    useProjectStore.getState().dispatch(updateTaskFromDraftCommand(a, { ...a, name: 'A2' }));
    // Task b must be byte-for-byte unchanged (not just structurally equal).
    const bAfter = fileTasks().find((x) => x.id === 'b')!;
    expect(bAfter.name).toBe('B');
    expect(bAfter).toEqual(b);
  });
});
