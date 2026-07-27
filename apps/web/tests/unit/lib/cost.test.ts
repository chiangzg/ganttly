import { describe, expect, it } from 'vitest';
import { computeTaskPersonDays, computeAssignmentPersonDays, totalPersonDays } from '@/lib/cost';
import { computeAllRollups, computeRollup } from '@/lib/summary';
import { resolveCalendar } from '@/lib/calendar';
import type { Task, Resource, Calendar } from '@ganttly/schema';

const cal = resolveCalendar({
  id: 'test',
  weekStart: 1,
  weekends: [0, 6],
  holidays: [],
  workingHours: { start: '09:00', end: '18:00' },
});

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    // 2026-01-05 (Mon) .. 2026-01-16 (Fri) = 10 working days.
    start: '2026-01-05',
    end: '2026-01-16',
    duration: 10,
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

const fullTime: Resource = { id: 'r1', name: 'A', capacity: 1.0 };
const halfTime: Resource = { id: 'r2', name: 'B', capacity: 0.5 };

describe('computeTaskPersonDays', () => {
  it('returns 0 for a task with no assignments', () => {
    expect(computeTaskPersonDays(makeTask('t1'), [fullTime], cal)).toBe(0);
  });

  it('computes load% × capacity × duration for a single assignment', () => {
    // 50% × 1.0 × 10 days = 5 person-days
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r1', load: 50 }],
    });
    expect(computeTaskPersonDays(task, [fullTime], cal)).toBe(5);
  });

  it('respects resource capacity (half-time)', () => {
    // 100% × 0.5 × 10 days = 5 person-days
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r2', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [halfTime], cal)).toBe(5);
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
    expect(computeTaskPersonDays(task, [fullTime, halfTime], cal)).toBe(10);
  });

  it('treats missing capacity as 1.0', () => {
    const noCap: Resource = { id: 'r3', name: 'C' };
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r3', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [noCap], cal)).toBe(10);
  });

  it('does not infer overtime from rest days inside a task span', () => {
    const task = makeTask('t1', {
      start: '2026-01-05',
      end: '2026-01-12',
      duration: 6,
      assignments: [{ resourceId: 'r1', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [fullTime], cal)).toBe(6);
  });

  it('counts explicitly marked weekend overtime', () => {
    const task = makeTask('t1', {
      start: '2026-01-10',
      end: '2026-01-11',
      duration: 0,
      overtimeDates: ['2026-01-10', '2026-01-11'],
      assignments: [{ resourceId: 'r1', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [fullTime], cal)).toBe(2);
  });

  it('counts an explicitly marked public holiday without double-counting working dates', () => {
    const holidayCal = resolveCalendar({
      id: 'test',
      weekStart: 1,
      weekends: [0, 6],
      holidays: [{ date: '2026-01-07', name: 'Holiday', type: 'holiday' }],
      workingHours: { start: '09:00', end: '18:00' },
    } satisfies Calendar);
    const task = makeTask('t1', {
      start: '2026-01-05',
      end: '2026-01-09',
      duration: 4,
      overtimeDates: ['2026-01-06', '2026-01-07', '2026-02-01'],
      assignments: [{ resourceId: 'r1', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [fullTime], holidayCal)).toBe(5);
  });

  it('returns 0 for an assigned milestone, including legacy overtime dates', () => {
    const task = makeTask('t1', {
      start: '2026-01-10',
      end: '2026-01-10',
      duration: 0,
      isMilestone: true,
      overtimeDates: ['2026-01-10'],
      assignments: [{ resourceId: 'r1', load: 100 }],
    });
    expect(computeTaskPersonDays(task, [fullTime], cal)).toBe(0);
  });
});

describe('computeAssignmentPersonDays', () => {
  it('returns 0 when the resource is not assigned to the task', () => {
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r1', load: 50 }],
    });
    expect(computeAssignmentPersonDays(task, 'r2', [fullTime, halfTime], cal)).toBe(0);
  });

  it('computes the single resource share (load% × capacity × duration)', () => {
    // 50% × 1.0 × 10 days = 5 person-days
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r1', load: 50 }],
    });
    expect(computeAssignmentPersonDays(task, 'r1', [fullTime], cal)).toBe(5);
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
    expect(computeAssignmentPersonDays(task, 'r1', [fullTime, halfTime], cal)).toBe(5);
    expect(computeAssignmentPersonDays(task, 'r2', [fullTime, halfTime], cal)).toBe(5);
  });

  it('respects resource capacity and defaults missing capacity to 1.0', () => {
    const task = makeTask('t1', {
      duration: 10,
      assignments: [{ resourceId: 'r2', load: 100 }],
    });
    // halfTime (capacity 0.5): 1.0 × 0.5 × 10 = 5
    expect(computeAssignmentPersonDays(task, 'r2', [halfTime], cal)).toBe(5);
    const noCap: Resource = { id: 'r3', name: 'C' };
    const task2 = makeTask('t2', {
      duration: 10,
      assignments: [{ resourceId: 'r3', load: 100 }],
    });
    // missing capacity → 1.0: 1.0 × 1.0 × 10 = 10
    expect(computeAssignmentPersonDays(task2, 'r3', [noCap], cal)).toBe(10);
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
    expect(totalPersonDays(tasks, [fullTime], cal)).toBe(15);
  });
});

describe('computeRollup personDays (additive)', () => {
  it('sums children person-days additively (not weighted)', () => {
    const children = [
      makeTask('c1', { duration: 10, assignments: [{ resourceId: 'r1', load: 50 }] }),
      makeTask('c2', { duration: 10, assignments: [{ resourceId: 'r1', load: 100 }] }),
    ];
    const rollup = computeRollup(children, undefined, [fullTime], cal)!;
    expect(rollup.personDays).toBe(15); // 5 + 10
    expect(rollup.progress).toBe(0); // unaffected by personDays logic
  });

  it('does not let personDays interfere with progress weighting', () => {
    // Two children, one 100% progress one 0% — progress should be weighted by
    // duration (equal here → 50), personDays additive.
    const children = [
      makeTask('c1', {
        start: '2026-01-05',
        end: '2026-01-09',
        duration: 5,
        progress: 100,
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
      makeTask('c2', {
        start: '2026-01-05',
        end: '2026-01-09',
        duration: 5,
        progress: 0,
        assignments: [{ resourceId: 'r1', load: 100 }],
      }),
    ];
    const rollup = computeRollup(children, undefined, [fullTime], cal)!;
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
    const map = computeAllRollups(tasks, [fullTime], cal);
    expect(map.get('mid')!.personDays).toBe(15); // 5 + 10
    expect(map.get('root')!.personDays).toBe(15); // rolled up from mid
  });
});
