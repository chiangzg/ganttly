import { describe, expect, it } from 'vitest';
import {
  computeImpliedEnd,
  computeImpliedStart,
  isDependencySatisfied,
  satisfyDependency,
  wouldCreateCycle,
  makeScheduler,
  cascadeSchedule,
  satisfyConstraint,
  snapConstraintDate,
  checkConstraintConflicts,
  countDependencyViolations,
} from '@/lib/schedule';
import { getCalendar } from '@ganttly/calendar-data';
import type { Dependency, Task } from '@ganttly/schema';

const scheduler = makeScheduler(getCalendar('zh-CN'));
const cal = scheduler.cal;

function task(
  id: string,
  start: string,
  end: string,
  deps: Dependency[] = [],
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start,
    end,
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: deps,
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

describe('computeImpliedStart — FS', () => {
  it('successor starts on next working day after predecessor end', () => {
    // Predecessor ends Fri Jan 9. FS successor starts Mon Jan 12.
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'FS', lag: 0 };
    expect(computeImpliedStart(p, dep, cal)).toBe('2026-01-12');
  });

  it('honors positive lag in working days', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'FS', lag: 2 };
    // Next working day Mon Jan 12, +2 working days = Jan 14.
    expect(computeImpliedStart(p, dep, cal)).toBe('2026-01-14');
  });

  it('honors negative lag (lead)', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'FS', lag: -1 };
    // Mon Jan 12 - 1 working day = Fri Jan 9.
    expect(computeImpliedStart(p, dep, cal)).toBe('2026-01-09');
  });

  it('skips Spring Festival holidays', () => {
    // Predecessor ends just before Spring Festival; successor should resume
    // after the holiday block.
    const p = task('p', '2026-02-09', '2026-02-13');
    const dep: Dependency = { targetId: 'p', type: 'FS', lag: 0 };
    // Feb 14 is make-up working day; next working day after Feb 13 is Feb 14
    // (because Feb 14 is type:working). Then Feb 15+ is holiday through Feb 22.
    expect(computeImpliedStart(p, dep, cal)).toBe('2026-02-14');
  });
});

describe('computeImpliedStart — SS', () => {
  it('successor starts at predecessor start', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'SS', lag: 0 };
    expect(computeImpliedStart(p, dep, cal)).toBe('2026-01-05');
  });
  it('SS with lag', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'SS', lag: 3 };
    // Jan 5 + 3 working days = Jan 8.
    expect(computeImpliedStart(p, dep, cal)).toBe('2026-01-08');
  });
});

describe('computeImpliedEnd — FF / SF', () => {
  it('FF: successor end ≥ predecessor end', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'FF', lag: 0 };
    expect(computeImpliedEnd(p, dep, cal)).toBe('2026-01-09');
  });
  it('FF with lag', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'FF', lag: 2 };
    // Jan 9 + 2 working days = Jan 13 (skips weekend).
    expect(computeImpliedEnd(p, dep, cal)).toBe('2026-01-13');
  });
  it('SF: successor end ≥ predecessor start', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const dep: Dependency = { targetId: 'p', type: 'SF', lag: 0 };
    expect(computeImpliedEnd(p, dep, cal)).toBe('2026-01-05');
  });
});

describe('isDependencySatisfied', () => {
  it('returns true when successor starts after implied', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const s = task('s', '2026-01-12', '2026-01-16', [{ targetId: 'p', type: 'FS', lag: 0 }]);
    expect(isDependencySatisfied(p, s, s.dependencies[0]!, cal)).toBe(true);
  });
  it('returns false when successor starts before implied', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const s = task('s', '2026-01-10', '2026-01-15', [{ targetId: 'p', type: 'FS', lag: 0 }]);
    expect(isDependencySatisfied(p, s, s.dependencies[0]!, cal)).toBe(false);
  });
});

describe('satisfyDependency', () => {
  it('reschedules FS successor forward', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const s = task('s', '2026-01-05', '2026-01-09', [{ targetId: 'p', type: 'FS', lag: 0 }], {
      duration: 5,
    });
    const result = satisfyDependency(p, s, s.dependencies[0]!, cal);
    expect(result.start).toBe('2026-01-12');
    expect(result.end).toBe('2026-01-16');
  });

  it('returns unchanged if already satisfied', () => {
    const p = task('p', '2026-01-05', '2026-01-09');
    const s = task('s', '2026-01-15', '2026-01-21', [{ targetId: 'p', type: 'FS', lag: 0 }]);
    const result = satisfyDependency(p, s, s.dependencies[0]!, cal);
    expect(result.start).toBeUndefined();
  });
});

