/**
 * Task-bar hover tooltip (editor-interaction-optimization-plan §3.2).
 *
 * Shows a DOM tooltip when the pointer is over a task bar — leaf, summary or
 * milestone. The tooltip lists WBS, name, assignees, dates, duration, progress,
 * predecessor/successor counts, and (when a baseline is active) the baseline
 * deviation, merged into ONE tooltip so it never overlaps the baseline hover.
 *
 * Arbitration (plan §3.2): the host calls `hitTask(x, y)` first. When it
 * returns true the task tooltip wins and the baseline + holiday tooltips are
 * suppressed (the task tooltip already includes the baseline deviation).
 *
 * The hit-test here is READ-ONLY: it must never produce an editable hit (no
 * drag/resize). The interactive `hitTest` in `engine/interaction` continues to
 * handle drags on the live bar, and deliberately returns `empty` for summary
 * rows — this hook hit-tests summaries independently so they get a tooltip and
 * right-click menu without becoming draggable.
 *
 * A ~300ms delay (plan §3.2) avoids flicker on quick pointer sweeps; moving
 * away or leaving the canvas clears any pending tooltip immediately.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Scene, TaskRow } from '@/engine/render/types';
import { hitTaskBar } from '@/lib/taskHoverHit';

const MINUS = '\u2212';
/** Hover delay before the tooltip appears (plan §3.2 ≈ 300ms). */
const HOVER_DELAY_MS = 300;

interface HoverState {
  row: TaskRow;
  x: number;
  y: number;
}

export interface UseTaskHoverOptions {
  /** Read the latest scene. Returns null before first render. */
  getScene: () => Scene | null;
  viewportWidth: number;
}

export interface UseTaskHoverResult {
  onHoverMove(x: number, y: number): void;
  clearHover(): void;
  tooltip: ReactNode;
  /** True when (x,y) is over a task bar (leaf/summary/milestone). Drives arbitration. */
  hitTask(x: number, y: number): boolean;
  /** The task id under the pointer (if any). Used by the context-menu path. */
  hitTaskId(x: number, y: number): string | null;
}

export function useTaskHover(opts: UseTaskHoverOptions): UseTaskHoverResult {
  const { t } = useTranslation();
  const [hover, setHover] = useState<HoverState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Read-only bar hit test (covers leaf + summary + milestone). */
  const hitRow = useCallback(
    (x: number, y: number): TaskRow | null => {
      const scene = opts.getScene();
      return scene ? hitTaskBar(scene, x, y) : null;
    },
    [opts],
  );

  const hitTask = useCallback((x: number, y: number): boolean => hitRow(x, y) !== null, [hitRow]);

  const hitTaskId = useCallback(
    (x: number, y: number): string | null => hitRow(x, y)?.id ?? null,
    [hitRow],
  );

  const clearHover = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHover(null);
  }, []);

  const onHoverMove = useCallback(
    (x: number, y: number) => {
      const row = hitRow(x, y);
      if (!row) {
        clearHover();
        return;
      }
      // Reset the delay timer on each move to a new task; moving within the
      // same row just updates the position once the tooltip is shown.
      const sameRow = hover?.row.id === row.id;
      if (sameRow && hover) {
        // Already showing this task — update position without re-arming delay.
        setHover((prev) =>
          prev && prev.x === x && prev.y === y ? prev : { row: prev!.row, x, y },
        );
        return;
      }
      // New task: arm the delay. Clear any prior pending timer first.
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setHover({ row, x, y });
      }, HOVER_DELAY_MS);
    },
    [hitRow, clearHover, hover],
  );

  // Clear any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const tooltip: ReactNode =
    hover !== null ? (
      <TaskTooltip
        row={hover.row}
        x={hover.x}
        y={hover.y}
        viewportWidth={opts.viewportWidth}
        t={t}
      />
    ) : null;

  return { onHoverMove, clearHover, tooltip, hitTask, hitTaskId };
}

