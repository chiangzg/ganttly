/**
 * Canvas interaction: drag bars, resize handles, draw dependency arrows.
 *
 * The interaction layer translates raw mouse events into:
 * - Which task is under the cursor (hit testing)
 * - What action is intended (move / resize-left / resize-right / connect)
 * - A draft of the new geometry, applied via Command on pointer up
 *
 * Geometry helpers are pure; the event wiring lives in the React component.
 */
import type { Scene, TaskRow } from '../render/types';
import { HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, dateRangeWidth, pixelToDate } from '../layout';
import { addCalendarDays } from '@/lib/calendar';

export type HitZone =
  | { kind: 'body'; taskId: string }
  | { kind: 'left-handle'; taskId: string }
  | { kind: 'right-handle'; taskId: string }
  | { kind: 'right-edge'; taskId: string } // for creating a dependency arrow
  | { kind: 'empty' };

const HANDLE_WIDTH = 6;

/** Hit-test a viewport-local (x, y). Returns what was hit. */
export function hitTest(scene: Scene, x: number, y: number): HitZone {
  if (y < HEADER_HEIGHT) return { kind: 'empty' };
  const rowIndex = Math.floor((y - HEADER_HEIGHT) / ROW_HEIGHT);
  // First N rows in scene.rows correspond to first N visible rows starting
  // from the firstVisibleRow computed by assembleScene. To keep things simple
  // we treat scene.rows as already-windowed starting at row 0 of the viewport
  // (assembly guarantees this — see scene/assembly.ts firstVisibleRow).
  const row = scene.rows[rowIndex];
  if (!row) return { kind: 'empty' };

  const xStart = dateToPixel(row.start, scene.originDate, scene.zoom) - scene.scrollLeft;
  const width = Math.max(dateRangeWidth(row.start, row.end, scene.zoom), 16);
  if (x < xStart - 2 || x > xStart + width + 2) return { kind: 'empty' };

  if (Math.abs(x - xStart) <= HANDLE_WIDTH) return { kind: 'left-handle', taskId: row.id };
  if (Math.abs(x - (xStart + width)) <= HANDLE_WIDTH)
    return { kind: 'right-handle', taskId: row.id };
  // Right-edge "tail" zone for connecting: a small strip just past the right handle.
  if (x > xStart + width + HANDLE_WIDTH && x < xStart + width + HANDLE_WIDTH + 12) {
    return { kind: 'right-edge', taskId: row.id };
  }
  return { kind: 'body', taskId: row.id };
}

export type DragState =
  | { kind: 'idle' }
  | { kind: 'move'; taskId: string; grabOffsetDays: number }
  | { kind: 'resize-left'; taskId: string }
  | { kind: 'resize-right'; taskId: string }
  | { kind: 'connect'; fromTaskId: string }
  | {
      kind: 'pan';
      /** Pointer position (viewport-local) at pan start. */
      startX: number;
      startY: number;
      /** Scroll values at pan start. */
      startScrollLeft: number;
      startScrollTop: number;
      /** Set true once the pointer moved past PAN_THRESHOLD (commit the pan). */
      engaged: boolean;
    };

/** Pointer must move at least this many CSS px before a press becomes a pan. */
export const PAN_THRESHOLD = 3;

/** Compute the new start/end ISO dates for a task given a drag delta. */
export function applyDrag(
  scene: Scene,
  row: TaskRow,
  drag: DragState,
  cursorX: number,
  _cursorY: number,
): { start: string; end: string } | null {
  if (drag.kind === 'idle') return null;
  if (drag.kind === 'move') {
    // Days moved = round((cursorX - grabOffsetPx - barXStart) / pxPerDay)
    // Simpler: derive the bar's intended start from cursor + original offset.
    const cursorDays = Math.round((cursorX + scene.scrollLeft) / pxPerDay(scene.zoom));
    const newStartOffset = cursorDays - drag.grabOffsetDays;
    const newStartISO = addCalendarDays(scene.originDate, newStartOffset);
    const duration = dayDelta(row.start, row.end) + 1; // inclusive
    const newEndISO = addCalendarDays(newStartISO, duration - 1);
    return { start: newStartISO, end: newEndISO };
  }
  if (drag.kind === 'resize-left') {
    const newStartISO = pixelToDate(cursorX + scene.scrollLeft, scene.originDate, scene.zoom);
    if (newStartISO > row.end) return null;
    return { start: newStartISO, end: row.end };
  }
  if (drag.kind === 'resize-right') {
    const newEndISO = pixelToDate(cursorX + scene.scrollLeft, scene.originDate, scene.zoom);
    if (newEndISO < row.start) return null;
    return { start: row.start, end: newEndISO };
  }
  return null;
}

function pxPerDay(zoom: Scene['zoom']): number {
  const COLUMN_WIDTH = { day: 32, week: 140, month: 120, year: 80 } as const;
  const DAYS_PER_COLUMN = { day: 1, week: 7, month: 30, year: 30 } as const;
  return COLUMN_WIDTH[zoom] / DAYS_PER_COLUMN[zoom];
}

function dayDelta(startISO: string, endISO: string): number {
  const [a, b, c] = startISO.split('-').map(Number);
  const [d, e, f] = endISO.split('-').map(Number);
  const ms = Date.UTC(d!, e! - 1, f!) - Date.UTC(a!, b! - 1, c!);
  return Math.round(ms / 86_400_000);
}

void dateToPixel; // referenced via hitTest — keep import