describe('wouldCreateCycle', () => {
  it('detects self-loop', () => {
    const tasks = [task('a', '2026-01-05', '2026-01-09')];
    expect(wouldCreateCycle(tasks, { successorId: 'a', predecessorId: 'a' })).toBe(true);
  });

  it('rejects closing an existing chain into a cycle', () => {
    // Existing chain: a → b → c (a is predecessor of b, b of c).
    // Adding dep where c becomes a predecessor of a closes the cycle:
    // i.e. successorId=a, predecessorId=c.
    const tasks = [
      task('a', '2026-01-05', '2026-01-09'),
      task('b', '2026-01-12', '2026-01-16', [{ targetId: 'a', type: 'FS', lag: 0 }]),
      task('c', '2026-01-19', '2026-01-23', [{ targetId: 'b', type: 'FS', lag: 0 }]),
    ];
    // Path a → b → c already exists. Adding "a depends on c" (successorId=a,
    // predecessorId=c) would close the cycle.
    expect(wouldCreateCycle(tasks, { successorId: 'a', predecessorId: 'c' })).toBe(true);
    // Conversely "c depends on a" is safe — no cycle.
    expect(wouldCreateCycle(tasks, { successorId: 'c', predecessorId: 'a' })).toBe(false);
  });

  it('returns false for non-cyclic new dep', () => {
    const tasks = [task('a', '2026-01-05', '2026-01-09'), task('b', '2026-01-12', '2026-01-16')];
    expect(wouldCreateCycle(tasks, { successorId: 'b', predecessorId: 'a' })).toBe(false);
  });
});

