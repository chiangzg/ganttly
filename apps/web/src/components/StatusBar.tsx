/**
 * Status bar — shows save state and undo/redo availability (PRD §3.8).
 */
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/store/useProjectStore';

export function StatusBar() {
  const { t } = useTranslation();
  const saveState = useProjectStore((s) => s.saveState);
  const taskCount = useProjectStore((s) => s.file.tasks.length);
  const showCriticalPath = useProjectStore((s) => s.file.viewState.showCriticalPath);

  const saveLabel =
    saveState.status === 'saving'
      ? t('status.saving')
      : saveState.status === 'error'
        ? `${t('errors.saveFailed')}: ${saveState.error}`
        : t('status.saved');

  return (
    <div className="flex items-center justify-between border-t border-border bg-bg-elevated px-3 py-1 text-xs text-fg-muted">
      <div>
        {taskCount} 任务{showCriticalPath ? ' · 关键路径' : ''}
      </div>
      <div className={saveState.status === 'error' ? 'text-danger' : ''}>{saveLabel}</div>
    </div>
  );
}
