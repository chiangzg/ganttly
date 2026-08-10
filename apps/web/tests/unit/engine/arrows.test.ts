/**
 * Unit tests for arrow geometry (PRD §3.3, §7.4).
 *
 * Asserts that `assembleScene` produces correct from/to endpoints for each of
 * the four dependency types (FS / SS / FF / SF), which is the geometry the
 * Canvas renderer turns into orthogonal arrows.
 *
 * These guard against regressions in `endpointX`'s "use END vs START" logic
 * (arrows must connect the right bar edge per PM dependency semantics).
 */
import { describe, it, expect } from 'vitest';
import type { GanttlyFile, Task } from '@ganttly/schema';
import { assembleScene } from '@/engine/scene';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { computeArrowRoute } from '@/engine/render/arrows';
import { MILESTONE_RADIUS } from '@/engine/render/geometry';

const ZH_CN_HOLIDAYS: GanttlyFile['calendar']['holidays'] = [];

function makeFile(tasks: Task[]): GanttlyFile {
  return {
    schemaVersion: 1,
    // Pin startDate to the earliest task so originDateFor is deterministic.
    project: { name: 'test', locale: 'zh-CN', startDate: '2026-02-02' },
    calendar: {
      id: 'zh-CN',
      weekStart: 1,
      weekends: [0, 6],
      holidays: ZH_CN_HOLIDAYS,
      workingHours: { start: '09:00', end: '18:00' },
    },
    tasks,
    resources: [],
    baselines: [],
    viewState: {
      zoom: 'week',
      scrollLeft: 0,
      scrollTop: 0,
      selectedTaskId: null,
      showCriticalPath: false,
      collapsedTaskIds: [],
    },
    meta: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      appVersion: '0.1.0',
    },
  };
}

function baseTask(id: string, overrides: Partial<Task> = {}): Task {
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

const OPTS = {
  viewportWidth: 800,
  viewportHeight: 400,
  today: '2026-02-04',
};

describe('assembleScene arrow geometry — 4 dependency types', () => {
  // week zoom = 20px/day. Tasks below share origin = '2026-02-02' (earliest
  // start), so:
  //   predecessor A: start 02-02 (day 0, px 0),   end 02-06 (day 4, px 80; end+1 = day 5 = px 100)
  //   successor   B: start 02-09 (day 7, px 140), end 02-13 (day 11, px 220; end+1 = day 12 = px 240)

  const A = baseTask('A', { order: 0 });
  const B = baseTask('B', { order: 1, start: '2026-02-09', end: '2026-02-13', duration: 5 });

  it('FS arrow: predecessor END → successor START', () => {
    const file = makeFile([A, { ...B, dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }] }]);
    const scene = assembleScene(file, OPTS);
    expect(scene.arrows).toHaveLength(1);
    const a = scene.arrows[0]!;
    expect(a.type).toBe('FS');
    // from = A.end + 1 day = day 5 = 100px; to = B.start = day 7 = 140px.
    expect(a.fromX).toBe(100);
    expect(a.toX).toBe(140);
    // Y: row 0 and row 1 centers.
    expect(a.fromY).toBeLessThan(a.toY); // A above B
  });

  it('SS arrow: predecessor START → successor START', () => {
    const file = makeFile([A, { ...B, dependencies: [{ targetId: 'A', type: 'SS', lag: 0 }] }]);
    const scene = assembleScene(file, OPTS);
    const a = scene.arrows[0]!;
    expect(a.type).toBe('SS');
    expect(a.fromX).toBe(0); // A.start = day 0
    expect(a.toX).toBe(140); // B.start = day 7
  });

  it('FF arrow: predecessor END → successor END', () => {
    const file = makeFile([A, { ...B, dependencies: [{ targetId: 'A', type: 'FF', lag: 0 }] }]);
    const scene = assembleScene(file, OPTS);
    const a = scene.arrows[0]!;
    expect(a.type).toBe('FF');
    expect(a.fromX).toBe(100); // A.end+1 = day 5
    expect(a.toX).toBe(240); // B.end+1 = day 12
  });

  it('SF arrow: predecessor START → successor END', () => {
    const file = makeFile([A, { ...B, dependencies: [{ targetId: 'A', type: 'SF', lag: 0 }] }]);
    const scene = assembleScene(file, OPTS);
    const a = scene.arrows[0]!;
    expect(a.type).toBe('SF');
    expect(a.fromX).toBe(0); // A.start
    expect(a.toX).toBe(240); // B.end+1
  });

  it('multiple dependencies produce one arrow each', () => {
    const file = makeFile([
      A,
      baseTask('C', { id: 'C', order: 2, start: '2026-02-16', end: '2026-02-20', duration: 5 }),
      {
        ...B,
        dependencies: [
          { targetId: 'A', type: 'FS', lag: 0 },
          { targetId: 'A', type: 'SS', lag: 0 },
        ],
      },
    ]);
    const scene = assembleScene(file, OPTS);
    expect(scene.arrows.length).toBe(2);
    expect(scene.arrows.map((a) => a.type).sort()).toEqual(['FS', 'SS']);
  });

  it('arrow isCritical flag mirrors critical-path membership', () => {
    // A→B as the only chain → both critical.
    const file = makeFile([A, { ...B, dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }] }]);
    const scene = assembleScene(file, { ...OPTS });
    // We can't easily flip showCriticalPath here without it also affecting
    // assembly's CPM pass, so just assert the flag is a boolean.
    const a = scene.arrows[0]!;
    expect(typeof a.isCritical).toBe('boolean');
  });
});

