import { describe, expect, it } from 'vitest';
import { computeTaskPersonDays, computeAssignmentPersonDays, totalPersonDays } from '@/lib/cost';
import { computeAllRollups, computeRollup } from '@/lib/summary';
import type { Task, Resource } from '@ganttly/schema';

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

const fullTime: Resource = { id: 'r1', name: 'A', capacity: 1.0 };
const halfTime: Resource = { id: 'r2', name: 'B', capacity: 0.5 };

describe('computeTaskPersonDays', () => {
  it('returns 0 for a task with no assignments', () => {
    expect(computeTaskPersonDays(makeTask('t1'), [fullTime])).toBe(0);
  });

  it('computes load% × capacity × duration for a single assignment', () => {
    // 50% × 1.0 × 10 days = 5 person-days
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r1', load: 50 }],
    });
    expect(computeTaskPersonDays(task, [fullTime])).toBe(5);
  });

  it('respects resource capacity (half-time)', () => {
    // 100% × 0.5 × 10 days = 5 person-days
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r2', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [halfTime])).toBe(5);
  });

  it('sums multiple assignments on the same task', () => {
    // A: 50% × 1.0 × 10 = 5; B: 100% × 0.5 × 10 = 5 → total 10
    const task = makeTask('t1', {
      duration: 10,
      assignments: [
        { resourceId: 'r1', load: 50 },
        { resourceId: 'r2', load: 100 },
      ],
    });
    expect(computeTaskPersonDays(task, [fullTime, halfTime])).toBe(10);
  });

  it('treats missing capacity as 1.0', () => {
    const noCap: Resource = { id: 'r3', name: 'C' };
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r3', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [noCap])).toBe(10);
  });
});

describe('computeAssignmentPersonDays', () => {
  it('returns 0 when the resource is not assigned to the task', () => {
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r1', load: 50 }],
    });
    expect(computeAssignmentPersonDays(task, 'r2', [fullTime, halfTime])).toBe(0);
  });

  it('computes the single resource share (load% × capacity × duration)', () => {
    // 50% × 1.0 × 10 days = 5 person-days
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r1', load: 50 }],
    });
    expect(computeAssignmentPersonDays(task, 'r1', [fullTime])).toBe(5);
  });

  it('isolates one resource from a multi-assignment task', () => {
    // A: 50% × 1.0 × 10 = 5; B: 100% × 0.5 × 10 = 5 (task total 10)
    const task = makeTask('t1', {
      duration: 10,
      assignments: [
        { resourceId: 'r1', load: 50 },
        { resourceId: 'r2', load: 100 },
      ],
    });
    expect(computeAssignmentPersonDays(task, 'r1', [fullTime, halfTime])).toBe(5);
    expect(computeAssignmentPersonDays(task, 'r2', [fullTime, halfTime])).toBe(5);
  });

  it('respects resource capacity and defaults missing capacity to 1.0', () => {
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r2', load: 100 }],
    });
    // halfTime (capacity 0.5): 1.0 × 0.5 × 10 = 5
    expect(computeAssignmentPersonDays(task, 'r2', [halfTime])).toBe(5);
    const noCap: Resource = { id: 'r3', name: 'C' };
    const task2 = makeTask('t2', {
      duration: 10,
      assignments: [{ resourceId: 'r3', load: 100 }],
    });
    // missing capacity → 1.0: 1.0 × 1.0 × 10 = 10
    expect(computeAssignmentPersonDays(task2, 'r3', [noCap])).toBe(10);
  });
});

describe('totalPersonDays', () => {
  it('sums leaf tasks only (skips summaries)', () => {
    const tasks = [
      makeTask('parent'),
      makeTask('c1', {
        parentId: 'parent',
        duration: 10,
        assignments: [{ resourceId: 'r1', load: 50 }],
      }),
      makeTask('c2', {
        parentId: 'parent',
        duration: 10,
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
    ];
    // c1: 0.5×1×10=5, c2: 1×1×10=10 → 15; parent skipped
    expect(totalPersonDays(tasks, [fullTime])).toBe(15);
  });
});

describe('computeRollup personDays (additive)', () => {
  it('sums children person-days additively (not weighted)', () => {
    const children = [
      makeTask('c1', { duration: 10, assignments: [{ resourceId: 'r1', load: 50 }] }),
      makeTask('c2', { duration: 10, assignments: [{ resourceId: 'r1', load: 100 }] }),
    ];
    const rollup = computeRollup(children, undefined, [fullTime])!;
    expect(rollup.personDays).toBe(15); // 5 + 10
    expect(rollup.progress).toBe(0); // unaffected by personDays logic
  });

  it('does not let personDays interfere with progress weighting', () => {
    // Two children, one 100% progress one 0% — progress should be weighted by
    // duration (equal here → 50), personDays additive.
    const children = [
      makeTask('c1', {
        duration: 5,
        progress: 100,
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
      makeTask('c2', { duration: 5, progress: 0, assignments: [{ resourceId: 'r1', load: 100 }] }),
    ];
    const rollup = computeRollup(children, undefined, [fullTime])!;
    expect(rollup.progress).toBe(50); // (100×5 + 0×5) / 10
    expect(rollup.personDays).toBe(10); // 5 + 5
  });
});

describe('computeAllRollups with resources', () => {
  it('rolls up personDays through nested summaries', () => {
    const tasks = [
      makeTask('root'),
      makeTask('mid', { parentId: 'root' }),
      makeTask('leaf1', {
        parentId: 'mid',
        duration: 10,
        assignments: [{ resourceId: 'r1', load: 50 }],
      }),
      makeTask('leaf2', {
        parentId: 'mid',
        duration: 10,
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
    ];
    const map = computeAllRollups(tasks, [fullTime]);
    expect(map.get('mid')!.personDays).toBe(15); // 5 + 10
    expect(map.get('root')!.personDays).toBe(15); // rolled up from mid
  });
});
