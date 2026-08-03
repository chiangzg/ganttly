import { describe, expect, it } from 'vitest';
import { computeTaskPosition } from '@/lib/taskPosition';
import { createDefaultTask, type Task } from '@ganttly/schema';

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  const t = createDefaultTask({ id, name: id, start: '2026-01-05', parentId: null, order: 0 });
  return { ...t, ...overrides };
}

/** Roots a, b, c (ordered 0..2) + child x of b + grandchildren y,z of x. */
function makeTree(): Task[] {
  return [
    makeTask('a', { order: 0 }),
    makeTask('b', { order: 1 }),
    makeTask('c', { order: 2 }),
    makeTask('x', { parentId: 'b', order: 0 }),
    makeTask('y', { parentId: 'x', order: 0 }),
    makeTask('z', { parentId: 'x', order: 1 }),
  ];
}

describe('computeTaskPosition', () => {
  it('first root: cannot move up, can move down, cannot indent/outdent', () => {
    const pos = computeTaskPosition('a', makeTree());
    expect(pos).toEqual({
      canMoveUp: false,
      canMoveDown: true,
      canIndent: false,
      canOutdent: false,
    });
  });

  it('middle root: can move both ways, cannot indent/outdent', () => {
    const pos = computeTaskPosition('b', makeTree());
    expect(pos).toEqual({
      canMoveUp: true,
      canMoveDown: true,
      canIndent: true, // has a previous sibling (a) to nest under
      canOutdent: false, // already a root
    });
  });

  it('last root: can move up, cannot move down', () => {
    const pos = computeTaskPosition('c', makeTree());
    expect(pos.canMoveUp).toBe(true);
    expect(pos.canMoveDown).toBe(false);
    expect(pos.canOutdent).toBe(false);
  });

  it('only-child leaf under a root: cannot move, can indent (has previous sibling)', () => {
    const tasks = [
      makeTask('r', { order: 0 }),
      makeTask('x', { parentId: 'r', order: 0 }),
      makeTask('y', { parentId: 'r', order: 1 }),
    ];
    const pos = computeTaskPosition('x', tasks);
    expect(pos).toEqual({
      canMoveUp: false,
      canMoveDown: true,
      canIndent: false, // first child of r — no previous sibling
      canOutdent: true, // has a parent (r)
    });
  });

  it('second child: can move + indent + outdent', () => {
    const tasks = [
      makeTask('r', { order: 0 }),
      makeTask('x', { parentId: 'r', order: 0 }),
      makeTask('y', { parentId: 'r', order: 1 }),
    ];
    const pos = computeTaskPosition('y', tasks);
    expect(pos).toEqual({
      canMoveUp: true,
      canMoveDown: false,
      canIndent: true, // previous sibling x exists
      canOutdent: true, // has a parent
    });
  });

  it('first child of x: cannot move up, can move down (z follows)', () => {
    const pos = computeTaskPosition('y', makeTree());
    expect(pos.canOutdent).toBe(true); // has a parent (x)
    expect(pos.canMoveUp).toBe(false); // first child of x
    expect(pos.canMoveDown).toBe(true); // z follows
    expect(pos.canIndent).toBe(false); // no previous sibling to nest under
  });

  it('last child of x: can move up, cannot move down', () => {
    const pos = computeTaskPosition('z', makeTree());
    expect(pos.canMoveUp).toBe(true); // y precedes
    expect(pos.canMoveDown).toBe(false);
    expect(pos.canIndent).toBe(true); // previous sibling y exists
    expect(pos.canOutdent).toBe(true);
  });

  it('unknown task id: everything false (safe for a stale menu)', () => {
    const pos = computeTaskPosition('nope', makeTree());
    expect(pos).toEqual({
      canMoveUp: false,
      canMoveDown: false,
      canIndent: false,
      canOutdent: false,
    });
  });

  it('ignores tasks from OTHER parents when computing siblings', () => {
    // z's sibling group is just {y, z}; root siblings must not leak in.
    const pos = computeTaskPosition('z', makeTree());
    expect(pos.canMoveUp).toBe(true);
    expect(pos.canMoveDown).toBe(false);
  });

  it('sibling order is numeric, not insertion order', () => {
    // Same tree, but b declared AFTER its children — order field must win.
    const tasks = [
      makeTask('a', { order: 0 }),
      makeTask('c', { order: 2 }),
      makeTask('x', { parentId: 'b', order: 0 }),
      makeTask('b', { order: 1 }),
    ];
    const pos = computeTaskPosition('b', tasks);
    expect(pos.canMoveUp).toBe(true);
    expect(pos.canMoveDown).toBe(true);
  });
});
