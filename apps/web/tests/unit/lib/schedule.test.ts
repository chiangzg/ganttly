import { describe, expect, it } from 'vitest';
import {
  computeImpliedEnd,
  computeImpliedStart,
  isDependencySatisfied,
  satisfyDependency,
  wouldCreateCycle,
  makeScheduler,
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
    constraints: {},
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
