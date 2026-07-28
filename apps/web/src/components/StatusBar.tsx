/**
 * Status bar — shows save state and undo/redo availability (PRD §3.8), plus a
 * baseline comparison summary when a baseline is active (spec §5.8).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { totalPersonDays } from '@/lib/cost';
import { resolveCalendar } from '@/lib/calendar';
import { findActiveBaseline, summarizeBaselineVariance } from '@/lib/baseline';

export function StatusBar() {
  const { t } = useTranslation();
  const saveState = useProjectStore((s) => s.saveState);
  const file = useProjectStore((s) => s.file);
  const activeBaselineId = useViewStore((s) => s.activeBaselineId);
  const taskCount = file.tasks.length;
  const showCriticalPath = file.viewState.showCriticalPath;

  // Total person-days across all leaf tasks. Normal working days plus explicit
  // task overtime dates contribute effort; unmarked rest days do not.
  const personDays = useMemo(
    () => totalPersonDays(file.tasks, file.resources, resolveCalendar(file.calendar)),
    [file.tasks, file.resources, file.calendar],
  );

  const activeBaseline = findActiveBaseline(file.baselines, activeBaselineId);
  // Baseline summary — only the delayed count + max delay appears here; added /
  // deleted counts stay in the baseline menu / manage dialog to avoid clutter
  // on narrow screens (spec §5.8).
  const baselineSummary = useMemo(() => {
    if (!activeBaseline) return null;
    const cal = resolveCalendar(file.calendar);
    return summarizeBaselineVariance(file, activeBaseline, cal);
  }, [file.tasks, file.resources, file.calendar, activeBaseline]);

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
        {activeBaseline && baselineSummary ? (
          baselineSummary.lateLeafCount > 0 ? (
            <span>
              {' '}
              {t('baseline.statusDelay', {
                name: activeBaseline.name,
                count: baselineSummary.lateLeafCount,
                max: baselineSummary.maxFinishDelay,
              })}
            </span>
          ) : (
            <span> {t('baseline.statusNoDelay', { name: activeBaseline.name })}</span>
          )
        ) : null}
      </div>
      <div className={saveState.status === 'error' ? 'text-danger' : ''}>{saveLabel}</div>
    </div>
  );
}
