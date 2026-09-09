import { describe, expect, it } from 'vitest';
import { computeCriticalPath } from '../src/cpm';
import { computeImpliedStart, computeImpliedEnd } from '../src/schedule';
import { getCalendar } from '@ganttly/calendar-data';
import { resolveCalendar } from '../src/calendar';
import type { Task, Dependency } from '@ganttly/schema';

const calendar = getCalendar('zh-CN');
const cal = resolveCalendar(calendar);

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

describe('computeCriticalPath — dependency types (FS/SS/FF/SF)', () => {
  it('SS: successor is released by the predecessor START, not its end (no inversion)', () => {
    // a (10d, 01-05…01-16). b SS a lag 2, dur 2 → b starts 01-07, ends 01-08.
    // a ends later → a is critical; b has 6 working days of float. The old
    // FS-only bug computed b from a's END (01-21) and inverted the path.
    const tasks = [
      task('a', '2026-01-05', 10),
      task('b', '2026-01-07', 2, [{ targetId: 'a', type: 'SS', lag: 2 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestStart.get('b')).toBe('2026-01-07');
    expect(r.earliestEnd.get('b')).toBe('2026-01-08');
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('b')).toBe(false);
    expect(r.totalFloat.get('b')).toBe(6);
  });

  it('FF: successor END is pinned to predecessor END + lag', () => {
    // a (5d, 01-05…01-09). b FF a lag 0, dur 3 → b must end 01-09 → starts 01-07.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-07', 3, [{ targetId: 'a', type: 'FF', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestEnd.get('b')).toBe('2026-01-09');
    expect(r.earliestStart.get('b')).toBe('2026-01-07');
    // Both end 01-09 → both critical.
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('b')).toBe(true);
  });

  it('SF: successor END is released by the predecessor START + lag', () => {
    // a (5d, starts 01-05). b SF a lag 3, dur 2 → b ends ≥ 01-08 → starts 01-07.
    // a still ends later (01-09) → a critical, b float 1.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-07', 2, [{ targetId: 'a', type: 'SF', lag: 3 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestStart.get('b')).toBe('2026-01-07');
    expect(r.earliestEnd.get('b')).toBe('2026-01-08');
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('b')).toBe(false);
    expect(r.totalFloat.get('b')).toBe(1);
  });

  it('backward pass mirrors SS: predecessor LS ≤ successor LS − lag', () => {
    // b SS-depends on a (a is the predecessor), c FS-depends on b. c's LS
    // (01-12) caps b's LS at 01-05, which caps a's LS at 01-05 too → the 10-day
    // a has zero float and is critical.
    const tasks = [
      task('a', '2026-01-05', 10),
      task('b', '2026-01-05', 5, [{ targetId: 'a', type: 'SS', lag: 0 }]),
      task('c', '2026-01-12', 5, [{ targetId: 'b', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.latestEnd.get('b')).toBe('2026-01-09');
    expect(r.latestStart.get('a')!).toBe('2026-01-05');
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('b')).toBe(true);
    expect(r.criticalTaskIds.has('c')).toBe(true);
  });

  it('backward pass mirrors FF: predecessor LE ≤ successor LE − lag', () => {
    // b FF-depends on a (a is the predecessor), c FS-depends on b. c's LS
    // (01-12) caps b's LE at 01-09, which caps a's LE at 01-09 → zero float.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-05', 5, [{ targetId: 'a', type: 'FF', lag: 0 }]),
      task('c', '2026-01-12', 5, [{ targetId: 'b', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.latestEnd.get('a')).toBe('2026-01-09');
    expect(r.criticalTaskIds.has('a')).toBe(true);
    expect(r.criticalTaskIds.has('b')).toBe(true);
    expect(r.criticalTaskIds.has('c')).toBe(true);
  });

  it('implied dates agree with the scheduling engine (schedule.ts) for all four types', () => {
    // Seed each successor far in the past so the CPM start is purely
    // dependency-implied, then compare against computeImpliedStart/End.
    const cases: Array<Dependency> = [
      { targetId: 'a', type: 'FS', lag: 1 },
      { targetId: 'a', type: 'SS', lag: 2 },
      { targetId: 'a', type: 'FF', lag: 1 },
      { targetId: 'a', type: 'SF', lag: 2 },
    ];
    for (const dep of cases) {
      const a = task('a', '2026-01-05', 5);
      const b = task('b', '2025-01-01', 3, [dep]);
      const r = computeCriticalPath([a, b], calendar);
      if (dep.type === 'FS' || dep.type === 'SS') {
        expect(r.earliestStart.get('b'), dep.type).toBe(computeImpliedStart(a, dep, cal));
      } else {
        expect(r.earliestEnd.get('b'), dep.type).toBe(computeImpliedEnd(a, dep, cal));
      }
    }
  });
});

describe('computeCriticalPath — as-scheduled anchoring', () => {
  it('a manually delayed successor drives the project end and is critical', () => {
    // a 01-05 5d; b FS a but manually drawn at 01-26 (3 weeks later). The plan
    // as drawn ends 01-27: b is critical, a keeps 14wd float. The old forward
    // pass ignored b's drawn start entirely.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-26', 2, [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestStart.get('b')).toBe('2026-01-26');
    expect(r.earliestEnd.get('b')).toBe('2026-01-27');
    expect(r.criticalTaskIds.has('b')).toBe(true);
    expect(r.criticalTaskIds.has('a')).toBe(false);
    // a must FINISH by 01-23 to release b on 01-26 → its latest START is
    // 01-19 (5d duration) → float = 01-05…01-19 = 11wd − 1 = 10.
    expect(r.totalFloat.get('a')).toBe(10);
  });

  it('a manually EARLY successor is pulled forward by the network (violations are not rewarded)', () => {
    // b drawn at 01-05 violates its FS link (a ends 01-09 → implies 01-12).
    // The network wins: ES(b)=01-12; the drawn-early date must not widen the
    // project end.
    const tasks = [
      task('a', '2026-01-05', 5),
      task('b', '2026-01-05', 2, [{ targetId: 'a', type: 'FS', lag: 0 }]),
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.earliestStart.get('b')).toBe('2026-01-12');
    expect(r.earliestEnd.get('b')).toBe('2026-01-13');
  });

  it('an FNLT-violating task clamps negative float to zero and stays critical', () => {
    // Drawn 01-05…01-09 but FNLT 01-07: latestEnd 01-07 < earliestEnd 01-09.
    const tasks = [
      {
        ...task('a', '2026-01-05', 5),
        constraints: { type: 'finishNoLaterThan' as const, date: '2026-01-07' },
      },
    ];
    const r = computeCriticalPath(tasks, calendar);
    expect(r.totalFloat.get('a')).toBe(0);
    expect(r.criticalTaskIds.has('a')).toBe(true);
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
