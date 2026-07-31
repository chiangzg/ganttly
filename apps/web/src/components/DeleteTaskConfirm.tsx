/**
 * DeleteTaskConfirm — in-app confirmation dialog for task deletion
 * (editor-interaction-optimization-plan §2.4).
 *
 * Replaces `window.confirm()` with a styled dialog that shows cascade impact
 * (child count, dependency count) and emits an undo toast on confirm.
 */
import { useTranslation } from 'react-i18next';
import { useProjectStore, deleteTaskCommand } from '@/store/useProjectStore';
import { computeTaskDeleteImpact } from '@/lib/deleteImpact';
import { showUndoToast } from '@/lib/toast';
import { ConfirmDialog } from './ui/ConfirmDialog';
import type { Task } from '@ganttly/schema';

export interface DeleteTaskConfirmProps {
  taskId: string;
  /** Called after the dialog is dismissed (both confirm + cancel). */
  onClose(): void;
}

export function DeleteTaskConfirm({ taskId, onClose }: DeleteTaskConfirmProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const undoCommand = useProjectStore((s) => s.undoCommand);

  const task: Task | undefined = file.tasks.find((x) => x.id === taskId);
  const impact = computeTaskDeleteImpact(taskId, file.tasks);
  const name = task?.name || taskId;

  // Compose impact lines (nulls filtered out — only shown when relevant).
  const lines: string[] = [];
  if (impact.childCount > 0) {
    lines.push(t('table.confirmDeleteImpactChildren', { count: impact.childCount }));
  }
  if (impact.dependencyCount > 0) {
    lines.push(t('table.confirmDeleteImpactDeps', { count: impact.dependencyCount }));
  }
  if (impact.totalDeleted > 1) {
    lines.push(t('table.confirmDeleteImpactSummary', { total: impact.totalDeleted }));
  }

  return (
    <ConfirmDialog
      open
      title={t('table.confirmDeleteTitle')}
      description={t('table.confirmDeleteDesc')}
      impact={
        lines.length > 0 ? (
          <>
            {lines.map((msg, i) => (
              <div key={i}>{msg}</div>
            ))}
          </>
        ) : null
      }
      confirmLabel={t('drawer.delete')}
      danger
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={() => {
        const command = deleteTaskCommand(taskId);
        dispatch(command);
        showUndoToast(
          impact.totalDeleted > 1
            ? t('toast.deletedTasks', { count: impact.totalDeleted })
            : t('toast.deletedTask', { name }),
          () => undoCommand(command),
        );
        onClose();
      }}
    />
  );
}