function TaskTooltip({
  row,
  x,
  y,
  viewportWidth,
  t,
}: {
  row: TaskRow;
  x: number;
  y: number;
  viewportWidth: number;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const assignees = row.assignees ?? [];
  const duration = row.isMilestone ? 0 : row.duration;

  // Constraint human-readable text.
  let constraintText: string | null = null;
  if (row.constraint) {
    const date = row.constraint.date;
    switch (row.constraint.type) {
      case 'startNoEarlierThan':
        constraintText = t('canvas.constraintStartNoEarlierThan', { date });
        break;
      case 'mustStartOn':
        constraintText = t('canvas.constraintMustStartOn', { date });
        break;
      case 'mustFinishOn':
        constraintText = t('canvas.constraintMustFinishOn', { date });
        break;
      case 'finishNoLaterThan':
        constraintText = t('canvas.constraintFinishNoLaterThan', { date });
        break;
      default:
        constraintText = null;
    }
  }

  // Baseline deviation (merged — plan §3.2): show only when a baseline is on.
  let deviationText: string | null = null;
  if (row.baselineVariance) {
    const v = row.baselineVariance;
    if (v.status === 'added') {
      deviationText = t('baseline.deviationAdded');
    } else {
      const d = v.finishDelta;
      deviationText = d > 0 ? `+${d} 工作日` : d < 0 ? `${MINUS}${Math.abs(d)} 工作日` : '0';
    }
  }

  // Tooltip width budget for edge clamping (matches the rendered min-width).
  const widthBudget = 240;

  return (
    <div
      role="tooltip"
      data-gantt-task-tooltip
      className="pointer-events-none absolute z-40 min-w-[200px] max-w-[260px] rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-xs text-fg shadow-lg"
      style={{
        left: Math.min(x + 12, Math.max(4, viewportWidth - widthBudget)),
        top: Math.max(y - 64, 4),
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        {row.wbsNumber && (
          <span className="shrink-0 tabular-nums text-fg-muted">{row.wbsNumber}</span>
        )}
        <span className="truncate font-medium">{row.name || t('table.placeholderName')}</span>
      </div>
      <table className="mt-1 border-collapse">
        <tbody>
          <tr>
            <td className="pr-3 align-top text-fg-muted">{t('canvas.tooltipAssignees')}</td>
            <td className="tabular-nums">
              {assignees.length === 0 ? (
                <span className="text-fg-muted">{t('canvas.tooltipNoAssignee')}</span>
              ) : (
                assignees.map((a) => `${a.name} (${a.load}%)`).join('、')
              )}
            </td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('canvas.tooltipDateRange')}</td>
            <td className="tabular-nums">
              {row.start.slice(5)} → {row.end.slice(5)}
            </td>
          </tr>
          {duration !== null && (
            <tr>
              <td className="pr-3 text-fg-muted">{t('canvas.tooltipDuration')}</td>
              <td className="tabular-nums">
                {row.isMilestone ? '—' : t('canvas.durationDays', { count: duration })}
              </td>
            </tr>
          )}
          <tr>
            <td className="pr-3 text-fg-muted">{t('canvas.tooltipProgress')}</td>
            <td className="tabular-nums">{row.progress}%</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('canvas.tooltipPredecessors')}</td>
            <td className="tabular-nums">{row.predecessorCount ?? 0}</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('canvas.tooltipSuccessors')}</td>
            <td className="tabular-nums">{row.successorCount ?? 0}</td>
          </tr>
          {constraintText && (
            <tr>
              <td className="pr-3 align-top text-fg-muted">{t('canvas.tooltipConstraint')}</td>
              <td
                className={row.hasConstraintConflict ? 'font-medium text-danger' : 'tabular-nums'}
              >
                {constraintText}
                {row.hasConstraintConflict && (
                  <span className="ml-1 text-danger">
                    ({t('canvas.tooltipConstraintConflict')})
                  </span>
                )}
              </td>
            </tr>
          )}
          {deviationText !== null && (
            <tr>
              <td className="pr-3 text-fg-muted">{t('canvas.tooltipBaselineDeviation')}</td>
              <td className="tabular-nums font-medium">{deviationText}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
