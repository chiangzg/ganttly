import { describe, expect, it } from 'vitest';
import { hitTaskBar } from '@/lib/taskHoverHit';
import type { Scene, TaskRow } from '@/engine/render/types';
import { HEADER_HEIGHT, ROW_HEIGHT, dateToPixel } from '@/engine/layout';

const ORIGIN = '2026-02-02';
const ZOOM = 'week' as const;
const PX_PER_DAY = 20; // week zoom = 140/7

function makeRow(over: Partial<TaskRow> & { id: string; yIndex: number }): TaskRow {
  return {
    name: over.id,
    start: '2026-02-02',
    end: '2026-02-06',
    duration: 5,
    progress: 0,
    isMilestone: false,
    depth: 0,
    wbsNumber: String(over.yIndex + 1),
    ...over,
  } as TaskRow;
}

function makeScene(rows: TaskRow[], scrollTop = 0, scrollLeft = 0): Scene {
  return {
    zoom: ZOOM,
    originDate: ORIGIN,
    scrollLeft,
    scrollTop,
    viewportWidth: 1000,
    viewportHeight: 400,
    today: ORIGIN,
    holidays: [],
    rows,
    totalRows: rows.length,
    arrows: [],
    showCriticalPath: false,
    hasActiveBaseline: false,
    selectedTaskId: null,
    selectedTaskIds: new Set<string>(),
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

describe('hitTaskBar', () => {
  it('hits a leaf bar within its X range', () => {
    const row = makeRow({ id: 't0', yIndex: 0, start: '2026-02-02', end: '2026-02-06' });
    const scene = makeScene([row]);
    const x = dateX('2026-02-03');
    expect(hitTaskBar(scene, x, rowCenterY(0))?.id).toBe('t0');
  });

  it('returns null on empty space to the right of the bar', () => {
    const row = makeRow({ id: 't0', yIndex: 0, start: '2026-02-02', end: '2026-02-06' });
    const scene = makeScene([row]);
    // Well past the bar end (2026-02-06 + a week).
    const x = dateX('2026-02-20');
    expect(hitTaskBar(scene, x, rowCenterY(0))).toBeNull();
  });

  it('returns null above the header', () => {
    const row = makeRow({ id: 't0', yIndex: 0 });
    const scene = makeScene([row]);
    expect(hitTaskBar(scene, dateX('2026-02-03'), HEADER_HEIGHT - 5)).toBeNull();
  });

  it('hits a summary bar (unlike interactive hitTest which returns empty)', () => {
    const row = makeRow({
      id: 'summary',
      yIndex: 0,
      isSummary: true,
      start: '2026-02-02',
      end: '2026-02-10',
    });
    const scene = makeScene([row]);
    expect(hitTaskBar(scene, dateX('2026-02-05'), rowCenterY(0))?.id).toBe('summary');
  });

  it('hits a milestone (small diamond hit area near its date)', () => {
    const row = makeRow({
      id: 'm0',
      yIndex: 0,
      isMilestone: true,
      start: '2026-02-04',
      end: '2026-02-04',
    });
    const scene = makeScene([row]);
    // Milestone diamond centres on the day's END line (start + one day).
    const cx = dateX('2026-02-05');
    expect(hitTaskBar(scene, cx, rowCenterY(0))?.id).toBe('m0');
  });

  it('respects scrollTop when mapping Y to a row', () => {
    // Two rows; scroll so row 1 is at the top of the viewport.
    const r0 = makeRow({ id: 't0', yIndex: 0 });
    const r1 = makeRow({ id: 't1', yIndex: 1, start: '2026-02-02', end: '2026-02-06' });
    const scrollTop = ROW_HEIGHT; // scrolled down one row
    const scene = makeScene([r0, r1], scrollTop);
    // Row 1 now appears at viewport yIndex 0 visually; its center is at
    // HEADER_HEIGHT + 1*ROW_HEIGHT - scrollTop + ROW_HEIGHT/2.
    const y = HEADER_HEIGHT + 1 * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
    expect(hitTaskBar(scene, dateX('2026-02-03'), y)?.id).toBe('t1');
  });

  it('respects scrollLeft when mapping X', () => {
    const row = makeRow({ id: 't0', yIndex: 0, start: '2026-02-02', end: '2026-02-06' });
    const scrollLeft = PX_PER_DAY * 7; // scrolled right one week
    const scene = makeScene([row], 0, scrollLeft);
    // The bar start in viewport coords is now shifted left by scrollLeft.
    const x = dateX('2026-02-03', scrollLeft);
    expect(hitTaskBar(scene, x, rowCenterY(0))?.id).toBe('t0');
  });

  it('does not hit when Y is just outside the row band (gap between rows)', () => {
    const row = makeRow({ id: 't0', yIndex: 0, start: '2026-02-02', end: '2026-02-06' });
    const scene = makeScene([row]);
    // Y at the very top edge of row 0's band is excluded (rowTop+2 guard).
    const rowTop = HEADER_HEIGHT + 0 * ROW_HEIGHT;
    expect(hitTaskBar(scene, dateX('2026-02-03'), rowTop + 1)).toBeNull();
  });

  it('returns null for a yIndex with no row in the scene slice', () => {
    // Only row 0 is in the scene; pointing at yIndex 5 finds nothing.
    const row = makeRow({ id: 't0', yIndex: 0 });
    const scene = makeScene([row]);
    expect(hitTaskBar(scene, dateX('2026-02-03'), rowCenterY(5))).toBeNull();
  });
});
