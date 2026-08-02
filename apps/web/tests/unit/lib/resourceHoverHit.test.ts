import { describe, expect, it } from 'vitest';
import { hitResource } from '@/lib/resourceHoverHit';
import type { ResourceScene, ResourceRow } from '@/engine/render/types';
import { HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, pixelsPerDay } from '@/engine/layout';

const ORIGIN = '2026-02-02';
// day zoom = 32px/day so daily bars are wide and individually hittable.
const ZOOM = 'day' as const;
const PX_PER_DAY = pixelsPerDay(ZOOM);

function makeResourceRow(
  over: Partial<Extract<ResourceRow, { kind: 'resource' }>> & { yIndex: number },
): Extract<ResourceRow, { kind: 'resource' }> {
  return {
    kind: 'resource',
    id: 'r1',
    name: 'Alice',
    capacity: 1,
    bars: [],
    expanded: false,
    taskCount: 0,
    ...over,
  };
}

function makeTaskLaneRow(
  over: Partial<Extract<ResourceRow, { kind: 'task' }>> & { yIndex: number; taskId: string },
): Extract<ResourceRow, { kind: 'task' }> {
  return {
    kind: 'task',
    resourceId: 'r1',
    name: 'Task A',
    wbsNumber: '1',
    start: '2026-02-02',
    end: '2026-02-06',
    duration: 5,
    progress: 0,
    isMilestone: false,
    load: 50,
    capacity: 1,
    ...over,
  };
}

function makeScene(rows: ResourceRow[], over: Partial<ResourceScene> = {}): ResourceScene {
  return {
    zoom: ZOOM,
    originDate: ORIGIN,
    scrollLeft: 0,
    scrollTop: 0,
    viewportWidth: 1000,
    viewportHeight: 400,
    today: ORIGIN,
    holidays: [],
    rows,
    selectedResourceId: null,
    selectedTaskIdInResource: null,
    resourceById: new Map([['r1', { id: 'r1', name: 'Alice', capacity: 1 }]]),
    ...over,
  };
}

/** Viewport Y of the vertical center of the row with `yIndex`. */
function rowCenterY(yIndex: number, scrollTop = 0): number {
  return HEADER_HEIGHT + yIndex * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
}

/** Viewport X at a given ISO date for this scene. */
function dateX(iso: string, scrollLeft = 0): number {
  return dateToPixel(iso, ORIGIN, ZOOM) - scrollLeft;
}