describe('cascadeSchedule', () => {
  it('propagates a predecessor move to its direct FS successor', () => {
    // a (1/5-1/9) → b (FS, 1/12-1/16). Move a later by a week → b must follow.
    const tasks = [
      task('a', '2026-01-12', '2026-01-16'), // moved
      task('b', '2026-01-12', '2026-01-16', [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    const patches = cascadeSchedule(tasks, 'a', cal);
    const bPatch = patches.find((p) => p.id === 'b');
    expect(bPatch).toBeDefined();
    // a ends 1/16 → b starts next working day = 1/19 (Monday)
    expect(bPatch!.patch.start).toBe('2026-01-19');
  });

  it('propagates through a chain (a → b → c)', () => {
    const tasks = [
      task('a', '2026-01-12', '2026-01-16'),
      task('b', '2026-01-12', '2026-01-16', [{ targetId: 'a', type: 'FS', lag: 0 }]),
      task('c', '2026-01-12', '2026-01-16', [{ targetId: 'b', type: 'FS', lag: 0 }]),
    ];
    const patches = cascadeSchedule(tasks, 'a', cal);
    const byId = new Map(patches.map((p) => [p.id, p.patch]));
    // a ends 1/16 → b starts 1/19 → b ends 1/23 → c starts 1/26
    expect(byId.get('b')?.start).toBe('2026-01-19');
    expect(byId.get('c')?.start).toBe('2026-01-26');
  });

  it('satisfies multiple predecessors (max implied start)', () => {
    // b depends on a (ends 1/16 → b ≥ 1/19) AND c (ends 1/23 → b ≥ 1/26).
    // b must start at the later of the two: 1/26.
    const tasks = [
      task('a', '2026-01-12', '2026-01-16'),
      task('c', '2026-01-19', '2026-01-23'),
      task('b', '2026-01-12', '2026-01-16', [
        { targetId: 'a', type: 'FS', lag: 0 },
        { targetId: 'c', type: 'FS', lag: 0 },
      ]),
    ];
    const patches = cascadeSchedule(tasks, 'a', cal);
    const bPatch = patches.find((p) => p.id === 'b');
    expect(bPatch!.patch.start).toBe('2026-01-26');
  });

  it('returns empty when the changed task has no successors', () => {
    const tasks = [task('a', '2026-01-05', '2026-01-09')];
    expect(cascadeSchedule(tasks, 'a', cal)).toEqual([]);
  });

  it('does not move a successor that is already satisfied', () => {
    // b starts well after a ends — already satisfied, no patch.
    const tasks = [
      task('a', '2026-01-05', '2026-01-09'),
      task('b', '2026-02-02', '2026-02-06', [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    const patches = cascadeSchedule(tasks, 'a', cal);
    expect(patches.find((p) => p.id === 'b')).toBeUndefined();
  });

  it('does not loop forever on a cyclic dependency graph', () => {
    // Construct a cycle manually (bypassing wouldCreateCycle guard).
    const tasks = [
      task('a', '2026-01-05', '2026-01-09', [{ targetId: 'b', type: 'FS', lag: 0 }]),
      task('b', '2026-01-05', '2026-01-09', [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    // Should terminate (guard caps iterations) and return some patches or none.
    const patches = cascadeSchedule(tasks, 'a', cal);
    expect(Array.isArray(patches)).toBe(true);
  });
});

describe('snapConstraintDate (G12)', () => {
  it('returns the date unchanged when it is a working day', () => {
    // 2026-01-05 is Monday
    const result = snapConstraintDate('2026-01-05', cal);
    expect(result.snapped).toBe(false);
    expect(result.date).toBe('2026-01-05');
  });

  it('snaps a weekend to the next working day', () => {
    // 2026-01-10 is Saturday → next working day is 2026-01-12 (Monday)
    const result = snapConstraintDate('2026-01-10', cal);
    expect(result.snapped).toBe(true);
    expect(result.date).toBe('2026-01-12');
    expect(result.original).toBe('2026-01-10');
  });
});

describe('satisfyConstraint (G18 — hard anchor override / soft max)', () => {
  it('SNET soft constraint takes the later of dep-implied and constraint', () => {
    // depImplied 1/5, constraint SNET 1/12 → start 1/12 (constraint wins, soft)
    const t = task('t', '2026-01-05', '2026-01-09');
    const result = satisfyConstraint(
      t,
      { type: 'startNoEarlierThan', date: '2026-01-12' },
      cal,
      '2026-01-05',
    );
    expect(result.start).toBe('2026-01-12');
    expect(result.conflict).toBe(false);
  });

  it('SNET does not move start earlier than dep-implied', () => {
    const t = task('t', '2026-01-12', '2026-01-16');
    // depImplied 1/12, constraint SNET 1/5 → stays 1/12 (dep wins)
    const result = satisfyConstraint(
      t,
      { type: 'startNoEarlierThan', date: '2026-01-05' },
      cal,
      '2026-01-12',
    );
    expect(result.start).toBe('2026-01-12');
  });

  it('MSO hard anchor overrides dep-implied start and flags conflict', () => {
    const t = task('t', '2026-01-12', '2026-01-16');
    // depImplied 1/12, MSO 1/5 → forced to 1/5, conflict=true
    const result = satisfyConstraint(
      t,
      { type: 'mustStartOn', date: '2026-01-05' },
      cal,
      '2026-01-12',
    );
    expect(result.start).toBe('2026-01-05');
    expect(result.conflict).toBe(true);
  });

  it('MFO hard anchor sets end and back-calculates start', () => {
    const t = task('t', '2026-01-05', '2026-01-09', [], { duration: 5 });
    // MFO 1/9 → end 1/9, start back-walked 4 working days = 1/5
    const result = satisfyConstraint(
      t,
      { type: 'mustFinishOn', date: '2026-01-09' },
      cal,
      '2026-01-05',
    );
    expect(result.end).toBe('2026-01-09');
    expect(result.start).toBe('2026-01-05');
  });

  it('FNLT soft constraint tightens end if constraint is earlier', () => {
    const t = task('t', '2026-01-05', '2026-01-16', [], { duration: 5 });
    // FNLT 1/9 → end capped at 1/9 (earlier than dep end)
    const result = satisfyConstraint(
      t,
      { type: 'finishNoLaterThan', date: '2026-01-09' },
      cal,
      '2026-01-05',
    );
    expect(result.end).toBe('2026-01-09');
  });

  it('none constraint leaves dates unchanged', () => {
    const t = task('t', '2026-01-05', '2026-01-09');
    const result = satisfyConstraint(t, { type: 'none' }, cal, '2026-01-05');
    expect(result.start).toBe('2026-01-05');
    expect(result.end).toBe('2026-01-09');
    expect(result.conflict).toBe(false);
  });
});

describe('checkConstraintConflicts', () => {
  it('flags a task whose MSO anchor violates its dependency', () => {
    // b depends on a (FS). a ends 1/23 → b ≥ 1/26. MSO 1/5 forces b earlier → conflict.
    const tasks = [
      task('a', '2026-01-19', '2026-01-23'),
      task('b', '2026-01-26', '2026-01-30', [{ targetId: 'a', type: 'FS', lag: 0 }], {
        constraints: { type: 'mustStartOn', date: '2026-01-05' },
      }),
    ];
    const conflicts = checkConstraintConflicts(tasks, cal);
    expect(conflicts.has('b')).toBe(true);
  });

  it('does not flag a constraint that agrees with dependencies', () => {
    const tasks = [
      task('a', '2026-01-05', '2026-01-09'),
      task('b', '2026-01-12', '2026-01-16', [{ targetId: 'a', type: 'FS', lag: 0 }], {
        constraints: { type: 'startNoEarlierThan', date: '2026-01-12' },
      }),
    ];
    const conflicts = checkConstraintConflicts(tasks, cal);
    expect(conflicts.size).toBe(0);
  });
});

describe('countDependencyViolations (G14)', () => {
  it('counts successors that violate their dependencies', () => {
    // a ends 1/9 → b (FS) must start 1/12. b starts 1/5 → violation.
    const tasks = [
      task('a', '2026-01-05', '2026-01-09'),
      task('b', '2026-01-05', '2026-01-09', [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    expect(countDependencyViolations(tasks, cal)).toBe(1);
  });

  it('returns 0 when all dependencies are satisfied', () => {
    const tasks = [
      task('a', '2026-01-05', '2026-01-09'),
      task('b', '2026-01-12', '2026-01-16', [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    expect(countDependencyViolations(tasks, cal)).toBe(0);
  });

  it('returns 0 for tasks with no dependencies', () => {
    const tasks = [task('a', '2026-01-05', '2026-01-09')];
    expect(countDependencyViolations(tasks, cal)).toBe(0);
  });
});
