/**
 * Right-click context menu (PRD §3.10).
 *
 * Actions:
 * - Edit (open drawer)
 * - Toggle milestone / task
 * - Move up / down (swap sibling order — Alt+↑/↓ on the table)
 * - Indent / outdent (reparent — Tab / Shift+Tab on the table). Uses the SAME
 *   rollup-aware command as the keyboard path so parent summaries recompute
 *   after a menu-driven move (plan §5.4; the old path used the non-rollup
 *   command and left parent progress/dates stale).
 * - Delete (cascade)
 *
 * §5.4 keyboard + accessibility behavior:
 * - Escape closes; ArrowUp/ArrowDown move focus; Enter/Space activates.
 * - Inapplicable actions (move at an edge / promote at root / demote at first
 *   child) are visibly disabled, never silent no-ops.
 * - The menu is clamped to the viewport (auto-flips near the right/bottom edge).
 * - On close, focus returns to the element that triggered the menu (rows and
 *   the canvas are focusable, and right-click focuses them before opening).
 */
import { useTranslation } from 'react-i18next';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useViewStore } from '@/store/useViewStore';
import {
  useProjectStore,
  deleteTaskCommand,
  updateTaskCommand,
  moveTaskWithRollupCommand,
  swapSiblingOrderCommand,
  pasteTaskCommand,
} from '@/store/useProjectStore';
import { clipboard, copyToClipboard, cutToClipboard, clearClipboard } from '@/lib/clipboard';
import { modKeyLabel } from '@/lib/platform';
import { computeTaskPosition } from '@/lib/taskPosition';
import { nanoid } from 'nanoid';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';

