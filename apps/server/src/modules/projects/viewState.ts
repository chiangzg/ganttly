/**
 * viewState separation (spec §5.2).
 *
 * On import and PUT the server ignores the client-submitted `viewState` and
 * substitutes the canonical neutral default, so scrolling, selecting, or
 * collapsing rows never advances the remote revision. The web client overlays
 * its own per-device view state on top after loading (PR4).
 */
import { DEFAULT_VIEW_STATE, type GanttlyFile } from '@ganttly/schema';

/** Return a copy of `file` whose viewState is the neutral remote default. */
export function withDefaultViewState(file: GanttlyFile): GanttlyFile {
  return {
    ...file,
    viewState: {
      ...DEFAULT_VIEW_STATE,
      collapsedTaskIds: [...DEFAULT_VIEW_STATE.collapsedTaskIds],
    },
  };
}
