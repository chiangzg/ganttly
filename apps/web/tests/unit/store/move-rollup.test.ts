import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  useProjectStore,
  moveTaskWithRollupCommand,
  updateTaskWithRollupCommand,
  type Command,
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
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

/**
 * Seed the store with an explicit task list via a one-shot non-undoable
 * command. Keeping it inline avoids depending on addTask/moveTask rollup
 * semantics during setup.
 */
function seed(tasks: Task[]) {
  const noop: Command = {
    label: 'seed',
    apply: (file) => ({ ...file, tasks }),
    invert: (file) => file,
  };
  useProjectStore.getState().dispatch(noop);
  useProjectStore.setState({ undoStack: [], redoStack: [] });
}

describe('moveTaskWithRollupCommand', () => {
  beforeEach(async () => {
    await reset();
  });

  it('moving an only child out makes the old parent a leaf (no rollup overwrite)', () => {
    // parent (summary)
    //   └─ onlyChild (duration=5, progress=80)
    const parent = makeTask('parent', { duration: 5, progress: 80 });
    const onlyChild = makeTask('onlyChild', {
      parentId: 'parent',
      order: 0,
      duration: 5,
      progress: 80,
    });
    seed([parent, onlyChild]);

    const store = useProjectStore.getState;
    // Move onlyChild out to top level
    store().dispatch(moveTaskWithRollupCommand('onlyChild', null, 0));

    const parentAfter = store().file.tasks.find((t) => t.id === 'parent')!;
    // parent is now a leaf — its values must be its own (5 / 80), unchanged
    expect(parentAfter.duration).toBe(5);
    expect(parentAfter.progress).toBe(80);
  });

  it('moving a child out of a parent with siblings recomputes the parent', () => {
    // parent (summary)
    //   ├─ childA (duration=4, progress=50)
    //   └─ childB (duration=6, progress=100)
    // parent rollup = (50*4 + 100*6)/(4+6) = 80, duration = 10
    const parent = makeTask('parent', { progress: 0 });
    const childA = makeTask('childA', {
      parentId: 'parent',
      order: 0,
      start: '2026-01-05',
      end: '2026-01-08',
      duration: 4,
      progress: 50,
    });
    const childB = makeTask('childB', {
      parentId: 'parent',
      order: 1,
      start: '2026-01-05',
      end: '2026-01-10',
      duration: 6,
      progress: 100,
    });
    seed([parent, childA, childB]);

    const store = useProjectStore.getState;

    // Move childA out to top level — parent should now only reflect childB
    store().dispatch(moveTaskWithRollupCommand('childA', null, 0));

    const parentAfter = store().file.tasks.find((t) => t.id === 'parent')!;
    // parent now has only childB → progress 100, duration 6
    expect(parentAfter.progress).toBe(100);
    expect(parentAfter.duration).toBe(6);
    // Time range collapses to childB's
    expect(parentAfter.start).toBe('2026-01-05');
    expect(parentAfter.end).toBe('2026-01-10');
  });

  it('moving a child into a new parent recomputes the new parent', () => {
    // parentA (summary)
    //   └─ a1 (duration=5, progress=40)  → parentA rollup: 40, 5
    // parentB (summary, empty)           → will become child's summary
    // loner (duration=3, progress=100)  → moving into parentB
    const parentA = makeTask('parentA');
    const a1 = makeTask('a1', {
      parentId: 'parentA',
      order: 0,
      duration: 5,
      progress: 40,
    });
    const parentB = makeTask('parentB');
    const loner = makeTask('loner', {
      duration: 3,
      progress: 100,
    });
    seed([parentA, a1, parentB, loner]);

    const store = useProjectStore.getState;

    // First, establish parentA's rolled-up value via a no-op rollup update on a1
    store().dispatch(updateTaskWithRollupCommand('a1', { progress: 40 }));
    const parentARolled = store().file.tasks.find((t) => t.id === 'parentA')!;
    expect(parentARolled.progress).toBe(40);

    // Move loner INTO parentB as its first child
    store().dispatch(moveTaskWithRollupCommand('loner', 'parentB', 0));

    const parentBAfter = store().file.tasks.find((t) => t.id === 'parentB')!;
    // parentB now has only loner → progress 100, duration 3
    expect(parentBAfter.progress).toBe(100);
    expect(parentBAfter.duration).toBe(3);

    // parentA unaffected by this move (loner wasn't its child)
    const parentAAfter = store().file.tasks.find((t) => t.id === 'parentA')!;
    expect(parentAAfter.progress).toBe(40);
  });

  it('undo restores moved task AND recomputed parents', () => {
    const parent = makeTask('parent');
    const childA = makeTask('childA', {
      parentId: 'parent',
      order: 0,
      duration: 4,
      progress: 50,
    });
    const childB = makeTask('childB', {
      parentId: 'parent',
      order: 1,
      duration: 6,
      progress: 100,
    });
    seed([parent, childA, childB]);

    const store = useProjectStore.getState;
    const parentBefore = store().file.tasks.find((t) => t.id === 'parent')!;
    const childABefore = store().file.tasks.find((t) => t.id === 'childA')!;

    store().dispatch(moveTaskWithRollupCommand('childA', null, 0));
    // sanity: parent changed
    expect(store().file.tasks.find((t) => t.id === 'parent')!.progress).toBe(100);

    store().undo();

    const parentAfter = store().file.tasks.find((t) => t.id === 'parent')!;
    const childAAfter = store().file.tasks.find((t) => t.id === 'childA')!;
    expect(parentAfter).toEqual(parentBefore);
    expect(childAAfter).toEqual(childABefore);
  });

  it('moving a task with no parent change only re-orders (no rollup writes)', () => {
    // Reorder within the same parent shouldn't touch rollup values. Orders are
    // renormalized to 0..n-1 so there are no gaps/duplicates (plan §2.3 step 4).
    const parent = makeTask('parent');
    const childA = makeTask('childA', {
      parentId: 'parent',
      order: 0,
      duration: 4,
      progress: 50,
    });
    const childB = makeTask('childB', {
      parentId: 'parent',
      order: 1,
      duration: 6,
      progress: 100,
    });
    seed([parent, childA, childB]);

    const store = useProjectStore.getState;
    const parentProgressBefore = store().file.tasks.find((t) => t.id === 'parent')!.progress;

    // Same parent, move childA past childB (to the end).
    store().dispatch(moveTaskWithRollupCommand('childA', 'parent', 2));

    const parentAfter = store().file.tasks.find((t) => t.id === 'parent')!;
    expect(parentAfter.progress).toBe(parentProgressBefore);
    // Orders are packed: childA is now last → order 1, childB → order 0.
    const childAAfter = store().file.tasks.find((t) => t.id === 'childA')!;
    const childBAfter = store().file.tasks.find((t) => t.id === 'childB')!;
    expect(childAAfter.order).toBe(1);
    expect(childBAfter.order).toBe(0);
  });

  it('undo restores every renormalized sibling order, not just the moved task', () => {
    // Three top-level siblings. Moving C to the front shifts A→1, B→2.
    // Undo must restore A→0, B→1, C→2 exactly (the renormalize capture path).
    const a = makeTask('a', { order: 0 });
    const b = makeTask('b', { order: 1 });
    const c = makeTask('c', { order: 2 });
    seed([a, b, c]);

    const store = useProjectStore.getState;
    const before = store().file.tasks.map((t) => ({ id: t.id, order: t.order }));

    // Move c before a → c should land at order 0, a→1, b→2.
    store().dispatch(moveTaskWithRollupCommand('c', null, 0));
    expect(store().file.tasks.find((t) => t.id === 'c')!.order).toBe(0);
    expect(store().file.tasks.find((t) => t.id === 'a')!.order).toBe(1);
    expect(store().file.tasks.find((t) => t.id === 'b')!.order).toBe(2);

    store().undo();
    const after = store().file.tasks.map((t) => ({ id: t.id, order: t.order }));
    expect(after).toEqual(before);
  });

  it('orders stay compact (0..n-1) after repeated same-parent moves', () => {
    const a = makeTask('a', { order: 0 });
    const b = makeTask('b', { order: 1 });
    const c = makeTask('c', { order: 2 });
    seed([a, b, c]);

    const store = useProjectStore.getState;
    // Move a to the end, then b to the end. Orders must always be 0..2.
    store().dispatch(moveTaskWithRollupCommand('a', null, 99));
    store().dispatch(moveTaskWithRollupCommand('b', null, 99));

    const orders = store()
      .file.tasks.filter((t) => t.parentId === null)
      .map((t) => t.order)
      .sort((x, y) => x - y);
    expect(orders).toEqual([0, 1, 2]);
  });
});
