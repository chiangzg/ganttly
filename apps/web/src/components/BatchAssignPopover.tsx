/**
 * BatchAssignPopover — resource + load picker for batch owner assignment
 * (plan §4.6). Opens above the {@link BatchActionBar} and dispatches ONE
 * composite `batchAssignResourceCommand`, so a single undo reverts the whole
 * batch (plan §4.6 验收 "一次撤销恢复整个批量操作"). Summary tasks are excluded
 * from the target set (same G13 semantics as the drawer).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore, batchAssignResourceCommand } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { showUndoToast } from '@/lib/toast';

export interface BatchAssignPopoverProps {
  open: boolean;
  onClose(): void;
}

export function BatchAssignPopover({ open, onClose }: BatchAssignPopoverProps) {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const undoCommand = useProjectStore((s) => s.undoCommand);
  const selectedTaskIds = useViewStore((s) => s.selectedTaskIds);

  // Default to the first resource; the component stays mounted (renders null
  // while closed) so this only matters on first open.
  const [resourceId, setResourceId] = useState(() => file.resources[0]?.id ?? '');
  const [load, setLoad] = useState(100);

  // Leaf (non-summary) targets only — summary tasks cannot own assignments.
  const applicableIds = useMemo(
    () => [...selectedTaskIds].filter((id) => !file.tasks.some((t) => t.parentId === id)),
    [selectedTaskIds, file.tasks],
  );

  // Close on Escape or any pointer-down outside the bar (the bar is the popover
  // anchor, so clicks inside the popover keep it open). Uses window listeners
  // instead of an overlay: the bar sits in a transformed container where a
  // `fixed` overlay would misbehave.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const bar = document.querySelector('[data-batch-bar]');
      if (bar && !bar.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const canApply = applicableIds.length > 0 && resourceId !== '';
  const apply = () => {
    if (!canApply) return;
    const command = batchAssignResourceCommand(applicableIds, { resourceId, load });
    dispatch(command);
    showUndoToast(t('batch.assignedN', { count: applicableIds.length }), () =>
      undoCommand(command),
    );
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={t('batch.assignTitle')}
      className="absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-lg border border-border bg-bg-elevated p-3 shadow-lg"
    >
      <div className="mb-2 text-xs font-semibold">{t('batch.assignTitle')}</div>

      {file.resources.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('batch.noResources')}</p>
      ) : (
        <>
          <select
            className="mb-2 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-primary/50"
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
          >
            {resourceId === '' && (
              <option value="" disabled>
                {t('batch.assignAssignee')}
              </option>
            )}
            {file.resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.id}
              </option>
            ))}
          </select>
          <div className="mb-2 flex items-center gap-2 text-xs">
            <label className="shrink-0 text-fg-muted">{t('batch.assignLoad')}</label>
            <input
              type="number"
              min={1}
              max={100}
              value={load}
              onChange={(e) => setLoad(Math.max(1, Math.min(100, Number(e.target.value) || 100)))}
              className="w-full min-w-0 rounded-md border border-border bg-bg px-2 py-1 text-right text-fg outline-none focus:border-primary/50"
            />
            <span className="shrink-0 text-fg-muted">%</span>
          </div>
          {applicableIds.length === 0 && (
            <p className="mb-2 text-xs text-fg-muted">{t('batch.allSummaries')}</p>
          )}
          <button
            type="button"
            disabled={!canApply}
            onClick={apply}
            className="flex h-7 w-full items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-white shadow-sm outline-none transition hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('batch.assignApply')}
          </button>
        </>
      )}
    </div>
  );
}
