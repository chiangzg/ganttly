/**
 * Pure read-only bar hit-test for the task hover tooltip + canvas context menu
 * (editor-interaction-optimization-plan §3.2 / §3.4).
 *
 * Unlike the interactive `hitTest` in `engine/interaction`, this covers summary
 * and milestone rows too, and never returns a draggable zone — it only answers
 * "is the pointer over this task's bar?". Extracted as a pure function so the
 * geometry can be unit-tested without a DOM/store.
 */
import type { Scene, TaskRow } from '@/engine/render/types';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  dateToPixel,
  dateRangeWidth,
  pixelsPerDay,
} from '@/engine/layout';

/**
 * Returns the task row whose bar is under the viewport-local point (x, y), or
 * null. Covers leaf, summary and milestone bars. Accounts for `scene.scrollTop`
 * (the visible `scene.rows` slice is windowed, but each row carries its global
 * `yIndex`, so the Y→row lookup must add scrollTop back — same approach as
 * `useBaselineHover.rowAt`).
 */
export function hitTaskBar(scene: Scene, x: number, y: number): TaskRow | null {
  if (y < HEADER_HEIGHT) return null;
  const rowIdx = Math.floor((y - HEADER_HEIGHT + scene.scrollTop) / ROW_HEIGHT);
  const row = scene.rows.find((r) => r.yIndex === rowIdx);
  if (!row) return null;
  const chartX = x + scene.scrollLeft;
  const barX = dateToPixel(row.start, scene.originDate, scene.zoom);
  const barW = Math.max(
    dateRangeWidth(row.start, row.end, scene.zoom),
    // Milestones render as a diamond ~1 day wide; give a small min so the hit
    // area matches the visual glyph.
    row.isMilestone ? pixelsPerDay(scene.zoom) / 2 : 16,
  );
  const rowTop = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
  const inY = y >= rowTop + 2 && y <= rowTop + ROW_HEIGHT - 2;
  if (!inY) return null;
  if (chartX >= barX - 2 && chartX <= barX + barW + 2) return row;
  return null;
}
