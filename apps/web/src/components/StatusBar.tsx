/**
 * Status bar — shows save state and undo/redo availability (PRD §3.8).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/store/useProjectStore';
import { totalPersonDays } from '@/lib/cost';
import { resolveCalendar } from '@/lib/calendar';

export function StatusBar() {
  const { t } = useTranslation();
  const saveState = useProjectStore((s) => s.saveState);
  const file = useProjectStore((s) => s.file);
  const taskCount = file.tasks.length;
  const showCriticalPath = file.viewState.showCriticalPath;

  // Total person-days across all leaf tasks. Normal working days plus explicit
  // task overtime dates contribute effort; unmarked rest days do not.
  const personDays = useMemo(
    () => totalPersonDays(file.tasks, file.resources, resolveCalendar(file.calendar)),
    [file.tasks, file.resources, file.calendar],
  );

  const saveLabel =
    saveState.status === 'saving'
      ? t('status.saving')
      : saveState.status === 'error'
        ? `${t('errors.saveFailed')}: ${saveState.error}`
        : t('status.saved');

  return (
    <div className="flex items-center justify-between border-t border-border bg-bg-elevated px-3 py-1 text-xs text-fg-muted">
      <div>
        {taskCount} {t('status.tasks')}
        {personDays > 0 ? ` · ${personDays} ${t('status.personDays')}` : ''}
        {showCriticalPath ? ` · ${t('status.criticalPathLabel')}` : ''}
      </div>
      <div className={saveState.status === 'error' ? 'text-danger' : ''}>{saveLabel}</div>
    </div>
  );
}
