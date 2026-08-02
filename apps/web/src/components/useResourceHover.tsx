/**
 * Resource-view hover tooltip (editor-interaction-optimization-plan §3.5).
 *
 * Shows a DOM tooltip when the pointer is over a daily load bar (resource-day)
 * or a drilled-down task lane. The two variants report:
 *
 *  - resource-day: resource name, date, actual load %, capacity %, overload
 *    status (with an explicit number, not just color — plan §5.3), and the list
 *    of contributing tasks each with its own load %.
 *  - task-lane:   task name + WBS, date range, this resource's load %, person-
 *    days, progress, and overload status.
 *
 * Arbitration (plan §3.5): the host calls `hitResource(x, y)` first; when it
 * returns non-empty the resource tooltip wins and the holiday tooltip is
 * suppressed. Priority is resource load/task-lane > holiday.
 *
 * A ~300ms delay (plan §3.2 consistency) avoids flicker; moving away or leaving
 * the canvas clears any pending tooltip immediately. Mirrors `useTaskHover`.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ResourceScene,
  ResourceHit,
  ResourceLoadBar,
  ResourceTaskRow,
} from '@/engine/render/types';
import { hitResource } from '@/lib/resourceHoverHit';

/** Hover delay before the tooltip appears (consistent with useTaskHover). */
const HOVER_DELAY_MS = 300;

type HoverTarget =
  | {
      kind: 'resource-day';
      resourceId: string;
      bar: ResourceLoadBar;
    }
  | { kind: 'task-lane'; row: ResourceTaskRow };

interface HoverState {
  target: HoverTarget;
  x: number;
  y: number;
}

export interface UseResourceHoverOptions {
  /** Read the latest scene. Returns null before first render. */
  getScene: () => ResourceScene | null;
  viewportWidth: number;
}

export interface UseResourceHoverResult {
  onHoverMove(x: number, y: number): void;
  clearHover(): void;
  tooltip: ReactNode;
  /** Resolve the hit under (x,y). Drives hover/click arbitration in the host. */
  hitResourceAt(x: number, y: number): ResourceHit;
}

export function useResourceHover(opts: UseResourceHoverOptions): UseResourceHoverResult {
  const { t } = useTranslation();
  const [hover, setHover] = useState<HoverState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolveHit = useCallback(
    (x: number, y: number): ResourceHit => {
      const scene = opts.getScene();
      return scene ? hitResource(scene, x, y) : { kind: 'empty' };
    },
    [opts],
  );

  const hitResourceAt = useCallback((x: number, y: number) => resolveHit(x, y), [resolveHit]);

  const clearHover = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHover(null);
  }, []);

  const onHoverMove = useCallback(
    (x: number, y: number) => {
      const hit = resolveHit(x, y);
      if (hit.kind === 'empty') {
        clearHover();
        return;
      }
      // Build the hover target from the hit. For a task-lane we must resolve the
      // lane row from the scene (the hit only carries ids); if it can't be found
      // (scene updated mid-move), treat as empty.
      let target: HoverTarget;
      if (hit.kind === 'resource-day') {
        target = { kind: 'resource-day', resourceId: hit.resourceId, bar: hit.bar };
      } else {
        const row = findTaskLaneRow(opts.getScene(), hit.resourceId, hit.taskId);
        if (!row) {
          clearHover();
          return;
        }
        target = { kind: 'task-lane', row };
      }

      // Moving within the same target updates position without re-arming delay.
      const sameTarget =
        (hover?.target.kind === 'resource-day' &&
          target.kind === 'resource-day' &&
          hover.target.bar.date === target.bar.date &&
          hover.target.resourceId === target.resourceId) ||
        (hover?.target.kind === 'task-lane' &&
          target.kind === 'task-lane' &&
          hover.target.row.taskId === target.row.taskId);
      if (sameTarget && hover) {
        setHover((prev) =>
          prev && prev.x === x && prev.y === y ? prev : { target: prev!.target, x, y },
        );
        return;
      }

      // New target: arm the delay. Clear any prior pending timer first.
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setHover({ target, x, y });
      }, HOVER_DELAY_MS);
    },
    [resolveHit, clearHover, hover, opts],
  );

  // Clear any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const scene = opts.getScene();
  const tooltip: ReactNode =
    hover !== null && scene ? (
      <ResourceTooltip
        target={hover.target}
        scene={scene}
        x={hover.x}
        y={hover.y}
        viewportWidth={opts.viewportWidth}
        t={t}
      />
    ) : null;

  return { onHoverMove, clearHover, tooltip, hitResourceAt };
}

/** Look up the task-lane row in the scene for a (resourceId, taskId) hit. */
function findTaskLaneRow(
  scene: ResourceScene | null,
  resourceId: string,
  taskId: string,
): ResourceTaskRow | null {
  if (!scene) return null;
  return (
    scene.rows.find(
      (r): r is ResourceTaskRow =>
        r.kind === 'task' && r.resourceId === resourceId && r.taskId === taskId,
    ) ?? null
  );
}