describe('hitResource', () => {
  it('hits a daily load bar on a resource row', () => {
    const row = makeResourceRow({
      yIndex: 0,
      bars: [{ resourceId: 'r1', date: '2026-02-03', load: 80 }],
    });
    const scene = makeScene([row]);
    const hit = hitResource(scene, dateX('2026-02-03'), rowCenterY(0));
    expect(hit).toEqual({
      kind: 'resource-day',
      resourceId: 'r1',
      date: '2026-02-03',
      bar: { resourceId: 'r1', date: '2026-02-03', load: 80 },
    });
  });

  it('returns empty above the header', () => {
    const row = makeResourceRow({
      yIndex: 0,
      bars: [{ resourceId: 'r1', date: '2026-02-03', load: 80 }],
    });
    const scene = makeScene([row]);
    expect(hitResource(scene, dateX('2026-02-03'), HEADER_HEIGHT - 5)).toEqual({ kind: 'empty' });
  });

  it('returns empty on a resource row with no bar at that date', () => {
    const row = makeResourceRow({
      yIndex: 0,
      bars: [{ resourceId: 'r1', date: '2026-02-03', load: 80 }],
    });
    const scene = makeScene([row]);
    // A date with no bar (well clear of 2026-02-03).
    expect(hitResource(scene, dateX('2026-02-10'), rowCenterY(0))).toEqual({ kind: 'empty' });
  });

  it('hits the correct bar among multiple adjacent bars', () => {
    const row = makeResourceRow({
      yIndex: 0,
      bars: [
        { resourceId: 'r1', date: '2026-02-03', load: 40 },
        { resourceId: 'r1', date: '2026-02-04', load: 70 },
      ],
    });
    const scene = makeScene([row]);
    // Aim at the CENTER of the 02-04 column so it's unambiguously over that bar
    // (at day zoom each bar spans nearly a full 32px column, so the column start
    // is the boundary shared with the previous day's bar).
    const centerX = dateX('2026-02-04') + PX_PER_DAY / 2;
    const hit = hitResource(scene, centerX, rowCenterY(0));
    expect(hit.kind).toBe('resource-day');
    if (hit.kind === 'resource-day') {
      expect(hit.date).toBe('2026-02-04');
      expect(hit.bar.load).toBe(70);
    }
  });

  it('respects scrollTop when locating the row', () => {
    // Two resource rows; scroll so row 1 is at the top.
    const rows = [
      makeResourceRow({ yIndex: 0, bars: [{ resourceId: 'r1', date: '2026-02-03', load: 10 }] }),
      makeResourceRow({
        yIndex: 1,
        id: 'r2',
        bars: [{ resourceId: 'r2', date: '2026-02-03', load: 90 }],
      }),
    ];
    const scrollTop = ROW_HEIGHT; // shift up by one row
    const scene = makeScene(rows, { scrollTop });
    // Row 1 (r2) now sits where row 0 was visually.
    const hit = hitResource(scene, dateX('2026-02-03'), rowCenterY(1, scrollTop));
    expect(hit.kind).toBe('resource-day');
    if (hit.kind === 'resource-day') expect(hit.resourceId).toBe('r2');
  });

  it('hits a task lane within its date span', () => {
    const row = makeTaskLaneRow({
      yIndex: 1,
      taskId: 't1',
      start: '2026-02-02',
      end: '2026-02-06',
    });
    const scene = makeScene([row]);
    const hit = hitResource(scene, dateX('2026-02-04'), rowCenterY(1));
    expect(hit).toEqual({ kind: 'task-lane', resourceId: 'r1', taskId: 't1' });
  });

  it('returns empty beside a task lane (outside the span)', () => {
    const row = makeTaskLaneRow({
      yIndex: 1,
      taskId: 't1',
      start: '2026-02-02',
      end: '2026-02-06',
    });
    const scene = makeScene([row]);
    expect(hitResource(scene, dateX('2026-02-20'), rowCenterY(1))).toEqual({ kind: 'empty' });
  });

  it('hits a milestone lane at its diamond', () => {
    const row = makeTaskLaneRow({
      yIndex: 1,
      taskId: 'm1',
      start: '2026-02-04',
      end: '2026-02-04',
      isMilestone: true,
    });
    const scene = makeScene([row]);
    // Milestone diamond centres at start-day column + half a day.
    const cx = dateToPixel('2026-02-04', ORIGIN, ZOOM) + PX_PER_DAY / 2;
    const hit = hitResource(scene, cx, rowCenterY(1));
    expect(hit).toEqual({ kind: 'task-lane', resourceId: 'r1', taskId: 'm1' });
  });

  it('returns empty on a task-header row', () => {
    const rows: ResourceRow[] = [
      makeResourceRow({ yIndex: 0 }),
      { kind: 'task-header', yIndex: 1, resourceId: 'r1' },
      makeTaskLaneRow({ yIndex: 2, taskId: 't1', start: '2026-02-02', end: '2026-02-06' }),
    ];
    const scene = makeScene(rows);
    // Point at the header row's center, at a date that WOULD be a lane span —
    // but it's on the header row, so it must be empty.
    expect(hitResource(scene, dateX('2026-02-04'), rowCenterY(1))).toEqual({ kind: 'empty' });
  });

  it('returns empty in the vertical gap between rows', () => {
    const row = makeResourceRow({
      yIndex: 0,
      bars: [{ resourceId: 'r1', date: '2026-02-03', load: 80 }],
    });
    const scene = makeScene([row]);
    // Y in the 2px inset band near the row's top edge is empty.
    const gapY = HEADER_HEIGHT + 0 * ROW_HEIGHT + 1;
    expect(hitResource(scene, dateX('2026-02-03'), gapY)).toEqual({ kind: 'empty' });
  });

  it('returns empty for a point below all rows', () => {
    const row = makeResourceRow({
      yIndex: 0,
      bars: [{ resourceId: 'r1', date: '2026-02-03', load: 80 }],
    });
    const scene = makeScene([row]);
    // yIndex 5 does not exist.
    expect(hitResource(scene, dateX('2026-02-03'), rowCenterY(5))).toEqual({ kind: 'empty' });
  });
});
