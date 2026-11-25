/**
 * Right-click context menu (PRD §3.10). One shell, two item sets: task rows
 * (task view) and resource rows (resource view) — `useViewStore.contextMenu`
 * carries the kind.
 *
 * Task actions:
 * - Edit (open drawer)
 * - Toggle milestone / task
 * - Move up / down (swap sibling order — Alt+↑/↓ on the table)
 * - Indent / outdent (reparent — Tab / Shift+Tab on the table). Uses the SAME
 *   rollup-aware command as the keyboard path so parent summaries recompute
 *   after a menu-driven move (plan §5.4; the old path used the non-rollup
 *   command and left parent progress/dates stale).
 * - Delete (cascade)
 * - Priority (priority-matrix spec §3.2): a second page shown in place of the
 *   main list — ← returns, the current quadrant is check-marked. Applying the
 *   current value again is a no-op (no command, no undo record).
 *
 * Resource actions: Rename (F2, one-shot request to ResourceList) /
 * Expand-Collapse drill-down / Add resource / Delete (confirm dialog).
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
import { ArrowLeft, Check } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useViewStore } from '@/store/useViewStore';
import {
  useProjectStore,
  deleteTaskCommand,
  updateTaskCommand,
  moveTaskWithRollupCommand,
  swapSiblingOrderCommand,
  pasteTaskCommand,
  addResourceCommand,
} from '@/store/useProjectStore';
import { clipboard, copyToClipboard, cutToClipboard, clearClipboard } from '@/lib/clipboard';
import { modKeyLabel } from '@/lib/platform';
import { computeTaskPosition } from '@/lib/taskPosition';
import { nanoid } from 'nanoid';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';
import { DeleteResourceConfirm } from './DeleteResourceConfirm';
import { PriorityTag } from './PriorityTag';
import { PRIORITY_TAG, TASK_PRIORITIES } from '@/lib/priority';
import { setTaskPriority } from '@/lib/setTaskPriority';
import type { TaskPriority } from '@ganttly/schema';

export function ContextMenu() {
  const { t } = useTranslation();
  const menu = useViewStore((s) => s.contextMenu);
  const close = useViewStore((s) => s.closeContextMenu);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null);
  const [confirmDeleteResourceId, setConfirmDeleteResourceId] = useState<string | null>(null);
  // priority-matrix spec §3.2: the task menu swaps to a second page for picking
  // a priority — same shell, same roving-focus keyboard model. The page belongs
  // to ONE menu instance: comparing the stored menu with the current one resets
  // to the main page during the first render of a fresh menu. (Resetting in an
  // effect instead flashes the previous menu's page for a frame, and a click
  // landing in that frame hits the wrong item.)
  const [pageState, setPageState] = useState<{
    menu: NonNullable<typeof menu>;
    page: 'main' | 'priority';
  } | null>(null);
  const page: 'main' | 'priority' = menu && pageState?.menu === menu ? pageState.page : 'main';
  const setPage = useCallback(
    (next: 'main' | 'priority') => {
      if (menu) setPageState({ menu, page: next });
    },
    [menu],
  );
  // The "优先级" entry on the main page, refocused when the user comes back.
  const priorityEntryRef = useRef<HTMLButtonElement | null>(null);

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
  // `find` / `filter` DO visit holes (an index no rendered item ever claimed)
  // with `undefined`, so test for both empties — never just `=== null`. A hole
  // is one missed renumber away whenever an item is inserted.
  const enabledItems = (): HTMLButtonElement[] =>
    itemRefs.current.filter(
      (el): el is HTMLButtonElement => el !== null && el !== undefined && !el.disabled,
    );
  const firstEnabledItem = (): HTMLButtonElement | undefined => enabledItems()[0];

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
  }, [menu, page]);

  const moveFocus = useCallback((dir: 1 | -1) => {
    const items = enabledItems();
    if (items.length === 0) return;
    // Index WITHIN the enabled list: the roving set skips disabled items, so an
    // index taken from the full ref array would overshoot past every disabled
    // entry above the focused one.
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
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
      } else if (
        e.key === 'ArrowRight' &&
        page === 'main' &&
        document.activeElement === priorityEntryRef.current
      ) {
        // → on the "优先级" entry opens its page, like a native submenu.
        e.preventDefault();
        setPage('priority');
      } else if (e.key === 'ArrowLeft' && page === 'priority') {
        e.preventDefault();
        setPage('main');
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateFocused();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, page, moveFocus, activateFocused, handleClose, setPage]);

  // Focus the first enabled item when the menu opens (or when it changes page —
  // the page swap re-renders the whole list, so focus would otherwise be lost).
  useEffect(() => {
    if (!menu) return;
    firstEnabledItem()?.focus();
  }, [menu, page]);

  if (!menu) return null;

  // The shell (overlay + clamped menu container) is shared by the task and
  // resource item sets; only the items and confirm dialog differ.
  const renderMenu = (items: React.ReactNode, confirm: React.ReactNode) => (
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
        {items}
      </div>
      {confirm}
    </>
  );
  const setItemRef = (index: number) => (el: HTMLButtonElement | null) => {
    itemRefs.current[index] = el;
  };

  if (menu.kind === 'resource') {
    const resource = file.resources.find((x) => x.id === menu.resourceId);
    if (!resource) return null;
    // Leaf-task count (same rule as the resource view's drill-down).
    const parentIds = new Set(file.tasks.map((x) => x.parentId));
    const taskCount = file.tasks.filter(
      (x) => !parentIds.has(x.id) && x.assignments.some((a) => a.resourceId === resource.id),
    ).length;
    const expanded = useViewStore.getState().expandedResourceIds.has(resource.id);

    const onResourceRename = () => {
      // ResourceList owns the inline-edit cell; ask it to start a name edit
      // via the one-shot store request (double-click drills down instead).
      useViewStore.getState().requestResourceRename(resource.id);
      handleClose();
    };
    const onResourceToggle = () => {
      useViewStore.getState().toggleResourceExpanded(resource.id);
      handleClose();
    };
    const onResourceAdd = () => {
      dispatch(
        addResourceCommand({
          id: nanoid(10),
          name: t('resource.placeholderName'),
          capacity: 1.0,
        }),
      );
      handleClose();
    };
    const onResourceDelete = () => {
      // Keep the menu state mounted as the dialog's anchor (same trick as the
      // task branch): the dialog overlays it, and dismissing the dialog both
      // clears this flag and closes the menu. Closing the menu here would
      // unmount the whole component — dialog included.
      setConfirmDeleteResourceId(resource.id);
    };

    return renderMenu(
      <>
        <MenuItem ref={setItemRef(0)} onClick={onResourceRename} shortcut="F2">
          {t('contextMenu.rename')}
        </MenuItem>
        <MenuItem ref={setItemRef(1)} onClick={onResourceToggle} disabled={taskCount === 0}>
          {expanded ? t('resource.collapse') : t('resource.expand')}
        </MenuItem>
        <MenuItem ref={setItemRef(2)} onClick={onResourceAdd}>
          {t('resource.add')}
        </MenuItem>
        <MenuItem ref={setItemRef(3)} onClick={onResourceDelete} danger shortcut="Delete">
          {t('resource.delete')}
        </MenuItem>
      </>,
      confirmDeleteResourceId && (
        <DeleteResourceConfirm
          resourceId={confirmDeleteResourceId}
          onClose={() => {
            setConfirmDeleteResourceId(null);
            handleClose();
          }}
        />
      ),
    );
  }

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

  const onRename = () => {
    // TaskTable owns the inline-edit cell; ask it to start a name edit via the
    // one-shot store request (double-click is reserved for opening the drawer).
    useViewStore.getState().requestRename(task.id);
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

  // priority-matrix spec §3.2: summaries are never triaged — the entry stays
  // visible but disabled rather than silently doing nothing.
  const isSummary = file.tasks.some((x) => x.parentId === task.id);
  const onPickPriority = (next: TaskPriority | undefined) => {
    handleClose();
    // One shared entry point with the matrix drag: it skips the no-op (re-picking
    // the current value is not a change, so no command, no undo record) and
    // tells an open drawer to re-base its draft.
    setTaskPriority(task.id, next);
  };
  const backToMain = () => {
    setPage('main');
    // The page swap re-renders the list; land focus back on the entry.
    requestAnimationFrame(() => priorityEntryRef.current?.focus());
  };

  const items =
    page === 'priority' ? (
      <>
        <MenuItem ref={setItemRef(0)} onClick={backToMain}>
          <span className="flex items-center gap-2">
            <ArrowLeft size={14} aria-hidden />
            {t('contextMenu.priority')}
          </span>
        </MenuItem>
        {/* MenuItem wraps all children in one block, so the check mark must live
         * INSIDE the row's flex line (ml-auto) — as a sibling it wraps to a new
         * line under the label. */}
        <MenuItem ref={setItemRef(1)} onClick={() => onPickPriority(undefined)}>
          <span className="flex w-full items-center gap-2">
            <span aria-hidden className="w-4 text-center text-xs text-fg-muted">
              —
            </span>
            {t('priority.none')}
            {task.priority === undefined && (
              <Check size={14} className="ml-auto shrink-0 text-primary" aria-hidden />
            )}
          </span>
        </MenuItem>
        {TASK_PRIORITIES.map((priority, index) => (
          <MenuItem
            key={priority}
            ref={setItemRef(index + 2)}
            onClick={() => onPickPriority(priority)}
          >
            <span className="flex w-full items-center gap-2">
              <PriorityTag priority={priority} />
              {t(`priority.title${priority}`)}
              <span className="text-xs text-fg-muted">{t(`priority.hint${priority}`)}</span>
              {task.priority === priority && (
                <Check size={14} className="ml-auto shrink-0 text-primary" aria-hidden />
              )}
            </span>
          </MenuItem>
        ))}
      </>
    ) : (
      <>
        <MenuItem ref={setItemRef(0)} onClick={onEdit}>
          {t('contextMenu.edit')}
        </MenuItem>
        <MenuItem ref={setItemRef(1)} onClick={onRename} shortcut="F2">
          {t('contextMenu.rename')}
        </MenuItem>
        <MenuItem ref={setItemRef(2)} onClick={onCopy} shortcut={`${mod}+C`}>
          {t('contextMenu.copy')}
        </MenuItem>
        <MenuItem ref={setItemRef(3)} onClick={onCut} shortcut={`${mod}+X`}>
          {t('contextMenu.cut')}
        </MenuItem>
        <MenuItem ref={setItemRef(4)} onClick={onPaste} disabled={!canPaste} shortcut={`${mod}+V`}>
          {t('contextMenu.paste')}
        </MenuItem>
        <MenuItem ref={setItemRef(5)} onClick={onToggleMilestone}>
          {task.isMilestone ? t('contextMenu.toTask') : t('contextMenu.toMilestone')}
        </MenuItem>
        <MenuItem
          ref={(el) => {
            priorityEntryRef.current = el;
            setItemRef(6)(el);
          }}
          onClick={() => setPage('priority')}
          disabled={isSummary}
          title={isSummary ? t('priority.drawerSummaryHint') : undefined}
          shortcut={
            isSummary
              ? undefined
              : `${task.priority ? PRIORITY_TAG[task.priority] : t('priority.none')} ›`
          }
        >
          {t('contextMenu.priority')}
        </MenuItem>
        <MenuItem
          ref={setItemRef(7)}
          onClick={() => onMoveSibling(-1)}
          disabled={!pos.canMoveUp}
          shortcut="Alt+↑"
        >
          {t('contextMenu.moveUp')}
        </MenuItem>
        <MenuItem
          ref={setItemRef(8)}
          onClick={() => onMoveSibling(1)}
          disabled={!pos.canMoveDown}
          shortcut="Alt+↓"
        >
          {t('contextMenu.moveDown')}
        </MenuItem>
        <MenuItem ref={setItemRef(9)} onClick={onIndent} disabled={!pos.canIndent} shortcut="Tab">
          {t('contextMenu.indent')}
        </MenuItem>
        <MenuItem
          ref={setItemRef(10)}
          onClick={onOutdent}
          disabled={!pos.canOutdent}
          shortcut="Shift+Tab"
        >
          {t('contextMenu.outdent')}
        </MenuItem>
        <MenuItem ref={setItemRef(11)} onClick={onDelete} danger shortcut="Delete">
          {t('contextMenu.delete')}
        </MenuItem>
      </>
    );

  return renderMenu(
    items,
    confirmDeleteTaskId && <DeleteTaskConfirm taskId={confirmDeleteTaskId} onClose={handleClose} />,
  );
}

interface MenuItemProps {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Optional accelerator hint (e.g. "⌘+C", "Delete") shown right-aligned. */
  shortcut?: string;
  /** Native tooltip — used to say WHY a disabled item is disabled. */
  title?: string;
}

const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { children, onClick, danger, disabled, shortcut, title },
  ref,
) {
  return (
    <button
      ref={ref}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
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