function ResourceTooltip({
  target,
  scene,
  x,
  y,
  viewportWidth,
  t,
}: {
  target: HoverTarget;
  scene: ResourceScene;
  x: number;
  y: number;
  viewportWidth: number;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const widthBudget = 248;
  const left = Math.min(x + 12, Math.max(4, viewportWidth - widthBudget));
  const top = Math.max(y - 64, 4);

  if (target.kind === 'resource-day') {
    return (
      <ResourceDayTooltip
        resourceId={target.resourceId}
        bar={target.bar}
        scene={scene}
        left={left}
        top={top}
        t={t}
      />
    );
  }
  return <TaskLaneTooltip row={target.row} scene={scene} left={left} top={top} t={t} />;
}

/** resource-day tooltip: load, capacity, overload status + contributing tasks. */
function ResourceDayTooltip({
  resourceId,
  bar,
  scene,
  left,
  top,
  t,
}: {
  resourceId: string;
  bar: ResourceLoadBar;
  scene: ResourceScene;
  left: number;
  top: number;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resource = scene.resourceById.get(resourceId);
  const name = resource?.name ?? '';
  const role = resource?.role;
  const capacityPct = Math.round((resource?.capacity ?? 1) * 100);
  const overload = bar.load > 100 * (resource?.capacity ?? 1);
  const contributions = bar.contributions ?? [];

  return (
    <div
      role="tooltip"
      data-gantt-resource-tooltip
      className="pointer-events-none absolute z-40 min-w-[200px] max-w-[260px] rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-xs text-fg shadow-lg"
      style={{ left, top }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{name || t('resource.placeholderName')}</span>
        {role && <span className="shrink-0 text-fg-muted">{role}</span>}
      </div>
      <table className="mt-1 border-collapse">
        <tbody>
          <tr>
            <td className="pr-3 text-fg-muted">{t('resource.tooltipDate')}</td>
            <td className="tabular-nums">{bar.date}</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('resource.tooltipLoad')}</td>
            <td className="tabular-nums font-medium">{Math.round(bar.load)}%</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('resource.tooltipCapacity')}</td>
            <td className="tabular-nums">{capacityPct}%</td>
          </tr>
          <tr>
            <td className="pr-3 align-top text-fg-muted">{t('resource.tooltipStatus')}</td>
            <td className={overload ? 'font-medium text-danger' : 'font-medium text-taskBar'}>
              {overload
                ? t('resource.tooltipOverload', { excess: Math.round(bar.load - capacityPct) })
                : t('resource.tooltipWithinCapacity')}
            </td>
          </tr>
          {contributions.length > 0 && (
            <tr>
              <td className="pr-3 align-top text-fg-muted">{t('resource.tooltipContributing')}</td>
              <td className="tabular-nums">
                <ul className="space-y-0.5">
                  {contributions.map((c) => (
                    <li key={c.taskId} className="flex justify-between gap-2">
                      <span className="truncate">{c.name || t('table.placeholderName')}</span>
                      <span className="shrink-0 text-fg-muted">{Math.round(c.load)}%</span>
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** task-lane tooltip: task name/WBS, dates, load %, person-days, progress. */
function TaskLaneTooltip({
  row,
  scene,
  left,
  top,
  t,
}: {
  row: ResourceTaskRow;
  scene: ResourceScene;
  left: number;
  top: number;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resource = scene.resourceById.get(row.resourceId);
  const capacity = resource?.capacity ?? row.capacity;
  const overload = row.load > 100 * capacity;
  // Person-days for this resource on this task:
  // (load/100) × capacity × working-days. duration is already working days.
  const personDays = row.isMilestone
    ? 0
    : Math.round((row.load / 100) * capacity * row.duration * 100) / 100;

  return (
    <div
      role="tooltip"
      data-gantt-resource-tooltip
      className="pointer-events-none absolute z-40 min-w-[200px] max-w-[260px] rounded-lg border border-border bg-bg-elevated px-2.5 py-2 text-xs text-fg shadow-lg"
      style={{ left, top }}
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
            <td className="pr-3 text-fg-muted">{t('resource.tooltipResource')}</td>
            <td className="truncate">{resource?.name ?? ''}</td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('canvas.tooltipDateRange')}</td>
            <td className="tabular-nums">
              {row.start.slice(5)} → {row.end.slice(5)}
            </td>
          </tr>
          <tr>
            <td className="pr-3 text-fg-muted">{t('resource.tooltipLoad')}</td>
            <td className="tabular-nums">
              {Math.round(row.load)}%
              {overload && (
                <span className="ml-1 font-medium text-danger">
                  ({t('resource.tooltipOverloadShort')})
                </span>
              )}
            </td>
          </tr>
          {!row.isMilestone && (
            <tr>
              <td className="pr-3 text-fg-muted">{t('resource.tooltipPersonDays')}</td>
              <td className="tabular-nums">{personDays}</td>
            </tr>
          )}
          <tr>
            <td className="pr-3 text-fg-muted">{t('canvas.tooltipProgress')}</td>
            <td className="tabular-nums">{row.progress}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
