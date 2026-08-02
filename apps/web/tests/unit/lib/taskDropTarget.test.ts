import { describe, expect, it } from 'vitest';
import { computeDropPosition, resolveDropTarget } from '@/lib/taskDropTarget';
import type { Task } from '@ganttly/schema';

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

describe('computeDropPosition', () => {
  const ROW_HEIGHT = 32;

  it('top band (ratio < 0.25) → before', () => {
    expect(computeDropPosition(0, ROW_HEIGHT)).toBe('before');
    expect(computeDropPosition(7, ROW_HEIGHT)).toBe('before'); // 7/32 ≈ 0.22
  });

  it('bottom band (ratio > 0.75) → after', () => {
    expect(computeDropPosition(25, ROW_HEIGHT)).toBe('after'); // 25/32 ≈ 0.78
    expect(computeDropPosition(31, ROW_HEIGHT)).toBe('after');
  });

  it('middle band → inside', () => {
    expect(computeDropPosition(16, ROW_HEIGHT)).toBe('inside');
    expect(computeDropPosition(10, ROW_HEIGHT)).toBe('inside');
    expect(computeDropPosition(22, ROW_HEIGHT)).toBe('inside');
  });

  it('boundary: exactly at 0.25 falls inside (middle), exactly at 0.75 inside', () => {
    // 0.25 * 32 = 8 → ratio === EDGE_FRACTION → not < edge, not > (1-edge) → inside
    expect(computeDropPosition(8, ROW_HEIGHT)).toBe('inside');
    // 0.75 * 32 = 24 → ratio === 1-edge → not > (1-edge) → inside
    expect(computeDropPosition(24, ROW_HEIGHT)).toBe('inside');
  });

  it('zero row height defaults to inside (safe middle)', () => {
    expect(computeDropPosition(5, 0)).toBe('inside');
  });
});

describe('resolveDropTarget', () => {
  const a = makeTask('a', { order: 0 });
  const b = makeTask('b', { order: 1 });
  const c = makeTask('c', { order: 2 });
  const root = [a, b, c];

  it('before → same parent, index of target (excluding dragged)', () => {
    // drag c before a → parentId null, order 0 (a's index among siblings minus c)
    const t = resolveDropTarget('c', 'a', 'before', root);
    expect(t.parentId).toBeNull();
    expect(t.order).toBe(0);
    expect(t.invalid).toBe(false);
  });

  it('after → same parent, index+1 of target', () => {
    // drag a after b → parentId null, order 2 (b is index 0 among {b,c}, +1)
    const t = resolveDropTarget('a', 'b', 'after', root);
    expect(t.parentId).toBeNull();
    expect(t.order).toBe(1); // b is at index 0 in [b,c], after → 1
    expect(t.invalid).toBe(false);
  });

  it('inside → target becomes parent, order = child count', () => {
    // drop a inside b → parentId b, order 0 (b has no children)
    const t = resolveDropTarget('a', 'b', 'inside', root);
    expect(t.parentId).toBe('b');
    expect(t.order).toBe(0);
  });

  it('inside a parent with existing children → order = existing child count', () => {
    const parent = makeTask('parent');
    const child1 = makeTask('child1', { parentId: 'parent', order: 0 });
    const child2 = makeTask('child2', { parentId: 'parent', order: 1 });
    const lone = makeTask('lone', { order: 0 });
    // drop lone inside parent → order 2 (parent has 2 children, lone not counted)
    const t = resolveDropTarget('lone', 'parent', 'inside', [parent, child1, child2, lone]);
    expect(t.parentId).toBe('parent');
    expect(t.order).toBe(2);
  });

  it('dropping a task onto itself is invalid', () => {
    const t = resolveDropTarget('a', 'a', 'before', root);
    expect(t.invalid).toBe(true);
  });

  it('dropping a parent onto its own descendant is invalid', () => {
    // parent → child. Dragging parent onto child must be forbidden.
    const parent = makeTask('parent');
    const child = makeTask('child', { parentId: 'parent', order: 0 });
    const t = resolveDropTarget('parent', 'child', 'before', [parent, child]);
    expect(t.invalid).toBe(true);
  });

  it('dropping onto a descendant stays invalid for inside too', () => {
    const parent = makeTask('parent');
    const child = makeTask('child', { parentId: 'parent', order: 0 });
    const t = resolveDropTarget('parent', 'child', 'inside', [parent, child]);
    expect(t.invalid).toBe(true);
  });

  it('deeply nested descendant is detected', () => {
    // gp → p → c. Dragging gp onto c forbidden.
    const gp = makeTask('gp');
    const p = makeTask('p', { parentId: 'gp', order: 0 });
    const c = makeTask('c', { parentId: 'p', order: 0 });
    const t = resolveDropTarget('gp', 'c', 'after', [gp, p, c]);
    expect(t.invalid).toBe(true);
  });

  it('dragging an unrelated task onto a node is valid', () => {
    const gp = makeTask('gp');
    const p = makeTask('p', { parentId: 'gp', order: 0 });
    const c = makeTask('c', { parentId: 'p', order: 0 });
    const lone = makeTask('lone', { order: 0 });
    const t = resolveDropTarget('lone', 'c', 'before', [gp, p, c, lone]);
    expect(t.invalid).toBe(false);
    expect(t.parentId).toBe('p');
  });

  it('before on a target whose parent is itself non-root uses that parent', () => {
    const parent = makeTask('parent');
    const child1 = makeTask('child1', { parentId: 'parent', order: 0 });
    const child2 = makeTask('child2', { parentId: 'parent', order: 1 });
    const lone = makeTask('lone', { order: 0 });
    // drop lone before child2 → parentId parent, order = child2's index in [child1, child2] = 1
    const t = resolveDropTarget('lone', 'child2', 'before', [parent, child1, child2, lone]);
    expect(t.parentId).toBe('parent');
    expect(t.order).toBe(1);
  });

  it('missing target task → invalid', () => {
    const t = resolveDropTarget('a', 'nope', 'before', root);
    expect(t.invalid).toBe(true);
  });
});
