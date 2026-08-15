import { describe, expect, it } from 'vitest';
import { computeBatchDeleteImpact } from '../src/deleteImpact';
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

describe('computeBatchDeleteImpact', () => {
  it('counts only the selected independent tasks', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const impact = computeBatchDeleteImpact(['a', 'c'], tasks);
    expect(impact.totalDeleted).toBe(2);
    expect(impact.dependencyCount).toBe(0);
  });

  it('cascades descendants of any selected task', () => {
    const tasks = [
      makeTask('parent'),
      makeTask('child1', { parentId: 'parent' }),
      makeTask('child2', { parentId: 'parent' }),
      makeTask('other'),
    ];
    const impact = computeBatchDeleteImpact(['parent'], tasks);
    expect(impact.totalDeleted).toBe(3); // parent + 2 children
  });

  it('parent+child both selected: counts the union once, not double', () => {
    const tasks = [
      makeTask('parent'),
      makeTask('child', { parentId: 'parent' }),
      makeTask('other'),
    ];
    const impact = computeBatchDeleteImpact(['parent', 'child'], tasks);
    // parent + child = 2 (not 3 — child is not recounted as a cascade)
    expect(impact.totalDeleted).toBe(2);
  });

  it('counts dependency edges pointing INTO the deleted set from survivors', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c', { dependencies: [{ targetId: 'a', type: 'FS', lag: 0 }] }),
      makeTask('d', { dependencies: [{ targetId: 'b', type: 'FS', lag: 0 }] }),
    ];
    const impact = computeBatchDeleteImpact(['a', 'b'], tasks);
    expect(impact.totalDeleted).toBe(2);
    expect(impact.dependencyCount).toBe(2); // c→a and d→b
  });

  it('ignores dependency edges where the source itself is deleted', () => {
    const tasks = [
      makeTask('a', { dependencies: [{ targetId: 'b', type: 'FS', lag: 0 }] }),
      makeTask('b'),
      makeTask('c'),
    ];
    // Both a and b are deleted — a's edge to b does NOT count (a is gone too).
    const impact = computeBatchDeleteImpact(['a', 'b'], tasks);
    expect(impact.totalDeleted).toBe(2);
    expect(impact.dependencyCount).toBe(0);
  });

  it('returns zero impact for an empty selection', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    const impact = computeBatchDeleteImpact([], tasks);
    expect(impact.totalDeleted).toBe(0);
    expect(impact.dependencyCount).toBe(0);
  });
});
