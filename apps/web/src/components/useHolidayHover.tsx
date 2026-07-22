/**
 * Shared holiday hover tooltip (PRD §3.5, §7.3).
 *
 * Both the task view (GanttCanvas) and the resource view (ResourceLoadCanvas)
 * render the same grid background — including holiday stripes (via the shared
 * `renderGrid`). But the hover *tooltip* lives in the React host layer, and
 * historically only GanttCanvas implemented it. Extracting it here means both
 * views get the tooltip from one place, so the two panes stay aligned without
 * the host components having to mirror each other's pointer logic.
 *
 * Only holidays (`type === 'holiday'`) get a tooltip — make-up working days
 * (`type === 'working'`) render as normal columns with no tooltip, matching
 * PRD §3.5 ("调休工作日不高亮").
 */
import { useCallback, useState, type ReactNode } from 'react';
import { pixelToDate } from '@/engine/layout';
import type { ZoomLevel, Holiday } from '@ganttly/schema';

/** Fields the hook needs from whichever scene the host is rendering. */
export interface HolidayHoverSceneFields {
  scrollLeft: number;
  originDate: string;
  zoom: ZoomLevel;
  holidays: Holiday[];
}

export interface UseHolidayHoverOptions {
  /** Read the latest scene's shared fields. Returns null when no scene yet. */
  getSceneFields: () => HolidayHoverSceneFields | null;
  /** Viewport width in CSS px, used to clamp the tooltip inside the pane. */
  viewportWidth: number;
}

export interface UseHolidayHoverResult {
  /** Call on pointer-move while idle (not dragging/panning). O(visible holidays). */
  onHoverMove: (x: number, y: number) => void;
  /** Call on pointer-leave to dismiss the tooltip. */
  clearHover: () => void;
  /** Render this node inside the host's positioned wrapper; null when idle. */
  tooltip: ReactNode;
}

export function useHolidayHover(opts: UseHolidayHoverOptions): UseHolidayHoverResult {
  const [hover, setHover] = useState<{ holiday: Holiday; x: number; y: number } | null>(null);

  const onHoverMove = useCallback(
    (x: number, y: number) => {
      const fields = opts.getSceneFields();
      if (!fields) return;
      // Convert viewport x → chart-local x → ISO date at the cursor.
      const chartX = x + fields.scrollLeft;
      const iso = pixelToDate(chartX, fields.originDate, fields.zoom);
      const found = fields.holidays.find((h) => h.date === iso && h.type === 'holiday');
      if (found) {
        setHover((prev) =>
          prev?.holiday.date === found.date && prev?.x === x && prev?.y === y
            ? prev
            : { holiday: found, x, y },
        );
      } else if (hover !== null) {
        setHover(null);
      }
    },
    [opts, hover],
  );

  const clearHover = useCallback(() => {
    setHover(null);
  }, []);

  const tooltip: ReactNode =
    hover === null ? null : (
      <div
        role="tooltip"
        data-gantt-holiday-tooltip
        className="pointer-events-none absolute z-40 rounded border border-border bg-bg-elevated px-2 py-1 text-xs text-fg shadow-lg"
        style={{
          left: Math.min(hover.x + 12, opts.viewportWidth - 120),
          top: Math.max(hover.y - 28, 4),
        }}
      >
        {hover.holiday.name}
        <span className="ml-1 text-fg-muted">({hover.holiday.date})</span>
      </div>
    );

  return { onHoverMove, clearHover, tooltip };
}
