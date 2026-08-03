/**
 * BatchDeleteConfirm — multi-task deletion confirmation (plan §4.6).
 *
 * Mirrors {@link DeleteTaskConfirm} but operates on a set of task ids. It shows
 * the unioned cascade impact (descendants + dependency edges, never double
 * counting a child that is itself selected) and emits a single composite
 * `batchDeleteTasksCommand` so one undo restores every deleted task (plan §4.6
 * 验收 "一次撤销恢复整个批量操作").
 */
import { useTranslation } from 'react-i18next';
import { useProjectStore, batchDeleteTasksCommand } from '@/store/useProjectStore';
import { computeBatchDeleteImpact } from '@/lib/deleteImpact';
import { showUndoToast } from '@/lib/toast';
import { useViewStore } from '@/store/useViewStore';
import { ConfirmDialog } from './ui/ConfirmDialog';

export interface BatchDeleteConfirmProps {
  /** The selected task ids to delete (before descendant closure). */
  ids: string[];
  /** Called after the dialog is dismissed (both confirm + cancel). */
  onClose(): void;
}

export function BatchDeleteConfirm({ ids, onClose }: BatchDeleteConfirmProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const undoCommand = useProjectStore((s) => s.undoCommand);
  const clearSelection = useViewStore((s) => s.clearSelection);

  const impact = computeBatchDeleteImpact(ids, file.tasks);

  const lines: string[] = [];
  if (impact.dependencyCount > 0) {
    lines.push(t('table.confirmDeleteImpactDeps', { count: impact.dependencyCount }));
  }
  lines.push(t('batch.confirmDeleteSummary', { total: impact.totalDeleted }));

  return (
    <ConfirmDialog
      open
      title={t('batch.deleteTitle')}
      description={t('batch.deleteDesc', { count: ids.length })}
      impact={
        <>
          {lines.map((msg, i) => (
            <div key={i}>{msg}</div>
          ))}
        </>
      }
      confirmLabel={t('drawer.delete')}
      danger
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={() => {
        const command = batchDeleteTasksCommand(ids);
        dispatch(command);
        showUndoToast(t('batch.deletedN', { count: impact.totalDeleted }), () =>
          undoCommand(command),
        );
        // Clear the multi-selection: every selected task is gone.
        clearSelection();
        onClose();
      }}
    />
  );
}
