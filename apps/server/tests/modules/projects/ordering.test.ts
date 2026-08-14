import { describe, expect, it } from 'vitest';
import type { Task } from '@ganttly/schema';
import { HttpError } from '../../../src/modules/errors';
import {
  isSelfOrDescendant,
  moveInsertIndex,
  planInsertion,
  sortedSiblings,
} from '../../../src/modules/projects/ordering';

function task(id: string, parentId: string | null, order: number, name = id): Task {
  return {
    id,
    name,
    parentId,
    order,
    start: '2026-01-01',
    end: '2026-01-01',
    duration: 1,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
  };
}

const tasks: Task[] = [
  task('root', null, 0),
  task('a', 'root', 0),
  task('b', 'root', 1),
  task('c', 'root', 2),
  task('d', 'a', 0),
];

describe('sortedSiblings', () => {
  it('returns children of a parent sorted by order', () => {
    const sibs = sortedSiblings(tasks, 'root');
    expect(sibs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns top-level tasks for null parent', () => {
    expect(sortedSiblings(tasks, null).map((t) => t.id)).toEqual(['root']);
  });
});

describe('planInsertion', () => {
  it('appends at the end when afterTaskId is absent', () => {
    const plan = planInsertion(tasks, 'root', null);
    expect(plan.order).toBe(3);
    expect(plan.shiftThreshold).toBe(Number.POSITIVE_INFINITY);
  });

  it('starts at 0 for an empty sibling set', () => {
    const plan = planInsertion(tasks, 'a', null); // 'a' has child 'd'
    expect(plan.order).toBe(1);
  });

  it('places after the given task and shifts equal/higher orders', () => {
    const plan = planInsertion(tasks, 'root', 'b');
    expect(plan.order).toBe(2); // b.order(1) + 1
    expect(plan.shiftThreshold).toBe(2);
  });

  it('throws VALIDATION_FAILED when afterTaskId is not a sibling', () => {
    try {
      planInsertion(tasks, 'root', 'd'); // 'd' is a child of 'a', not 'root'
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('moveInsertIndex', () => {
  it('returns 0 for first', () => {
    expect(moveInsertIndex(tasks, 'root', { kind: 'first' }, 'x')).toBe(0);
  });

  it('returns the count for last', () => {
    expect(moveInsertIndex(tasks, 'root', { kind: 'last' }, 'x')).toBe(3);
  });

  it('returns the anchor index for before', () => {
    expect(moveInsertIndex(tasks, 'root', { kind: 'before', taskId: 'b' }, 'x')).toBe(1);
  });

  it('returns anchor index + 1 for after', () => {
    expect(moveInsertIndex(tasks, 'root', { kind: 'after', taskId: 'c' }, 'x')).toBe(3);
  });

  it('excludes the moving task from the sibling count', () => {
    // Moving 'a' within 'root': siblings are now [b, c], last = 2.
    expect(moveInsertIndex(tasks, 'root', { kind: 'last' }, 'a')).toBe(2);
  });

  it('throws VALIDATION_FAILED when the anchor is not a sibling', () => {
    try {
      moveInsertIndex(tasks, 'root', { kind: 'before', taskId: 'd' }, 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('isSelfOrDescendant', () => {
  it('is true for the task itself', () => {
    expect(isSelfOrDescendant(tasks, 'root', 'root')).toBe(true);
  });

  it('is true for a direct child', () => {
    expect(isSelfOrDescendant(tasks, 'root', 'a')).toBe(true);
  });

  it('is true for a deep descendant', () => {
    expect(isSelfOrDescendant(tasks, 'root', 'd')).toBe(true); // root -> a -> d
  });

  it('is false for an unrelated task', () => {
    expect(isSelfOrDescendant(tasks, 'a', 'b')).toBe(false);
  });

  it('is false when moving under a sibling', () => {
    expect(isSelfOrDescendant(tasks, 'a', 'c')).toBe(false);
  });
});
