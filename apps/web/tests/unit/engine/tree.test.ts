import { describe, expect, it } from 'vitest';
import {
  buildTree,
  findTask,
  flattenAll,
  flattenVisible,
  isAncestor,
  wbsNumber,
} from '@/engine/scene';
import type { Task } from '@ganttly/schema';

function makeTask(
  id: string,
  name: string,
  parentId: string | null,
  order: number,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    name,
    parentId,
    order,
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

describe('buildTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('builds a single-level list with stable order', () => {
    const tasks = [
      makeTask('t3', 'c', null, 2),
      makeTask('t1', 'a', null, 0),
      makeTask('t2', 'b', null, 1),
    ];
    const tree = buildTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual(['t1', 't2', 't3']);
  });

  it('builds a nested tree by parentId', () => {
    const tasks = [
      makeTask('t1', 'parent', null, 0),
      makeTask('t2', 'child1', 't1', 0),
      makeTask('t3', 'child2', 't1', 1),
      makeTask('t4', 'grandchild', 't2', 0),
    ];
    const tree = buildTree(tasks);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.task.id).toBe('t1');
    expect(tree[0]?.children.map((c) => c.task.id)).toEqual(['t2', 't3']);
    expect(tree[0]?.children[0]?.children[0]?.task.id).toBe('t4');
  });

  it('computes depth correctly', () => {
    const tasks = [
      makeTask('t1', 'a', null, 0),
      makeTask('t2', 'b', 't1', 0),
      makeTask('t3', 'c', 't2', 0),
    ];
    const tree = buildTree(tasks);
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.children[0]?.depth).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it('computes ancestorIds correctly', () => {
    const tasks = [
      makeTask('t1', 'a', null, 0),
      makeTask('t2', 'b', 't1', 0),
      makeTask('t3', 'c', 't2', 0),
    ];
    const tree = buildTree(tasks);
    expect(tree[0]?.ancestorIds).toEqual([]);
    expect(tree[0]?.children[0]?.ancestorIds).toEqual(['t1']);
    expect(tree[0]?.children[0]?.children[0]?.ancestorIds).toEqual(['t1', 't2']);
  });

  it('promotes orphans to top-level', () => {
    const tasks = [makeTask('t1', 'a', null, 0), makeTask('t2', 'orphan', 'missing-parent', 1)];
    const tree = buildTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual(['t1', 't2']);
  });
});

describe('flattenVisible', () => {
  const tasks = [
    makeTask('t1', 'a', null, 0),
    makeTask('t2', 'b', 't1', 0),
    makeTask('t3', 'c', 't2', 0),
    makeTask('t4', 'd', 't1', 1),
  ];
  const tree = buildTree(tasks);

  it('returns all nodes when nothing collapsed', () => {
    expect(flattenVisible(tree, new Set()).map((n) => n.task.id)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('skips subtree when root collapsed', () => {
    const flat = flattenVisible(tree, new Set(['t2']));
    expect(flat.map((n) => n.task.id)).toEqual(['t1', 't2', 't4']);
  });

  it('top-level collapse hides everything below', () => {
    const flat = flattenVisible(tree, new Set(['t1']));
    expect(flat.map((n) => n.task.id)).toEqual(['t1']);
  });
});

describe('flattenAll', () => {
  it('returns everything regardless of collapse', () => {
    const tasks = [makeTask('t1', 'a', null, 0), makeTask('t2', 'b', 't1', 0)];
    const tree = buildTree(tasks);
    expect(flattenAll(tree).map((n) => n.task.id)).toEqual(['t1', 't2']);
  });
});

describe('wbsNumber', () => {
  it('numbers top-level tasks 1-indexed', () => {
    const tasks = [makeTask('t1', 'a', null, 0), makeTask('t2', 'b', null, 1)];
    const tree = buildTree(tasks);
    expect(wbsNumber(tree[0]!, tree)).toBe('1');
    expect(wbsNumber(tree[1]!, tree)).toBe('2');
  });

  it('numbers nested tasks hierarchically', () => {
    const tasks = [
      makeTask('t1', 'a', null, 0),
      makeTask('t2', 'b', 't1', 0),
      makeTask('t3', 'c', 't1', 1),
      makeTask('t4', 'd', 't2', 0),
    ];
    const tree = buildTree(tasks);
    expect(wbsNumber(tree[0]!, tree)).toBe('1');
    expect(wbsNumber(tree[0]!.children[0]!, tree)).toBe('1.1');
    expect(wbsNumber(tree[0]!.children[1]!, tree)).toBe('1.2');
    expect(wbsNumber(tree[0]!.children[0]!.children[0]!, tree)).toBe('1.1.1');
  });
});

describe('findTask', () => {
  it('returns matching task', () => {
    const tasks = [makeTask('t1', 'a', null, 0)];
    expect(findTask(tasks, 't1')?.name).toBe('a');
  });
  it('returns undefined for missing id', () => {
    expect(findTask([makeTask('t1', 'a', null, 0)], 'x')).toBeUndefined();
  });
});

describe('isAncestor', () => {
  const tasks = [
    makeTask('t1', 'a', null, 0),
    makeTask('t2', 'b', 't1', 0),
    makeTask('t3', 'c', 't2', 0),
  ];

  it('detects direct parent', () => {
    expect(isAncestor(tasks, 't3', 't2')).toBe(true);
  });
  it('detects transitive ancestor', () => {
    expect(isAncestor(tasks, 't3', 't1')).toBe(true);
  });
  it('returns false for non-ancestors', () => {
    expect(isAncestor(tasks, 't1', 't2')).toBe(false);
  });
  it('returns false for self', () => {
    expect(isAncestor(tasks, 't1', 't1')).toBe(false);
  });
});
