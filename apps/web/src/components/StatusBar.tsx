/**
 * Status bar — shows save state and undo/redo availability (PRD §3.8).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/store/useProjectStore';
import { totalPersonDays } from '@/lib/cost';

export function StatusBar() {
  const { t } = useTranslation();
  const saveState = useProjectStore((s) => s.saveState);
  const file = useProjectStore((s) => s.file);
  const taskCount = file.tasks.length;
  const showCriticalPath = file.viewState.showCriticalPath;

  // Total person-days across all leaf tasks (P1 feature two). Recomputed only
  // when tasks/resources change, not on every render.
  const personDays = useMemo(
    () => totalPersonDays(file.tasks, file.resources),
    [file.tasks, file.resources],
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
