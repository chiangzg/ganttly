/**
 * Pure read-only hit-test for the resource-view Canvas
 * (editor-interaction-optimization-plan §3.5 / §3.6 / §6.2).
 *
 * Answers "what is under the pointer?" for hover tooltips, idle cursor and
 * click/double-click selection — without producing any editable hit (the
 * resource view has no drag/resize). Extracted as a pure function so the
 * geometry can be unit-tested without a DOM/store, mirroring `hitTaskBar`.
 *
 * Hit precedence within a resource row: a `resource-day` load bar wins over a
 * `task-lane` span, because a daily bar always sits on a `resource` row while a
 * lane sits on a `task` row — the two row kinds never share a yIndex, so the
 * row lookup naturally disambiguates them.
 *
 * Accounts for `scene.scrollTop` (rows carry a global `yIndex`, so Y→row must
 * add scrollTop back), exactly like `hitTaskBar` and `useBaselineHover.rowAt`.
 */
import type { ResourceScene, ResourceHit } from '@/engine/render/types';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  dateToPixel,
  dateRangeWidth,
  milestoneCenterX,
  pixelsPerDay,
} from '@/engine/layout';

/** Y-tolerance inside a row (matches the task-bar hit in hitTaskBar). */
const Y_INSET = 2;

/**
 * Resolve the viewport-local point (x, y) to a resource-view hit.
 *
 * - `resource-day`: pointer is over a daily load bar on a `resource` row.
 *   Carries the bar (load + contributions) so the tooltip renders without a
 *   re-scan.
 * - `task-lane`: pointer is over a drilled-down task lane rectangle (or its
 *   milestone diamond). Carries the task + resource id for selection/open.
 * - `empty`: header area, task-header rows, gaps between bars, or out of range.
 */
export function hitResource(scene: ResourceScene, x: number, y: number): ResourceHit {
  if (y < HEADER_HEIGHT) return { kind: 'empty' };

  const rowIdx = Math.floor((y - HEADER_HEIGHT + scene.scrollTop) / ROW_HEIGHT);
  const row = scene.rows.find((r) => r.yIndex === rowIdx);
  if (!row) return { kind: 'empty' };

  const rowTop = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
  // Y must land inside the row's padded hit band (a few px inset top/bottom),
  // otherwise a pointer in the gap between rows is "empty".
  if (y < rowTop + Y_INSET || y > rowTop + ROW_HEIGHT - Y_INSET) return { kind: 'empty' };

  // --- Resource summary row: test the daily load bars. ---
  if (row.kind === 'resource') {
    const chartX = x + scene.scrollLeft;
    const dayW = pixelsPerDay(scene.zoom);
    // The renderer draws each bar at dateToPixel(date) with width max(2, dayW-1).
    // Use dayW as the per-column slot and a small X tolerance so adjacent bars
    // at narrow zooms are still individually hittable.
    const barW = Math.max(2, dayW - 1);
    for (const bar of row.bars) {
      const barX = dateToPixel(bar.date, scene.originDate, scene.zoom);
      if (chartX >= barX - 1 && chartX <= barX + barW + 1) {
        return { kind: 'resource-day', resourceId: row.id, date: bar.date, bar };
      }
    }
    return { kind: 'empty' };
  }

  // --- Task lane row: test the lane rectangle (or milestone diamond). ---
  if (row.kind === 'task') {
    const chartX = x + scene.scrollLeft;
    if (row.isMilestone) {
      // Milestone renders as a diamond centred on its day's END line.
      const cx = milestoneCenterX(row.start, scene.originDate, scene.zoom);
      const half = 5;
      // Diamond hit: use a slightly generous bounding box (the diamond's visual
      // half-extent plus 2px tolerance) so the small glyph is reachable.
      if (chartX >= cx - half - 2 && chartX <= cx + half + 2) {
        return { kind: 'task-lane', resourceId: row.resourceId, taskId: row.taskId };
      }
      return { kind: 'empty' };
    }
    const laneX = dateToPixel(row.start, scene.originDate, scene.zoom);
    const laneW = Math.max(2, dateRangeWidth(row.start, row.end, scene.zoom));
    if (chartX >= laneX - 1 && chartX <= laneX + laneW + 1) {
      return { kind: 'task-lane', resourceId: row.resourceId, taskId: row.taskId };
    }
    return { kind: 'empty' };
  }

  // task-header rows (the local column header inside an expanded group) are not
  // interactive on the canvas side.
  return { kind: 'empty' };
}
