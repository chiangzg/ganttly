/**
 * One task card in the priority matrix (priority-matrix spec §5.3, §5.4).
 *
 * A compact single line: task-colour strip → milestone mark → WBS → name →
 * date hint → assignee avatars, with a 2px progress bar along the bottom edge.
 *
 * The card is stateless except for scrolling itself into view when it becomes
 * the selection anchor — the tree → card half of the selection sync (spec
 * §4.4). Every interaction is reported up to PriorityMatrix.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, TriangleAlert } from 'lucide-react';
import type { Resource, Task } from '@ganttly/schema';
import { resolveAssignees } from '@/lib/assigneeSummary';
import { darken } from '@/engine/render/color';
import { dueHint } from '@/lib/priorityMatrix';
import type { ResolvedCalendar } from '@/lib/calendar';
import { PRIORITY_TAG } from '@/lib/priority';
import { Avatar } from './ui/Avatar';
import { cn } from '@/lib/cn';

export interface PriorityCardProps {
  task: Task;
  wbsNumber: string;
  today: string;
  cal: ResolvedCalendar;
  resourceById: ReadonlyMap<string, Resource>;
  selected: boolean;
  /** The primary selection (Shift-range origin, the task the drawer edits). */
  anchor: boolean;
  dragging: boolean;
  /** Left-button press: selects (with the Ctrl/⌘/Shift modifiers). */
  onCardMouseDown: (task: Task, event: React.MouseEvent<HTMLDivElement>) => void;
  onCardDoubleClick: (task: Task) => void;
  onCardContextMenu: (task: Task, event: React.MouseEvent<HTMLDivElement>) => void;
  onCardKeyDown: (task: Task, event: React.KeyboardEvent<HTMLDivElement>) => void;
  onCardDragStart: (task: Task, event: React.DragEvent<HTMLDivElement>) => void;
  onCardDragEnd: () => void;
}

/** Native tooltip — the full picture a 28px card cannot show (spec §5.3). */
function cardTitle(
  t: ReturnType<typeof useTranslation>['t'],
  task: Task,
  wbsNumber: string,
  assignees: ReadonlyArray<{ id: string; name: string; load: number }>,
): string {
  const priority = task.priority
    ? t('priority.tagLabel', {
        tag: PRIORITY_TAG[task.priority],
        title: t(`priority.title${task.priority}`),
      })
    : t('priority.none');
  return [
    `${wbsNumber} ${task.name}`,
    `${t('canvas.tooltipPriority')}: ${priority}`,
    `${t('canvas.tooltipAssignees')}: ${
      assignees.length > 0
        ? assignees.map((a) => `${a.name} (${a.load}%)`).join('、')
        : t('canvas.tooltipNoAssignee')
    }`,
    `${t('canvas.tooltipDateRange')}: ${task.start} → ${task.end}`,
    `${t('canvas.tooltipProgress')}: ${task.progress}%`,
  ].join('\n');
}

export function PriorityCard({
  task,
  wbsNumber,
  today,
  cal,
  resourceById,
  selected,
  anchor,
  dragging,
  onCardMouseDown,
  onCardDoubleClick,
  onCardContextMenu,
  onCardKeyDown,
  onCardDragStart,
  onCardDragEnd,
}: PriorityCardProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  // Tree → card: when this card becomes the anchor (the user picked its row in
  // the task tree), make sure it is on screen. `nearest` never moves a card
  // that is already visible, so a plain click on a card causes no jump.
  useEffect(() => {
    if (anchor) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [anchor]);

  const assignees = resolveAssignees(task.assignments, resourceById);
  const title = cardTitle(t, task, wbsNumber, assignees);
  const done = task.progress >= 100;

  // Date hint (spec §2.2): a prompt only — it never decides the quadrant.
  const hint = dueHint(task, today, cal);
  const HintIcon = hint.kind === 'overdue' ? TriangleAlert : hint.kind === 'dueSoon' ? Clock : null;
  const hintText =
    hint.kind === 'overdue'
      ? t('priority.due.overdue', { count: hint.days })
      : hint.kind === 'dueSoon'
        ? hint.workingDays === 0
          ? t('priority.due.today')
          : t('priority.due.inDays', { count: hint.workingDays })
        : hint.kind === 'done'
          ? t('priority.due.done')
          : task.end.slice(5);
  const hintClass =
    hint.kind === 'overdue'
      ? 'font-medium text-danger'
      : hint.kind === 'dueSoon'
        ? 'font-medium text-warning'
        : 'text-fg-muted';

  // Same rule as the Canvas bar: a custom colour is darkened ×0.8 for the
  // progress fill; the default colour falls back to the theme token.
  const progressColor = task.color ? darken(task.color) : 'rgb(var(--color-task-progress))';
  const showProgress = !task.isMilestone && task.progress > 0;

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={`${wbsNumber} ${task.name}`}
      tabIndex={0}
      draggable
      data-matrix-task-id={task.id}
      title={title}
      onMouseDown={(event) => onCardMouseDown(task, event)}
      onDoubleClick={(event) => {
        // Modifier-double-click is ambiguous with multi-select (same rule as
        // the task tree): only a plain double-click opens the drawer.
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        onCardDoubleClick(task);
      }}
      onContextMenu={(event) => onCardContextMenu(task, event)}
      onKeyDown={(event) => onCardKeyDown(task, event)}
      onDragStart={(event) => onCardDragStart(task, event)}
      onDragEnd={onCardDragEnd}
      className={cn(
        'relative flex h-7 shrink-0 cursor-grab select-none items-center overflow-hidden rounded-md border border-border bg-bg-elevated text-xs outline-none transition-colors active:cursor-grabbing',
        // Hover changes the border colour only — never the layout (zero-shift).
        'hover:border-fg-muted/50 focus-visible:ring-2 focus-visible:ring-primary/40',
        selected && 'border-transparent bg-bg ring-1 ring-inset ring-primary/60',
        anchor && 'ring-2 ring-primary',
        dragging && 'opacity-40',
        done && 'opacity-55',
      )}
    >
      <span
        aria-hidden
        className="h-full w-[3px] shrink-0"
        style={{ background: task.color ?? 'rgb(var(--color-task-bar))' }}
      />
      {task.isMilestone && (
        <span aria-hidden className="ml-1.5 text-[10px] leading-none text-warning">
          ◆
        </span>
      )}
      <span
        className={cn(
          'shrink-0 text-[11px] leading-none tabular-nums text-fg-muted',
          !task.isMilestone && 'ml-1.5',
        )}
      >
        {wbsNumber}
      </span>
      <span className="min-w-0 flex-1 truncate pl-1.5 font-medium">{task.name}</span>
      <span
        className={cn('flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums', hintClass)}
      >
        {HintIcon && <HintIcon size={11} aria-hidden />}
        {hintText}
      </span>
      {assignees.length > 0 && (
        <span className="ml-1.5 flex shrink-0 items-center pl-1">
          {assignees.slice(0, 2).map((assignee) => (
            <Avatar
              key={assignee.id}
              name={assignee.name}
              className="-ml-1 h-[18px] w-[18px] text-[9px] ring-2 ring-bg-elevated first:ml-0"
            />
          ))}
          {assignees.length > 2 && (
            <span className="-ml-1 rounded-full bg-bg px-1 text-[9px] font-semibold leading-[18px] text-fg-muted">
              +{assignees.length - 2}
            </span>
          )}
        </span>
      )}
      {showProgress && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-border/70"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 h-0.5"
            style={{
              width: `${Math.min(100, Math.max(0, task.progress))}%`,
              background: progressColor,
            }}
          />
        </>
      )}
    </div>
  );
}
