import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  useProjectStore,
  createBaselineCommand,
  renameBaselineCommand,
  deleteBaselineCommand,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import type { Baseline, GanttlyFile, Task } from '@ganttly/schema';
import { createEmptyFile } from '@ganttly/schema';
import { setRepository } from '@/data/createRepository';
import { IndexedDBRepository } from '@/data/indexeddb';

function makeBaseline(id: string, overrides: Partial<Baseline> = {}): Baseline {
  return {
    id,
    name: `基线 ${id}`,
    capturedAt: '2026-07-28T00:00:00.000Z',
    tasks: [{ id: 'A', start: '2026-02-02', end: '2026-02-06', duration: 5, progress: 0 }],
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-02-02',
    end: '2026-02-06',
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

async function reset(tasks: Task[] = [makeTask('A')], baselines: Baseline[] = []) {
  const repo = new IndexedDBRepository();
  for (const m of await repo.listProjects()) await repo.deleteProject(m.id);
  setRepository(repo);
  await useProjectStore.getState().init(repo);
  const file: GanttlyFile = { ...createEmptyFile({ name: 't' }), tasks, baselines };
  useProjectStore.setState({ file, undoStack: [], redoStack: [] });
  useViewStore.getState().setActiveBaselineId(null);
}

// ===========================================================================
// Pure command behavior (apply / invert)
// ===========================================================================

describe('createBaselineCommand', () => {
  it('appends the snapshot on apply and removes it by id on invert', () => {
    const b = makeBaseline('b1');
    const cmd = createBaselineCommand(b);
    const file = createEmptyFile({ name: 't' });
    const next = cmd.apply(file);
    expect(next.baselines).toHaveLength(1);
    expect(next.baselines[0]).toBe(b);
    const restored = cmd.invert(next);
    expect(restored.baselines).toHaveLength(0);
  });

  it('preserves pre-existing baselines', () => {
    const existing = makeBaseline('old');
    const file: GanttlyFile = { ...createEmptyFile({ name: 't' }), baselines: [existing] };
    const next = createBaselineCommand(makeBaseline('new')).apply(file);
    expect(next.baselines.map((b) => b.id)).toEqual(['old', 'new']);
  });
});

describe('renameBaselineCommand', () => {
  it('renames on apply and restores the old name on invert', () => {
    const b = makeBaseline('b1', { name: '初始计划' });
    const file: GanttlyFile = { ...createEmptyFile({ name: 't' }), baselines: [b] };
    const cmd = renameBaselineCommand('b1', '重命名后');
    const next = cmd.apply(file);
    expect(next.baselines[0]!.name).toBe('重命名后');
    expect(next.baselines[0]!.capturedAt).toBe(b.capturedAt); // untouched
    const restored = cmd.invert(next);
    expect(restored.baselines[0]!.name).toBe('初始计划');
  });

  it('is a no-op when the id does not exist', () => {
    const file = createEmptyFile({ name: 't' });
    const cmd = renameBaselineCommand('missing', 'x');
    expect(cmd.apply(file)).toBe(file);
  });
});

describe('deleteBaselineCommand', () => {
  it('removes on apply and restores data AND original array position on invert', () => {
    const b1 = makeBaseline('b1');
    const b2 = makeBaseline('b2');
    const b3 = makeBaseline('b3');
    const file: GanttlyFile = { ...createEmptyFile({ name: 't' }), baselines: [b1, b2, b3] };
    const cmd = deleteBaselineCommand('b2');
    const next = cmd.apply(file);
    expect(next.baselines.map((b) => b.id)).toEqual(['b1', 'b3']);
    const restored = cmd.invert(next);
    // Original position (index 1) is restored.
    expect(restored.baselines.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(restored.baselines[1]).toBe(b2); // same reference
  });

  it('is a no-op when the id does not exist', () => {
    const file = createEmptyFile({ name: 't' });
    const cmd = deleteBaselineCommand('missing');
    expect(cmd.apply(file)).toBe(file);
  });
});

// ===========================================================================
// Store integration: dispatch, undo/redo, dirty/autosave, stale-id cleanup
// ===========================================================================

describe('baseline commands via store dispatch', () => {
  beforeEach(async () => {
    await reset();
  });

  it('create → undo → redo round-trip', async () => {
    const { dispatch, undo, redo } = useProjectStore.getState();
    const b = makeBaseline('b1');
    dispatch(createBaselineCommand(b));
    expect(useProjectStore.getState().file.baselines).toHaveLength(1);
    undo();
    expect(useProjectStore.getState().file.baselines).toHaveLength(0);
    redo();
    expect(useProjectStore.getState().file.baselines).toHaveLength(1);
    expect(useProjectStore.getState().file.baselines[0]).toBe(b);
  });

  it('rename → undo → redo round-trip', async () => {
    const b = makeBaseline('b1', { name: '初始计划' });
    await reset([makeTask('A')], [b]);
    const { dispatch, undo, redo } = useProjectStore.getState();
    dispatch(renameBaselineCommand('b1', '新版'));
    expect(useProjectStore.getState().file.baselines[0]!.name).toBe('新版');
    undo();
    expect(useProjectStore.getState().file.baselines[0]!.name).toBe('初始计划');
    redo();
    expect(useProjectStore.getState().file.baselines[0]!.name).toBe('新版');
  });

  it('delete → undo restores data and original position', async () => {
    const b1 = makeBaseline('b1');
    const b2 = makeBaseline('b2');
    await reset([makeTask('A')], [b1, b2]);
    const { dispatch, undo } = useProjectStore.getState();
    dispatch(deleteBaselineCommand('b1'));
    expect(useProjectStore.getState().file.baselines.map((b) => b.id)).toEqual(['b2']);
    undo();
    expect(useProjectStore.getState().file.baselines.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('a new command clears the redo stack', async () => {
    const { dispatch, undo } = useProjectStore.getState();
    dispatch(createBaselineCommand(makeBaseline('b1')));
    undo();
    expect(useProjectStore.getState().redoStack).toHaveLength(1);
    dispatch(createBaselineCommand(makeBaseline('b2')));
    expect(useProjectStore.getState().redoStack).toHaveLength(0);
  });

  it('dispatch marks the file dirty (triggers debounced autosave)', async () => {
    const { dispatch } = useProjectStore.getState();
    expect(useProjectStore.getState().dirty).toBe(false);
    dispatch(createBaselineCommand(makeBaseline('b1')));
    expect(useProjectStore.getState().dirty).toBe(true);
    expect(useProjectStore.getState().saveState.status).toBe('saving');
  });
});
