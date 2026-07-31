/**
 * DeleteResourceConfirm — in-app confirmation dialog for resource deletion
 * (editor-interaction-optimization-plan §2.4).
 *
 * Replaces the immediate (no-confirm) resource delete with a styled dialog
 * that shows assignment impact and emits an undo toast on confirm.
 */
import { useTranslation } from 'react-i18next';
import { useProjectStore, deleteResourceCommand } from '@/store/useProjectStore';
import { computeResourceDeleteImpact } from '@/lib/deleteImpact';
import { showUndoToast } from '@/lib/toast';
import { ConfirmDialog } from './ui/ConfirmDialog';
import type { Resource } from '@ganttly/schema';

export interface DeleteResourceConfirmProps {
  resourceId: string;
  /** Called after dialog dismiss (confirm + cancel). */
  onClose(): void;
}

export function DeleteResourceConfirm({ resourceId, onClose }: DeleteResourceConfirmProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const undoCommand = useProjectStore((s) => s.undoCommand);

  const resource: Resource | undefined = file.resources.find((r) => r.id === resourceId);
  const impact = computeResourceDeleteImpact(resourceId, file.tasks);
  const name = resource?.name || resourceId;

  return (
    <ConfirmDialog
      open
      title={t('resource.confirmDeleteTitle')}
      description={t('resource.confirmDeleteDesc')}
      impact={
        impact.assignmentCount > 0
          ? t('resource.confirmDeleteImpact', { count: impact.assignmentCount })
          : null
      }
      confirmLabel={t('resource.delete')}
      danger
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={() => {
        const command = deleteResourceCommand(resourceId);
        dispatch(command);
        showUndoToast(t('toast.deletedResource', { name }), () => undoCommand(command));
        onClose();
      }}
    />
  );
}
