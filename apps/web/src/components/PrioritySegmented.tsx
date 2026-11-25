/**
 * Priority radio group for the task drawer (priority-matrix spec §3.1).
 *
 * Five segmented buttons — 未分级 / P1 / P2 / P3 / P4 — built from `<button>`s
 * on purpose: adding `<input type="radio">` would shift the positional
 * selectors that existing drawer e2e tests rely on (`drawer.locator('input')
 * .first()` is the name field).
 *
 * Controlled and stateless: the drawer owns the draft, this only reports picks.
 * It must NOT be wrapped in a `<label>` (the drawer's `Field` is one) — a click
 * on the label text would then activate the first button and silently reset the
 * priority to "not triaged".
 */
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { PRIORITY_TAG, PRIORITY_TAG_CLASS, TASK_PRIORITIES } from '@/lib/priority';
import type { TaskPriority } from '@ganttly/schema';

export interface PrioritySegmentedProps {
  value: TaskPriority | undefined;
  onChange: (next: TaskPriority | undefined) => void;
}

const SEGMENT_CLASS =
  'h-7 min-w-0 border-r border-border text-xs outline-none transition-colors last:border-r-0 ' +
  'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';

export function PrioritySegmented({ value, onChange }: PrioritySegmentedProps) {
  const { t } = useTranslation();
  const pick = (next: TaskPriority | undefined) => {
    // Radio semantics: re-picking the checked option reports nothing, so the
    // drawer never sees a "change" that is not one.
    if (next !== value) onChange(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label={t('priority.label')}
      data-testid="priority-segmented"
      className="flex overflow-hidden rounded-md border border-border bg-bg"
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === undefined}
        data-priority="none"
        onClick={() => pick(undefined)}
        className={cn(
          SEGMENT_CLASS,
          // "未分级" is three characters wide — give it more room than the P-tags.
          'flex-[1.6]',
          value === undefined
            ? 'bg-fg-muted/15 font-bold text-fg'
            : 'font-medium text-fg-muted hover:bg-bg-elevated hover:text-fg',
        )}
      >
        {t('priority.none')}
      </button>
      {TASK_PRIORITIES.map((priority) => {
        const checked = value === priority;
        return (
          <button
            key={priority}
            type="button"
            role="radio"
            aria-checked={checked}
            data-priority={priority}
            onClick={() => pick(priority)}
            className={cn(
              SEGMENT_CLASS,
              'flex-1',
              checked
                ? cn('font-bold', PRIORITY_TAG_CLASS[priority])
                : 'font-medium text-fg-muted hover:bg-bg-elevated hover:text-fg',
            )}
          >
            {PRIORITY_TAG[priority]}
          </button>
        );
      })}
    </div>
  );
}
