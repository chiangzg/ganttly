/**
 * Inline `P1`–`P4` chip (priority-matrix spec §3.3).
 *
 * Used wherever a task's priority is shown as a mark: the task-tree name cell
 * and the context menu. The matrix cards do NOT use it — there the quadrant
 * itself is the signal, and a nested `title` would fight the card's own.
 */
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { PRIORITY_TAG, PRIORITY_TAG_CLASS } from '@/lib/priority';
import type { TaskPriority } from '@ganttly/schema';

export function PriorityTag({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  const { t } = useTranslation();
  const title = t(`priority.title${priority}`);
  return (
    <span
      data-testid="priority-tag"
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1 text-[10px] font-bold leading-4 tabular-nums',
        PRIORITY_TAG_CLASS[priority],
        className,
      )}
      title={t('priority.tagLabel', { tag: PRIORITY_TAG[priority], title })}
    >
      {PRIORITY_TAG[priority]}
    </span>
  );
}