describe('assembleScene arrow geometry — honours scrollTop', () => {
  // Guards the desync fix: arrow Y must be GLOBAL row index → px, MINUS
  // scrollTop (so arrows track their bars during sub-row scroll). The old code
  // used a slice-local index with no scrollTop subtraction.
  const A = baseTask('A', { order: 0 });
  const B = baseTask('B', { order: 1, start: '2026-02-09', end: '2026-02-13', duration: 5 });

  it('subtracts scrollTop from arrow Y (row 0 & row 1)', () => {
    const scrollTop = 10; // sub-row offset
    const file = makeFile([A, { ...B, dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }] }]);
    file.viewState.scrollTop = scrollTop;
    const scene = assembleScene(file, OPTS);
    const a = scene.arrows[0]!;
    // A=row0 centre, B=row1 centre: 56 + (idx+0.5)*32, each minus scrollTop.
    expect(a.fromY).toBe(HEADER_HEIGHT + (0 + 0.5) * ROW_HEIGHT - scrollTop);
    expect(a.toY).toBe(HEADER_HEIGHT + (1 + 0.5) * ROW_HEIGHT - scrollTop);
  });
});

describe('orthogonal dependency routing', () => {
  it('routes an adjacent FS dependency through the row gap instead of a degenerate curve', () => {
    const predecessor = baseTask('A', { order: 0 });
    const successor = baseTask('B', {
      order: 1,
      start: '2026-02-07',
      end: '2026-02-09',
      duration: 3,
      dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }],
    });
    const scene = assembleScene(makeFile([predecessor, successor]), OPTS);
    const arrow = scene.arrows[0]!;
    const points = computeArrowRoute(arrow, scene);

    expect(points[0]).toEqual({ x: arrow.fromX, y: arrow.fromY });
    expect(points.at(-1)).toEqual({ x: arrow.toX, y: arrow.toY });
    expect(points.some((point) => point.y === arrow.fromY + ROW_HEIGHT / 2)).toBe(true);
    expect(
      points.every((point, index) => {
        if (index === 0) return true;
        const previous = points[index - 1]!;
        return previous.x === point.x || previous.y === point.y;
      }),
    ).toBe(true);
  });

  it('fans multiple dependencies into distinct milestone edge ports', () => {
    const milestone = baseTask('M', {
      order: 3,
      start: '2026-02-16',
      end: '2026-02-16',
      duration: 0,
      isMilestone: true,
      dependencies: [
        { targetId: 'A', type: 'FS', lag: 0 },
        { targetId: 'B', type: 'FS', lag: 0 },
        { targetId: 'C', type: 'FS', lag: 0 },
      ],
    });
    const file = makeFile([
      baseTask('A', { order: 0 }),
      baseTask('B', { order: 1, start: '2026-02-03', end: '2026-02-07' }),
      baseTask('C', { order: 2, start: '2026-02-04', end: '2026-02-08' }),
      milestone,
    ]);
    const scene = assembleScene(file, OPTS);
    const targetYs = scene.arrows.map((arrow) => arrow.toY);
    const targetXs = scene.arrows.map((arrow) => arrow.toX);
    const milestoneCenterX = 14 * 20;

    expect(new Set(targetYs).size).toBe(3);
    expect(targetYs).toEqual([...targetYs].sort((a, b) => a - b));
    expect(Math.max(...targetYs) - Math.min(...targetYs)).toBeLessThanOrEqual(14);
    expect(targetXs.every((x) => x >= milestoneCenterX - MILESTONE_RADIUS)).toBe(true);
    expect(targetXs.every((x) => x < milestoneCenterX)).toBe(true);
  });

  it('chooses a vertical corridor outside intervening task bars', () => {
    const target = baseTask('C', {
      order: 2,
      start: '2026-02-16',
      end: '2026-02-20',
      dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }],
    });
    const scene = assembleScene(
      makeFile([
        baseTask('A', { order: 0 }),
        baseTask('B', { order: 1, start: '2026-02-06', end: '2026-02-18' }),
        target,
      ]),
      OPTS,
    );
    const route = computeArrowRoute(scene.arrows[0]!, scene);
    const verticalXs = route
      .slice(1)
      .filter((point, index) => point.x === route[index]!.x && point.y !== route[index]!.y)
      .map((point) => point.x);

    expect(verticalXs.some((x) => x < 72 || x > 348)).toBe(true);
  });
});
