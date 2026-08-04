/**
 * "Fit project range" timeline navigation (editor-interaction-optimization-plan §4.5).
 *
 * The editor previously had only discrete zoom + a "Today" jump. There was no
 * way to frame the whole project in the viewport. This module computes the
 * zoom level + scrollLeft that make every visible task fit, then commits it
 * as NAVIGATION (non-undoable), exactly like `revealTask` / `jumpToToday`.
 *
 * Strategy (confirmed with the user): COARSEST-THAT-FITS — pick the widest
 * zoom whose rendered project width still fits the viewport (with a small
 * margin), so a 3-month project lands on `week` and a 2-year project on
 * `year`. Simple, predictable, never overflows.
 *
 * The pure core is split out so it can be unit-tested without a DOM/store,
 * mirroring `revealTask.ts`.
 */
import type { GanttlyFile, ZoomLevel, Baseline } from '@ganttly/schema';
import { ZOOM_ORDER, dateRangeWidth } from '@/engine/layout';
import { chartEndDate, originDateFor } from '@/engine/scene';
import { useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { findActiveBaseline } from '@/lib/baseline';
import { todayISO } from '@/engine/layout';

/** Margin (CSS px) kept on each side after fitting, so tasks aren't flush to the edges. */
const FIT_MARGIN_PX = 24;

export interface FitViewport {
  /** Chart canvas width (CSS px) — the `[data-gantt-chart]` element. */
  width: number;
}

export interface FitResult {
  /** The zoom level that fits the project range. */
  zoom: ZoomLevel;
  /** scrollLeft so the earliest task sits at the left edge (≥ 0). */
  scrollLeft: number;
}

/**
 * Pure core: compute the `{ zoom, scrollLeft }` that frames the whole project.
 * Returns `null` when there are no tasks (nothing to fit).
 *
 * Uses the SAME origin the renderer uses (`originDateFor`, including the
 * active baseline) and the SAME end (`chartEndDate`), so the fit aligns with
 * what the user actually sees — never `file.tasks[0]?.start` (that diverged
 * from the renderer and landed the Today button on the wrong column; see
 * Toolbar.tsx:70-73).
 */
export function computeFitProjectRange(
  file: GanttlyFile,
  viewport: FitViewport,
  opts?: { activeBaseline?: Baseline | null },
): FitResult | null {
  if (file.tasks.length === 0) return null;

  const activeBaseline = opts?.activeBaseline ?? null;
  const origin = originDateFor(file, { activeBaseline });
  const end = chartEndDate(file, todayISO(), activeBaseline);
  const availableWidth = Math.max(0, viewport.width - FIT_MARGIN_PX * 2);

  // COARSEST-THAT-FITS: ZOOM_ORDER is finest→coarsest, so iterate from the
  // coarsest end (year) back toward finer. The first (widest) level whose
  // rendered width fits is the winner — it leaves the most breathing room.
  let chosen: ZoomLevel = ZOOM_ORDER[ZOOM_ORDER.length - 1]!; // fallback: year
  for (let i = ZOOM_ORDER.length - 1; i >= 0; i--) {
    const zoom = ZOOM_ORDER[i]!;
    const width = dateRangeWidth(origin, end, zoom);
    if (width <= availableWidth) {
      chosen = zoom;
      break;
    }
  }

  // scrollLeft = 0 frames the origin (earliest task / project start) at the
  // left edge. We don't center because fit already frames the full range;
  // centering would clip the left task when the range is narrower than the
  // viewport.
  return { zoom: chosen, scrollLeft: 0 };
}

/**
 * Frame the whole project in the chart viewport by writing view state directly
 * to the project store (bypassing the Command/undo stack — plan §6.4 / §9.1).
 * Returns true when the project had tasks and the view was updated.
 *
 * Reads the chart viewport from the `[data-gantt-chart]` element so the fit
 * matches the actual canvas width, mirroring `jumpToToday` / `revealTask`.
 */
export function fitProjectRange(): boolean {
  const file = useProjectStore.getState().file;
  const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
  const viewport: FitViewport = { width: chartEl ? chartEl.clientWidth : 800 };

  const activeBaseline = findActiveBaseline(
    file.baselines,
    useViewStore.getState().activeBaselineId,
  );
  const result = computeFitProjectRange(file, viewport, { activeBaseline });
  if (!result) return false;

  // Direct setState — navigation, NOT an undoable edit (plan §6.4 / §9.1).
  useProjectStore.setState({
    file: {
      ...file,
      viewState: {
        ...file.viewState,
        zoom: result.zoom,
        scrollLeft: result.scrollLeft,
      },
    },
  });
  return true;
}
