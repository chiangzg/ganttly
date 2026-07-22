import { describe, expect, it } from 'vitest';
import { computeCriticalPath } from '@/lib/cpm';
import { getCalendar } from '@ganttly/calendar-data';
import type { Task, Dependency } from '@ganttly/schema';

const calendar = getCalendar('zh-CN');

function task(id: string, start: string, duration: number, deps: Dependency[] = []): Task {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start,
    end: addDays(start, duration - 1),
    duration,
    progress: 0,
    isMilestone: false,
    dependencies: deps,
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
  };
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y!, m! - 1, d!) + n * 86_400_000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

describe('computeCriticalPath — basics', () => {
  it('single task is critical', () => {
    const tasks = [task('a', '2026-01-05', 5)];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.earliestStart.get('a')).toBe('2026-01-05');
    expect(r.earliestEnd.get('a')).toBe('2026-01-09');
  });

  it('linear chain A → B → C: all critical', () => {
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-12', 5, [{ targetId: 'a', type: 'FS', lag: 0 }]),
      task('c', '2026-01-19', 5, [{ targetId: 'b', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('b')).toBe(true);
    expect(r.criticalTaskIds.has('c')).toBe(true);
  });

  it('parallel branches: only the longer one is critical', () => {
    // a → b (5 days), a → c (10 days), then both → d.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-12', 5, [{ targetId: 'a', type: 'FS', lag: 0 }]),
      task('c', '2026-01-12', 10, [{ targetId: 'a', type: 'FS', lag: 0 }]),
      task('d', '2026-01-26', 5, [
        { targetId: 'b', type: 'FS', lag: 0 },
        { targetId: 'c', type: 'FS', lag: 0 },
      ]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('c')).toBe(true);
    expect(r.criticalTaskIds.has('d')).toBe(true);
    // b has float (5 working days of slack).
    expect(r.criticalTaskIds.has('b')).toBe(false);
    expect(r.totalFloat.get('b')!).toBeGreaterThan(0);
  });

  it('float is zero on critical, positive on non-critical', () => {
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-12', 5, [{ targetId: 'a', type: 'FS', lag: 0 }]),
      task('c', '2026-01-12', 10, [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.totalFloat.get('a')).toBe(0);
    expect(r.totalFloat.get('c')).toBe(0);
    expect(r.totalFloat.get('b')!).toBeGreaterThan(0);
  });
});

describe('computeCriticalPath — diamond (SS+FF convergence)', () => {
  it('handles SS / FF dependencies', () => {
    // a (5d). b depends on a via SS lag 0 → b starts when a starts.
    // c depends on b via FF lag 0 → c ends when b ends.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-05', 10, [{ targetId: 'a', type: 'SS', lag: 0 }]),
      task('c', '2026-01-05', 1, [{ targetId: 'b', type: 'FF', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    // The longest chain is a → b → c; all critical.
    expect(r.criticalTaskIds.size).toBeGreaterThanOrEqual(2);
  });
});

describe('computeCriticalPath — multi-root', () => {
  it('handles two disconnected chains; only the longest chain is critical', () => {
    // Chain A: a1 (5d) → a2 (5d) = 10 working days.
    // Chain B: b1 (10d) → b2 (5d) = 15 working days.
    // Chain B is the longer chain; only its tasks are critical.
    const tasks = [
      task('a1', '2026-01-05', 5),
      task('a2', '2026-01-12', 5, [{ targetId: 'a1', type: 'FS', lag: 0 }]),
      task('b1', '2026-01-05', 10),
      task('b2', '2026-01-19', 5, [{ targetId: 'b1', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.criticalTaskIds.has('b1')).toBe(true);
    expect(r.criticalTaskIds.has('b2')).toBe(true);
    // Chain A has float.
    expect(r.criticalTaskIds.has('a1')).toBe(false);
    expect(r.criticalTaskIds.has('a2')).toBe(false);
  });
});

describe('computeCriticalPath — cycle resilience', () => {
  it('does not infinite-loop on cyclic input', () => {
    // a → b → a (cycle). Compute should still terminate.
    const tasks = [
      task('a', '2026-01-05', 5, [{ targetId: 'b', type: 'FS', lag: 0 }]),
      task('b', '2026-01-12', 5, [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    expect(() => computeCriticalPath(tasks, calendar)).not.toThrow();
  });
});

describe('computeCriticalPath — project duration', () => {
  it('reports total working-day duration of the longest chain', () => {
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-12', 5, [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    // a 5 + b 5 = 10 working days
    expect(r.projectDurationDays).toBe(10);
  });
});

describe('constraints in CPM (G18)', () => {
  it('SNET pushes earliestStart forward to the constraint date', () => {
    // a starts 1/5 but SNET says no earlier than 1/12 → earliestStart = 1/12.
    const tasks = [
      {
        ...task('a', '2026-01-05', 5),
        constraints: { type: 'startNoEarlierThan' as const, date: '2026-01-12' },
      },
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestStart.get('a')).toBe('2026-01-12');
  });

  it('MSO hard-anchor overrides the dependency-implied start', () => {
    // b depends on a (FS, a ends 1/9 → b implied 1/12). MSO 1/5 forces b to 1/5.
    const tasks = [
      task('a', '2026-01-05', 5),
      {
        ...task('b', '2026-01-12', 5, [{ targetId: 'a', type: 'FS', lag: 0 }]),
        constraints: { type: 'mustStartOn' as const, date: '2026-01-05' },
      },
    ];
    const r = computeCriticalPath(tasks, calendar);
    // MSO overrides → earliestStart = 1/5 (the hard anchor), not 1/12 (dep-implied).
    expect(r.earliestStart.get('b')).toBe('2026-01-05');
  });

  it('MFO hard-anchor back-calculates earliestStart from the constraint end', () => {
    // MFO 1/9, duration 5 → earliestStart = 1/5, earliestEnd = 1/9.
    const tasks = [
      {
        ...task('a', '2026-01-12', 5),
        constraints: { type: 'mustFinishOn' as const, date: '2026-01-09' },
      },
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestEnd.get('a')).toBe('2026-01-09');
    expect(r.earliestStart.get('a')).toBe('2026-01-05');
  });

  it('FNLT tightens latestEnd in the backward pass', () => {
    // a (1/5, dur 5) is a sink. Project end would normally be 1/9. FNLT 1/7
    // caps latestEnd at 1/7 (earlier).
    const tasks = [
      {
        ...task('a', '2026-01-05', 5),
        constraints: { type: 'finishNoLaterThan' as const, date: '2026-01-07' },
      },
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.latestEnd.get('a')! <= '2026-01-07').toBe(true);
  });
});
