/**
 * Right-click context menu (PRD §3.10).
 *
 * Actions:
 * - Edit (open drawer)
 * - Toggle milestone / task
 * - Indent / outdent (reparent)
 * - Delete (cascade)
 */
import { useTranslation } from 'react-i18next';
import { useViewStore } from '@/store/useViewStore';
import {
  useProjectStore,
  deleteTaskCommand,
  updateTaskCommand,
  moveTaskCommand,
  pasteTaskCommand,
  setViewStateCommand,
} from '@/store/useProjectStore';
import { clipboard, copyToClipboard, cutToClipboard, clearClipboard } from '@/lib/clipboard';
import { nanoid } from 'nanoid';

export function ContextMenu() {
  const { t } = useTranslation();
  const menu = useViewStore((s) => s.contextMenu);
  const close = useViewStore((s) => s.closeContextMenu);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);

  if (!menu) return null;
  const task = file.tasks.find((x) => x.id === menu.taskId);
  if (!task) return null;

  const onDelete = () => {
    if (!window.confirm(t('table.confirmDelete'))) return;
    dispatch(deleteTaskCommand(task.id));
    close();
  };

  const onToggleMilestone = () => {
    if (task.isMilestone) {
      dispatch(updateTaskCommand(task.id, { isMilestone: false, duration: 1, end: task.start }));
    } else {
      dispatch(
        updateTaskCommand(task.id, {
          isMilestone: true,
          duration: 0,
          end: task.start,
        }),
      );
    }
    close();
  };

  const onIndent = () => {
    const siblings = file.tasks
      .filter((x) => x.parentId === task.parentId)
      .sort((a, b) => a.order - b.order);
    const myIdx = siblings.findIndex((x) => x.id === task.id);
    if (myIdx <= 0) {
      close();
      return;
    }
    const prev = siblings[myIdx - 1]!;
    const newOrder = file.tasks.filter((x) => x.parentId === prev.id).length;
    dispatch(moveTaskCommand(task.id, prev.id, newOrder));
    close();
  };

  const onOutdent = () => {
    if (task.parentId === null) {
      close();
      return;
    }
    const parent = file.tasks.find((x) => x.id === task.parentId);
    if (!parent) {
      close();
      return;
    }
    dispatch(moveTaskCommand(task.id, parent.parentId, parent.order + 1));
    close();
  };

  const onEdit = () => {
    dispatch(setViewStateCommand({ selectedTaskId: task.id }));
    openDrawer();
    close();
  };

  const onCopy = () => {
    copyToClipboard(task);
    close();
  };

  const onCut = () => {
    cutToClipboard(task);
    close();
  };

  const onPaste = () => {
    const src = clipboard.task;
    if (!src) {
      close();
      return;
    }
    const pasted = {
      ...src,
      id: nanoid(10),
      name: `${src.name} ${t('table.copySuffix')}`.trim(),
      dependencies: [],
    };
    if (clipboard.cutMode) {
      dispatch(deleteTaskCommand(src.id));
      clearClipboard();
    }
    dispatch(pasteTaskCommand(pasted, task.id));
    close();
  };

  const canPaste = clipboard.task !== null;

  return (
    <>
      <div
        className="fixed inset-0 z-20"
        onClick={close}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        className="fixed z-30 min-w-48 rounded border border-border bg-bg-elevated py-1 text-sm shadow-xl"
        style={{ left: menu.x, top: menu.y }}
      >
        <MenuItem onClick={onEdit}>{t('contextMenu.edit')}</MenuItem>
        <MenuItem onClick={onCopy}>{t('contextMenu.copy')}</MenuItem>
        <MenuItem onClick={onCut}>{t('contextMenu.cut')}</MenuItem>
        <MenuItem onClick={onPaste} disabled={!canPaste}>
          {t('contextMenu.paste')}
        </MenuItem>
        <MenuItem onClick={onToggleMilestone}>
          {task.isMilestone ? t('contextMenu.toTask') : t('contextMenu.toMilestone')}
        </MenuItem>
        <MenuItem onClick={onIndent}>{t('contextMenu.indent')}</MenuItem>
        <MenuItem onClick={onOutdent}>{t('contextMenu.outdent')}</MenuItem>
        <MenuItem onClick={onDelete} danger>
          {t('contextMenu.delete')}
        </MenuItem>
      </div>
    </>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`block w-full px-3 py-1 text-left hover:bg-bg ${
        disabled
          ? 'cursor-not-allowed text-fg-muted opacity-50 hover:bg-transparent'
          : danger
            ? 'text-danger'
            : 'text-fg'
      }`}
    >
      {children}
    </button>
  );
}