export function ContextMenu() {
  const { t } = useTranslation();
  const menu = useViewStore((s) => s.contextMenu);
  const close = useViewStore((s) => s.closeContextMenu);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);

  // §5.4 focus restore: right-click focuses the (focusable) row/canvas before
  // the menu opens, so capture it whenever the menu opens and restore it on
  // close. (The component stays mounted with menu=null, so this runs per-open.)
  const triggerElRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (menu) {
      triggerElRef.current = document.activeElement as HTMLElement | null;
    }
  }, [menu]);

  // §5.4 roving-focus item list; the focused item is tracked via
  // document.activeElement (no stale-closure risk in the window key listener).
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  // §5.4 viewport clamping: measure the rendered menu and pull it back inside
  // the window (auto-flip near the right/bottom edge, 8px breathing room).
  const [clampedPos, setClampedPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const x = Math.min(menu.x, window.innerWidth - rect.width - margin);
    const y = Math.min(menu.y, window.innerHeight - rect.height - margin);
    setClampedPos({ x: Math.max(margin, x), y: Math.max(margin, y) });
  }, [menu]);

  const moveFocus = useCallback((dir: 1 | -1) => {
    const items = itemRefs.current.filter(
      (el): el is HTMLButtonElement => el !== null && !el.disabled,
    );
    if (items.length === 0) return;
    const activeIndex = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const cur = activeIndex >= 0 ? activeIndex : 0;
    const next = (cur + dir + items.length) % items.length;
    items[next]!.focus();
  }, []);

  const activateFocused = useCallback(() => {
    const el = document.activeElement as HTMLButtonElement | null;
    if (el && !el.disabled && itemRefs.current.includes(el)) el.click();
  }, []);

  const handleClose = useCallback(() => {
    const trigger = triggerElRef.current;
    close();
    // §5.4: focus returns to the triggering row/canvas after the menu closes.
    if (trigger && document.contains(trigger) && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }, [close]);

  // §5.4: Escape closes; arrows navigate; Enter/Space activates. A window
  // listener so keys work even if focus sits outside the menu after a click.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateFocused();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, moveFocus, activateFocused, handleClose]);

  // Focus the first enabled item when the menu opens.
  useEffect(() => {
    const first = itemRefs.current.find((el) => el !== null && !el.disabled);
    if (first) {
      first.focus();
    }
  }, [menu]);

  if (!menu) return null;
  const task = file.tasks.find((x) => x.id === menu.taskId);
  if (!task) return null;

  // §5.4: single source of truth for which move/indent/outdent actions apply to
  // this task (shared with the TaskTable keyboard handlers via taskPosition.ts).
  const pos = computeTaskPosition(task.id, file.tasks);

  const onDelete = () => {
    setConfirmDeleteTaskId(task.id);
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
    handleClose();
  };

  const onIndent = () => {
    if (!pos.canIndent) {
      handleClose();
      return;
    }
    const tasks = file.tasks;
    const siblings = tasks
      .filter((x) => x.parentId === task.parentId)
      .sort((a, b) => a.order - b.order);
    const myIdx = siblings.findIndex((x) => x.id === task.id);
    const prev = siblings[myIdx - 1]!;
    const childCount = tasks.filter((x) => x.parentId === prev.id).length;
    dispatch(moveTaskWithRollupCommand(task.id, prev.id, childCount));
    handleClose();
  };

  const onOutdent = () => {
    if (!pos.canOutdent) {
      handleClose();
      return;
    }
    const parent = file.tasks.find((x) => x.id === task.parentId);
    if (!parent) {
      handleClose();
      return;
    }
    dispatch(moveTaskWithRollupCommand(task.id, parent.parentId, parent.order + 1));
    handleClose();
  };

  const onMoveSibling = (dir: -1 | 1) => {
    const canMove = dir === -1 ? pos.canMoveUp : pos.canMoveDown;
    if (!canMove) {
      handleClose();
      return;
    }
    const siblings = file.tasks
      .filter((x) => x.parentId === task.parentId)
      .sort((a, b) => a.order - b.order);
    const idx = siblings.findIndex((x) => x.id === task.id);
    const swapWith = siblings[idx + dir];
    if (!swapWith) {
      handleClose();
      return;
    }
    dispatch(swapSiblingOrderCommand(task.id, swapWith.id));
    handleClose();
  };

  const onEdit = () => {
    // §4.6: selection is ephemeral now; selectSingle mirrors the anchor into
    // file.viewState.selectedTaskId so the drawer opens on this task.
    useViewStore.getState().selectSingle(task.id);
    openDrawer();
    handleClose();
  };

  const onCopy = () => {
    copyToClipboard(task);
    handleClose();
  };

  const onCut = () => {
    cutToClipboard(task);
    handleClose();
  };

  const onPaste = () => {
    const src = clipboard.task;
    if (!src) {
      handleClose();
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
    handleClose();
  };

  const canPaste = clipboard.task !== null;
  // Shortcut hints use the platform modifier (⌘ on macOS, Ctrl elsewhere).
  const mod = modKeyLabel();
  const setItemRef = (index: number) => (el: HTMLButtonElement | null) => {
    itemRefs.current[index] = el;
  };

  return (
    <>
      <div
        className="fixed inset-0 z-20"
        onClick={handleClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-30 min-w-52 rounded border border-border bg-bg-elevated py-1 text-sm shadow-xl"
        style={
          clampedPos ? { left: clampedPos.x, top: clampedPos.y } : { left: menu.x, top: menu.y }
        }
      >
        <MenuItem ref={setItemRef(0)} onClick={onEdit}>
          {t('contextMenu.edit')}
        </MenuItem>
        <MenuItem ref={setItemRef(1)} onClick={onCopy} shortcut={`${mod}+C`}>
          {t('contextMenu.copy')}
        </MenuItem>
        <MenuItem ref={setItemRef(2)} onClick={onCut} shortcut={`${mod}+X`}>
          {t('contextMenu.cut')}
        </MenuItem>
        <MenuItem ref={setItemRef(3)} onClick={onPaste} disabled={!canPaste} shortcut={`${mod}+V`}>
          {t('contextMenu.paste')}
        </MenuItem>
        <MenuItem ref={setItemRef(4)} onClick={onToggleMilestone}>
          {task.isMilestone ? t('contextMenu.toTask') : t('contextMenu.toMilestone')}
        </MenuItem>
        <MenuItem
          ref={setItemRef(5)}
          onClick={() => onMoveSibling(-1)}
          disabled={!pos.canMoveUp}
          shortcut="Alt+↑"
        >
          {t('contextMenu.moveUp')}
        </MenuItem>
        <MenuItem
          ref={setItemRef(6)}
          onClick={() => onMoveSibling(1)}
          disabled={!pos.canMoveDown}
          shortcut="Alt+↓"
        >
          {t('contextMenu.moveDown')}
        </MenuItem>
        <MenuItem ref={setItemRef(7)} onClick={onIndent} disabled={!pos.canIndent} shortcut="Tab">
          {t('contextMenu.indent')}
        </MenuItem>
        <MenuItem
          ref={setItemRef(8)}
          onClick={onOutdent}
          disabled={!pos.canOutdent}
          shortcut="Shift+Tab"
        >
          {t('contextMenu.outdent')}
        </MenuItem>
        <MenuItem ref={setItemRef(9)} onClick={onDelete} danger shortcut="Delete">
          {t('contextMenu.delete')}
        </MenuItem>
      </div>
      {confirmDeleteTaskId && (
        <DeleteTaskConfirm taskId={confirmDeleteTaskId} onClose={handleClose} />
      )}
    </>
  );
}

interface MenuItemProps {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Optional accelerator hint (e.g. "⌘+C", "Delete") shown right-aligned. */
  shortcut?: string;
}

const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { children, onClick, danger, disabled, shortcut },
  ref,
) {
  return (
    <button
      ref={ref}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center px-3 py-1 text-left outline-none focus:bg-bg ${
        disabled
          ? 'cursor-not-allowed text-fg-muted opacity-50 hover:bg-transparent'
          : danger
            ? 'text-danger hover:bg-bg'
            : 'text-fg hover:bg-bg'
      }`}
    >
      <span className="flex-1">{children}</span>
      {shortcut && (
        <span className="pointer-events-none ml-4 shrink-0 text-xs text-fg-muted">{shortcut}</span>
      )}
    </button>
  );
});
