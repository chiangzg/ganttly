/**
 * Baseline hover tooltip (baseline-comparison spec §5.10, §6.7).
 *
 * Shows a DOM tooltip when the pointer is over a live bar OR a baseline
 * reference track in comparison mode. The tooltip lists the baseline name,
 * the planned vs. current date range, and the finish deviation.
 *
 * Arbitration with the holiday hover (spec §5.10): the host calls `hitBaseline`
 * first — when it returns true, the holiday tooltip is suppressed so the task
 * tooltip wins. Only empty time columns fall through to the holiday tooltip.
 *
 * The hit-test here is READ-ONLY: it must never produce an editable hit (no
 * drag/resize). The interactive `hitTest` in `engine/interaction` continues to
 * handle drags on the live bar.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Scene, TaskRow } from '@/engine/render/types';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  dateToPixel,
  dateRangeWidth,
  pixelsPerDay,
} from '@/engine/layout';

const MINUS = '\u2212';

interface HoverState {
  row: TaskRow;
  x: number;
  y: number;
}

export interface UseBaselineHoverOptions {
  /** Read the latest scene. Returns null before first render. */
  getScene: () => Scene | null;
  viewportWidth: number;
  /** Active baseline name, for the tooltip header. */
  activeBaselineName: string | null;
}

export interface UseBaselineHoverResult {
  onHoverMove(x: number, y: number): void;
  clearHover(): void;
  tooltip: ReactNode;
  /** True when (x,y) is over a live bar or baseline track. Drives arbitration. */
  hitBaseline(x: number, y: number): boolean;
}

export function useBaselineHover(opts: UseBaselineHoverOptions): UseBaselineHoverResult {
  const [hover, setHover] = useState<HoverState | null>(null);

  const rowAt = useCallback(
    (y: number): TaskRow | null => {
      const scene = opts.getScene();
      if (!scene || !scene.hasActiveBaseline) return null;
      if (y < HEADER_HEIGHT) return null;
      const rowIdx = Math.floor((y - HEADER_HEIGHT + scene.scrollTop) / ROW_HEIGHT);
      return scene.rows.find((r) => r.yIndex === rowIdx) ?? null;
    },
    [opts],
  );

  /**
   * Does the pointer fall within the live bar OR the baseline track X-range?
   * The baseline track lives in the lower part of the row; the live bar in the
   * upper part. We accept either band so hovering either shows the tooltip.
   */
  const hitBaseline = useCallback(
    (x: number, y: number): boolean => {
      const scene = opts.getScene();
      const row = rowAt(y);
      if (!scene || !row) return false;
      const chartX = x + scene.scrollLeft;
      const liveX = dateToPixel(row.start, scene.originDate, scene.zoom);
      const liveW = Math.max(
        dateRangeWidth(row.start, row.end, scene.zoom),
        pixelsPerDay(scene.zoom) / 2,
      );
      // Live bar band: roughly the upper ~60% of the row.
      const rowTop = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
      const inLiveY = y >= rowTop + 3 && y <= rowTop + ROW_HEIGHT - 3;
      if (inLiveY && chartX >= liveX - 2 && chartX <= liveX + liveW + 2) return true;
      // Baseline track band: lower part of the row, only if a snapshot exists.
      if (row.baseline) {
        const blX = dateToPixel(row.baseline.start, scene.originDate, scene.zoom);
        const blW = Math.max(
          dateRangeWidth(row.baseline.start, row.baseline.end, scene.zoom),
          pixelsPerDay(scene.zoom) / 2,
        );
        const inBaselineY = y >= rowTop + ROW_HEIGHT - 12 && y <= rowTop + ROW_HEIGHT - 2;
        if (inBaselineY && chartX >= blX - 2 && chartX <= blX + blW + 2) return true;
      }
      return false;
    },
    [opts, rowAt],
  );

  const onHoverMove = useCallback(
    (x: number, y: number) => {
      if (!hitBaseline(x, y)) {
        if (hover !== null) setHover(null);
        return;
      }
      const row = rowAt(y)!;
      setHover((prev) =>
        prev?.row.id === row.id && prev.x === x && prev.y === y ? prev : { row, x, y },
      );
    },
    [hitBaseline, rowAt, hover],
  );

  const clearHover = useCallback(() => setHover(null), []);

  const tooltip: ReactNode =
    hover !== null ? (
      <BaselineTooltip
        row={hover.row}
        x={hover.x}
        y={hover.y}
        viewportWidth={opts.viewportWidth}
        baselineName={opts.activeBaselineName}
      />
    ) : null;

  return { onHoverMove, clearHover, tooltip, hitBaseline };
}

function BaselineTooltip({
  row,
  x,
  y,
  viewportWidth,
  baselineName,
}: {
  row: TaskRow;
  x: number;
  y: number;
  viewportWidth: number;
  baselineName: string | null;
}) {
  const { t } = useTranslation();
  // Deviation text from the row's variance (single source of truth).
  let finishDeltaText = '—';
  if (row.baselineVariance) {
    const v = row.baselineVariance;
    if (v.status === 'added') {
      finishDeltaText = t('baseline.addedTask');
    } else {
      finishDeltaText =
        v.finishDelta > 0
          ? t('baseline.deltaWorkDays', { n: `+${v.finishDelta}` })
          : v.finishDelta < 0
            ? t('baseline.deltaWorkDays', { n: `${MINUS}${Math.abs(v.finishDelta)}` })
            : '0';
    }
  }

  const blRange =
    row.baseline !== undefined
      ? `${row.baseline.start.slice(5)} → ${row.baseline.end.slice(5)}`
      : '—';

  return (
    <div
      role="tooltip"
      data-gantt-baseline-tooltip
      className="pointer-events-none absolute z-40 min-w-[180px] rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-xs text-fg shadow-lg"
      style={{
        left: Math.min(x + 12, viewportWidth - 210),
        top: Math.max(y - 64, 4),
      }}
    >
      {baselineName ? (
        <div className="font-medium">{t('toolbar.baselineWithName', { name: baselineName })}</div>
      ) : null}
      <table className="mt-1 border-collapse">
        <tbody>
          <tr>
            <td className="pr-3 text-fg-muted">{t('baseline.planLabel')}</td>
            <td className="tabular-nums">{blRange}</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('baseline.currentLabel')}</td>
            <td className="tabular-nums">{`${row.start.slice(5)} → ${row.end.slice(5)}`}</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('baseline.varianceFinish')}</td>
            <td className="tabular-nums font-medium">{finishDeltaText}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
