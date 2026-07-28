import { describe, expect, it } from 'vitest';
import {
  createBaselineSnapshot,
  signedWorkingDayDelta,
  compareTaskToBaseline,
  summarizeBaselineVariance,
  findActiveBaseline,
  buildEffectiveValues,
} from '@/lib/baseline';
import type { GanttlyFile, Task, Baseline, BaselineTask } from '@ganttly/schema';
import { createEmptyFile } from '@ganttly/schema';
import { getCalendar } from '@ganttly/calendar-data';
import { resolveCalendar } from '@/lib/calendar';

const zhCN = getCalendar('zh-CN');
const cal = resolveCalendar(zhCN);

function makeFile(overrides: Partial<GanttlyFile> = {}): GanttlyFile {
  return { ...createEmptyFile({ name: 't' }), ...overrides };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-02-02',
    end: '2026-02-06',
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

function makeBaselineTask(id: string, overrides: Partial<BaselineTask> = {}): BaselineTask {
  return { id, start: '2026-02-02', end: '2026-02-06', duration: 5, progress: 0, ...overrides };
}

// ===========================================================================
// createBaselineSnapshot
// ===========================================================================

describe('createBaselineSnapshot', () => {
  it('captures leaf task fields', () => {
    const task = makeTask('A', {
      start: '2026-03-02',
      end: '2026-03-06',
      duration: 5,
      progress: 40,
    });
    const file = makeFile({ tasks: [task] });
    const baseline = createBaselineSnapshot(file, {
      id: 'b1',
      name: 'v1',
      capturedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(baseline.id).toBe('b1');
    expect(baseline.name).toBe('v1');
    expect(baseline.capturedAt).toBe('2026-07-28T00:00:00.000Z');
    expect(baseline.tasks).toHaveLength(1);
    expect(baseline.tasks[0]).toEqual({
      id: 'A',
      start: '2026-03-02',
      end: '2026-03-06',
      duration: 5,
      progress: 40,
    });
  });

  it('captures summary tasks with recomputed rollup values, not stale fields', () => {
    // Parent's own fields are deliberately stale (say 2026-01-01) — the
    // snapshot must record the recomputed rollup from children.
    const parent = makeTask('P', {
      parentId: null,
      order: 0,
      start: '2026-01-01',
      end: '2026-01-01',
      duration: 1,
      progress: 0,
    });
    const childA = makeTask('A', {
      parentId: 'P',
      order: 0,
      start: '2026-03-02',
      end: '2026-03-06',
      duration: 5,
      progress: 60,
    });
    const childB = makeTask('B', {
      parentId: 'P',
      order: 1,
      start: '2026-03-09',
      end: '2026-03-13',
      duration: 5,
      progress: 100,
    });
    const file = makeFile({ tasks: [parent, childA, childB] });

    const baseline = createBaselineSnapshot(file, { id: 'b1', name: 'v1', capturedAt: 'x' });
    const snap = baseline.tasks.find((t) => t.id === 'P')!;
    expect(snap.start).toBe('2026-03-02'); // min child start, NOT 2026-01-01
    expect(snap.end).toBe('2026-03-13'); // max child end
    expect(snap.duration).toBe(10); // sum child durations
    // weighted: (60*5 + 100*5)/10 = 80
    expect(snap.progress).toBe(80);
  });

  it('captures milestones with duration 0', () => {
    const ms = makeTask('M', {
      isMilestone: true,
      start: '2026-03-05',
      end: '2026-03-05',
      duration: 0,
    });
    const file = makeFile({ tasks: [ms] });
    const baseline = createBaselineSnapshot(file, { id: 'b1', name: 'v1', capturedAt: 'x' });
    expect(baseline.tasks[0]).toEqual({
      id: 'M',
      start: '2026-03-05',
      end: '2026-03-05',
      duration: 0,
      progress: 0,
    });
  });

  it('does not mutate the input file or retain task references', () => {
    const task = makeTask('A', { start: '2026-03-02', end: '2026-03-06', duration: 5 });
    const file = makeFile({ tasks: [task] });
    const fileCopy = JSON.parse(JSON.stringify(file));
    const baseline = createBaselineSnapshot(file, { id: 'b1', name: 'v1', capturedAt: 'x' });
    expect(file).toEqual(fileCopy); // unchanged
    // Mutating the snapshot must not touch the original task.
    baseline.tasks[0]!.start = '1999-01-01';
    expect(file.tasks[0]!.start).toBe('2026-03-02');
    // Snapshot objects are distinct from the originals.
    expect(baseline.tasks[0]).not.toBe(file.tasks[0]);
  });
});

// ===========================================================================
// signedWorkingDayDelta
// ===========================================================================

describe('signedWorkingDayDelta', () => {
  it('returns 0 for equal dates', () => {
    expect(signedWorkingDayDelta('2026-02-02', '2026-02-02', cal)).toBe(0);
  });

  // 2026-02-02 = Monday, 2026-02-03 = Tuesday
  it('Monday → Tuesday = +1 (both working days)', () => {
    expect(signedWorkingDayDelta('2026-02-02', '2026-02-03', cal)).toBe(1);
  });

  // 2026-02-06 = Friday, 2026-02-09 = Monday (weekend in between)
  it('Friday → next Monday = +1 (weekend skipped)', () => {
    expect(signedWorkingDayDelta('2026-02-06', '2026-02-09', cal)).toBe(1);
  });

  it('Tuesday → Monday (backwards) = -1', () => {
    // 2026-02-03 Tue → 2026-02-02 Mon
    expect(signedWorkingDayDelta('2026-02-03', '2026-02-02', cal)).toBe(-1);
  });

  // National Day: holiday block 2026-10-01..2026-10-08 (all non-working),
  // with 调休补班 at 09-19 and 10-10 (both OUTSIDE the block). So the last
  // working day before is 2026-09-30 (Wed) and the first after is 2026-10-09
  // (Fri), with no working days in between — exactly the spec's "+1" case.
  it('crosses the National Day holiday block = +1', () => {
    expect(signedWorkingDayDelta('2026-09-30', '2026-10-09', cal)).toBe(1);
  });

  // Spring Festival: holiday block 2026-02-15..2026-02-22 (all non-working),
  // BUT 调休补班 2026-02-14 (Sat, working) falls between 02-13 and 02-23, so
  // 02-13 → 02-23 counts BOTH 02-14 and 02-23 → +2 (not +1).
  it('counts a 调休补班 day that falls inside the gap', () => {
    expect(signedWorkingDayDelta('2026-02-13', '2026-02-23', cal)).toBe(2);
  });

  it('Saturday → Sunday (both non-working, no working day between) = 0', () => {
    // 2026-02-07 Sat → 2026-02-08 Sun — no working day in (Sat, Sun]
    expect(signedWorkingDayDelta('2026-02-07', '2026-02-08', cal)).toBe(0);
  });

  it('调休补班 day (2026-02-14 Saturday) counts as a working day', () => {
    // 2026-02-13 Fri → 2026-02-14 Sat (working via 调休) = +1
    expect(signedWorkingDayDelta('2026-02-13', '2026-02-14', cal)).toBe(1);
  });

  it('multi-day forward delta counts only working days', () => {
    // 2026-02-02 Mon → 2026-02-06 Fri = 4 working days in (Mon, Fri]
    expect(signedWorkingDayDelta('2026-02-02', '2026-02-06', cal)).toBe(4);
  });

  it('multi-day backward delta is negative', () => {
    expect(signedWorkingDayDelta('2026-02-06', '2026-02-02', cal)).toBe(-4);
  });

  it('does not count task overtimeDates (not in calendar)', () => {
    // ResolvedCalendar here has no overtime concept; the function only knows
    // the calendar. Just confirm a normal holiday stretch behaves as expected.
    expect(signedWorkingDayDelta('2026-02-13', '2026-02-14', cal)).toBe(1);
  });
});

// ===========================================================================
// compareTaskToBaseline
// ===========================================================================

describe('compareTaskToBaseline', () => {
  it('returns "added" when no baseline record exists', () => {
    const v = compareTaskToBaseline(
      { id: 'A', start: '2026-02-02', end: '2026-02-06', duration: 5 },
      undefined,
      cal,
    );
    expect(v.status).toBe('added');
    if (v.status === 'added') {
      expect(v.taskId).toBe('A');
    }
  });

  it('returns "on-track" when finish unchanged (even if start moved)', () => {
    const baseline = makeBaselineTask('A', { start: '2026-02-02', end: '2026-02-06', duration: 5 });
    // Start moved 1 day later but end is the same.
    const v = compareTaskToBaseline(
      { id: 'A', start: '2026-02-03', end: '2026-02-06', duration: 4 },
      baseline,
      cal,
    );
    expect(v.status).toBe('on-track');
    if (v.status !== 'added') {
      expect(v.finishDelta).toBe(0);
      expect(v.startDelta).toBe(1);
      expect(v.durationDelta).toBe(-1);
    }
  });

  it('returns "late" when finish moved later', () => {
    const baseline = makeBaselineTask('A', { start: '2026-02-02', end: '2026-02-06', duration: 5 });
    const v = compareTaskToBaseline(
      { id: 'A', start: '2026-02-02', end: '2026-02-10', duration: 7 },
      baseline,
      cal,
    );
    expect(v.status).toBe('late');
    if (v.status !== 'added') {
      expect(v.finishDelta).toBeGreaterThan(0);
    }
  });

  it('returns "early" when finish moved earlier', () => {
    const baseline = makeBaselineTask('A', { start: '2026-02-02', end: '2026-02-06', duration: 5 });
    const v = compareTaskToBaseline(
      { id: 'A', start: '2026-02-02', end: '2026-02-05', duration: 4 },
      baseline,
      cal,
    );
    expect(v.status).toBe('early');
    if (v.status !== 'added') {
      expect(v.finishDelta).toBeLessThan(0);
    }
  });

  it('durationDelta uses the raw working-day difference (no calendar)', () => {
    const baseline = makeBaselineTask('A', { duration: 5 });
    const v = compareTaskToBaseline(
      { id: 'A', start: '2026-02-02', end: '2026-02-13', duration: 10 },
      baseline,
      cal,
    );
    if (v.status !== 'added') {
      expect(v.durationDelta).toBe(5);
    }
  });
});

// ===========================================================================
// summarizeBaselineVariance
// ===========================================================================

describe('summarizeBaselineVariance', () => {
  it('counts only leaf tasks (not summaries) for matched/on-track/late', () => {
    const parent = makeTask('P', {
      parentId: null,
      order: 0,
      start: '2026-02-02',
      end: '2026-02-06',
      duration: 5,
    });
    const child = makeTask('C', {
      parentId: 'P',
      order: 0,
      start: '2026-02-02',
      end: '2026-02-06',
      duration: 5,
    });
    const file = makeFile({ tasks: [parent, child] });
    const baseline: Baseline = {
      id: 'b1',
      name: 'v1',
      capturedAt: 'x',
      tasks: [
        makeBaselineTask('P', { start: '2026-02-02', end: '2026-02-06', duration: 5 }),
        makeBaselineTask('C', { start: '2026-02-02', end: '2026-02-06', duration: 5 }),
      ],
    };
    const s = summarizeBaselineVariance(file, baseline, cal);
    // Only the leaf 'C' counts as matched.
    expect(s.matchedLeafCount).toBe(1);
    expect(s.onTrackLeafCount).toBe(1);
    expect(s.lateLeafCount).toBe(0);
    expect(s.earlyLeafCount).toBe(0);
  });

  it('counts added leaf tasks (current task with no baseline record)', () => {
    const a = makeTask('A');
    const b = makeTask('B', { order: 1 });
    const file = makeFile({ tasks: [a, b] });
    const baseline: Baseline = {
      id: 'b1',
      name: 'v1',
      capturedAt: 'x',
      tasks: [makeBaselineTask('A')], // only A
    };
    const s = summarizeBaselineVariance(file, baseline, cal);
    expect(s.addedLeafCount).toBe(1);
    expect(s.matchedLeafCount).toBe(1);
  });

  it('counts deleted tasks (baseline record with no current task)', () => {
    const file = makeFile({ tasks: [makeTask('A')] });
    const baseline: Baseline = {
      id: 'b1',
      name: 'v1',
      capturedAt: 'x',
      tasks: [makeBaselineTask('A'), makeBaselineTask('GONE')], // GONE deleted
    };
    const s = summarizeBaselineVariance(file, baseline, cal);
    expect(s.deletedTaskCount).toBe(1);
  });

  it('maxFinishDelay is the largest positive finishDelta; 0 when none late', () => {
    const a = makeTask('A', { start: '2026-02-02', end: '2026-02-10', duration: 7 }); // late +2
    const b = makeTask('B', { order: 1, start: '2026-02-02', end: '2026-02-06', duration: 5 }); // on time
    const c = makeTask('C', { order: 2, start: '2026-02-02', end: '2026-02-17', duration: 12 }); // late by ~7
    const file = makeFile({ tasks: [a, b, c] });
    const baseline: Baseline = {
      id: 'b1',
      name: 'v1',
      capturedAt: 'x',
      tasks: [
        makeBaselineTask('A', { end: '2026-02-06' }),
        makeBaselineTask('B', { end: '2026-02-06' }),
        makeBaselineTask('C', { end: '2026-02-06' }),
      ],
    };
    const s = summarizeBaselineVariance(file, baseline, cal);
    expect(s.lateLeafCount).toBe(2);
    expect(s.maxFinishDelay).toBeGreaterThan(0);
  });

  it('maxFinishDelay is 0 when no task is late', () => {
    const file = makeFile({ tasks: [makeTask('A')] });
    const baseline: Baseline = {
      id: 'b1',
      name: 'v1',
      capturedAt: 'x',
      tasks: [makeBaselineTask('A')],
    };
    const s = summarizeBaselineVariance(file, baseline, cal);
    expect(s.maxFinishDelay).toBe(0);
    expect(s.lateLeafCount).toBe(0);
  });

  it('is O(n): 1000 tasks + 1000 baseline records runs without nested find', () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 1000; i++) {
      tasks.push(
        makeTask(`t${i}`, { order: i, start: '2026-02-02', end: '2026-02-06', duration: 5 }),
      );
    }
    const file = makeFile({ tasks });
    const baseline: Baseline = {
      id: 'b1',
      name: 'v1',
      capturedAt: 'x',
      tasks: tasks.map((t) => makeBaselineTask(t.id)),
    };
    const start = performance.now();
    const s = summarizeBaselineVariance(file, baseline, cal);
    const elapsed = performance.now() - start;
    expect(s.matchedLeafCount).toBe(1000);
    expect(s.onTrackLeafCount).toBe(1000);
    // Generous ceiling: O(n) must be well under 50ms for n=1000.
    expect(elapsed).toBeLessThan(50);
  });
});

// ===========================================================================
// findActiveBaseline
// ===========================================================================

describe('findActiveBaseline', () => {
  it('returns null when id is null', () => {
    expect(findActiveBaseline([], null)).toBeNull();
  });
  it('returns null when id is stale (not found)', () => {
    const b: Baseline = { id: 'b1', name: 'v1', capturedAt: 'x', tasks: [] };
    expect(findActiveBaseline([b], 'b2')).toBeNull();
  });
  it('returns the matching baseline', () => {
    const b: Baseline = { id: 'b1', name: 'v1', capturedAt: 'x', tasks: [] };
    expect(findActiveBaseline([b], 'b1')).toBe(b);
  });
});

// ===========================================================================
// buildEffectiveValues
// ===========================================================================

describe('buildEffectiveValues', () => {
  it('leaf tasks use their own fields', () => {
    const file = makeFile({
      tasks: [makeTask('A', { start: '2026-03-02', end: '2026-03-06', duration: 5 })],
    });
    const m = buildEffectiveValues(file, cal);
    expect(m.get('A')).toEqual({ id: 'A', start: '2026-03-02', end: '2026-03-06', duration: 5 });
  });
  it('summary tasks use rollup values', () => {
    const parent = makeTask('P', { start: '2026-01-01', end: '2026-01-01', duration: 1 });
    const child = makeTask('C', {
      parentId: 'P',
      order: 0,
      start: '2026-03-02',
      end: '2026-03-06',
      duration: 5,
    });
    const file = makeFile({ tasks: [parent, child] });
    const m = buildEffectiveValues(file, cal);
    expect(m.get('P')!.start).toBe('2026-03-02'); // rollup, not stale 2026-01-01
    expect(m.get('P')!.end).toBe('2026-03-06');
  });
});
