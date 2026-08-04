/**
 * Zoom-around-anchor timeline navigation (editor-interaction-optimization-plan §4.5).
 *
 * Before this, zooming changed the zoom level but left `scrollLeft` untouched,
 * so the date under the cursor (or at the viewport center) drifted across the
 * screen on every zoom step — disorienting. This module recomputes `scrollLeft`
 * so a chosen anchor DATE stays at the same screen X after the zoom change.
 *
 * Two anchoring modes share one pure core:
 *   - Ctrl/Cmd+wheel: anchor = the DATE under the mouse cursor (`e.offsetX`).
 *   - Toolbar zoom buttons: anchor = the DATE at the viewport CENTER.
 *
 * The pure core is split out so it can be unit-tested without a DOM/store,
 * mirroring `revealTask.ts` / `fitProjectRange.ts`.
 */
import type { ZoomLevel } from '@ganttly/schema';
import { ZOOM_ORDER, dateToPixel, pixelToDate } from '@/engine/layout';

export interface ZoomAnchorResult {
  /** The requested next zoom level (unchanged if already at the boundary). */
  zoom: ZoomLevel;
  /** The scrollLeft that keeps the anchor date at `anchorScreenX`. */
  scrollLeft: number;
}

/**
 * Step one level toward finer (direction = -1) or coarser (+1), clamped to the
 * zoom range. Returns the SAME zoom when already at the boundary.
 */
export function nextZoomLevel(current: ZoomLevel, direction: -1 | 1): ZoomLevel {
  const idx = ZOOM_ORDER.indexOf(current);
  if (idx === -1) return current;
  const next = ZOOM_ORDER[Math.max(0, Math.min(ZOOM_ORDER.length - 1, idx + direction))];
  return next ?? current;
}

/**
 * Pure core: compute the `{ zoom, scrollLeft }` that keeps the date currently
 * at chart-local pixel `anchorChartX` at the SAME viewport-local position
 * after switching to `nextZoom`.
 *
 *   - `originDate`     — the renderer's chart origin (from `originDateFor`).
 *   - `currentZoom`    — zoom before the change.
 *   - `nextZoom`       — zoom after the change.
 *   - `anchorChartX`   — the anchor's pixel in CHART-LOCAL coords
 *                        (i.e. `scrollLeft + screenX`). For Ctrl+wheel this is
 *                        `scrollLeft + e.offsetX`; for the toolbar buttons it
 *                        is `scrollLeft + viewportWidth/2`.
 *   - `anchorScreenX`  — where the anchor should stay in VIEWPORT-LOCAL coords
 *                        (e.g. `e.offsetX` for wheel, `viewportWidth/2` for the
 *                        toolbar buttons).
 *
 * The anchor DATE is derived from `anchorChartX` at the OLD zoom, then we ask
 * where that date lands at the NEW zoom and shift scrollLeft so it coincides
 * with `anchorScreenX`. scrollLeft is clamped to ≥ 0.
 */
export function computeZoomAround(
  originDate: string,
  currentZoom: ZoomLevel,
  nextZoom: ZoomLevel,
  anchorChartX: number,
  anchorScreenX: number,
): ZoomAnchorResult {
  if (nextZoom === currentZoom) {
    // No zoom change (boundary) — leave scrollLeft to the caller's current value.
    return { zoom: currentZoom, scrollLeft: 0 };
  }
  // The date under the anchor at the OLD zoom.
  const anchorDate = pixelToDate(anchorChartX, originDate, currentZoom);
  // Where that date's left edge lands at the NEW zoom (chart-local).
  const anchorPxNew = dateToPixel(anchorDate, originDate, nextZoom);
  // Shift so the anchor date stays at the same viewport-local position.
  const scrollLeft = Math.max(0, anchorPxNew - anchorScreenX);
  return { zoom: nextZoom, scrollLeft };
}
