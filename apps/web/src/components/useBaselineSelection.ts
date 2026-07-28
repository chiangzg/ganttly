import { useCallback } from 'react';
import type { Baseline } from '@ganttly/schema';
import { useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { findActiveBaseline } from '@/lib/baseline';
import { originDateFor } from '@/engine/scene';
import { dateToPixel, pixelToDate } from '@/engine/layout';

/**
 * Select an active baseline while preserving the date at the viewport centre.
 *
 * Every activation path (menu, management dialog, create and delete) uses this
 * hook so a baseline that extends the chart origin cannot make the visible
 * dates jump. `nextBaselineOverride` supports a snapshot that has just been
 * created and is not present in the render-time file closure yet.
 */
export function useBaselineSelection(): (
  nextId: string | null,
  nextBaselineOverride?: Baseline | null,
) => void {
  const file = useProjectStore((state) => state.file);
  const activeBaselineId = useViewStore((state) => state.activeBaselineId);
  const setActiveBaselineId = useViewStore((state) => state.setActiveBaselineId);

  return useCallback(
    (nextId: string | null, nextBaselineOverride?: Baseline | null) => {
      const oldBaseline = findActiveBaseline(file.baselines, activeBaselineId);
      const nextBaseline =
        nextBaselineOverride !== undefined
          ? nextBaselineOverride
          : nextId
            ? findActiveBaseline(file.baselines, nextId)
            : null;
      const chart = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
      const viewportWidth = chart?.clientWidth || 800;
      const zoom = file.viewState.zoom;
      const oldOrigin = originDateFor(file, { activeBaseline: oldBaseline });
      const anchorDate = pixelToDate(
        file.viewState.scrollLeft + viewportWidth / 2,
        oldOrigin,
        zoom,
      );
      const newOrigin = originDateFor(file, { activeBaseline: nextBaseline });
      const nextScrollLeft = Math.max(
        0,
        dateToPixel(anchorDate, newOrigin, zoom) - viewportWidth / 2,
      );

      // Read the latest file so activation after create never overwrites the
      // baseline command that was dispatched earlier in the same event.
      const latest = useProjectStore.getState().file;
      if (latest.viewState.scrollLeft !== nextScrollLeft) {
        useProjectStore.setState({
          file: {
            ...latest,
            viewState: { ...latest.viewState, scrollLeft: nextScrollLeft },
          },
        });
      }
      setActiveBaselineId(nextId);
    },
    [activeBaselineId, file, setActiveBaselineId],
  );
}
