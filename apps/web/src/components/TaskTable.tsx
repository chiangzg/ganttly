/**
 * WBS task table — the left pane (PRD §3.1, §3.10).
 *
 * Features:
 * - Render the task tree (WBS numbers, names, dates, duration, progress)
 * - Click to select, double-click to open the edit drawer
 * - Keyboard: Tab/Shift+Tab indent/outdent, Enter new sibling, Delete, F2 rename
 * - Mouse drag to reorder + reparent (HTML5 DnD)
 * - Right-click for the context menu
 * - Vertical scroll shared with GanttCanvas via projectStore.scrollTop
 */
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  useProjectStore,
  setViewStateCommand,
  moveTaskCommand,
  deleteTaskCommand,
  updateTaskCommand,
  type Command,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { buildTree, flattenVisible, type TreeNode } from '@/engine/scene';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { cn } from '@/lib/cn';
import { nanoid } from 'nanoid';
import type { Task } from '@ganttly/schema';

const TABLE_WIDTH = 420;
/**
 * 共享列模板：表头与每行数据必须用同一个，否则列宽按行内容自适应，
 * 会导致 WBS/工期/进度列与表头错位、长任务名挤压（bug: 左侧明细挤在一起）。
 */
const GRID_TEMPLATE = '44px minmax(0, 1fr) 72px 64px';

export function TaskTable() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const openContextMenu = useViewStore((s) => s.openContextMenu);
  const scrollRef = useRef<HTMLDivElement>(null);
  const renamingId = useRef<string | null>(null);

  const rows = useMemo(() => {
    const tree = buildTree(file.tasks);
    return flattenVisible(tree, new Set(file.viewState.collapsedTaskIds));
  }, [file.tasks, file.viewState.collapsedTaskIds]);

  // Latest scrollTop kept in a ref so the store→DOM sync effect can decide
  // whether the change originated here (user scrolling) or elsewhere (canvas
  // wheel-pan / Today button) without re-binding.
  const localScrolling = useRef(false);

  // Reflect store-driven scrollTop changes (from canvas wheel-pan) onto this
  // panel. When the user scrolls here directly, onScroll updates the store and
  // sets localScrolling so this effect becomes a no-op for that frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || localScrolling.current) return;
    if (Math.abs(el.scrollTop - file.viewState.scrollTop) > 1) {
      el.scrollTop = file.viewState.scrollTop;
    }
  }, [file.viewState.scrollTop]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    localScrolling.current = true;
    if (top !== file.viewState.scrollTop) {
      // Direct setState, not dispatch — scrolling is ephemeral and must not
      // pollute the undo stack with one "视图变更" per scroll tick.
      useProjectStore.setState({
        file: {
          ...file,
          viewState: { ...file.viewState, scrollTop: top },
        },
      });
    }
    requestAnimationFrame(() => {
      localScrolling.current = false;
    });
  };

  const select = (taskId: string) => {
    dispatch(setViewStateCommand({ selectedTaskId: taskId }));
  };

  // ---- Keyboard navigation (PRD §3.10) ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, node: TreeNode) => {
    const task = node.task;
    if (e.key === 'Tab') {
      e.preventDefault();
      indentOrOutdent(task.id, e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      createSibling(task.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (window.confirm(t('table.confirmDelete'))) {
        dispatch(deleteTaskCommand(task.id));
      }
    } else if (e.key === 'F2') {
      e.preventDefault();
      renamingId.current = task.id;
      // Force re-render so the row shows an input.
      forceRerender();
    }
  };

  // We need a tiny rerender trigger for inline rename.
  const [, setRerender] = useState(0);
  const forceRerender = () => setRerender((n) => n + 1);

  const indentOrOutdent = (taskId: string, outdent: boolean) => {
    const tasks = file.tasks;
    const me = tasks.find((t) => t.id === taskId);
    if (!me) return;
    const siblings = tasks
      .filter((t) => t.parentId === me.parentId)
      .sort((a, b) => a.order - b.order);
    const myIdx = siblings.findIndex((t) => t.id === taskId);
    if (outdent) {
      // Become sibling of parent.
      if (me.parentId === null) return;
      const parent = tasks.find((t) => t.id === me.parentId);
      if (!parent) return;
      const newParentId = parent.parentId;
      const newOrder = parent.order + 1;
      dispatch(moveTaskCommand(taskId, newParentId, newOrder));
    } else {
      // Indent: become child of previous sibling.
      if (myIdx === null || myIdx <= 0) return;
      const prev = siblings[myIdx - 1]!;
      dispatch(moveTaskCommand(taskId, prev.id, countChildren(prev.id, tasks)));
    }
  };

  const createSibling = (taskId: string) => {
    const tasks = file.tasks;
    const me = tasks.find((t) => t.id === taskId);
    if (!me) return;
    const id = nanoid(10);
    const start = me.start;
    const newTask: Task = {
      id,
      name: t('table.placeholderName'),
      parentId: me.parentId,
      order: me.order + 1,
      start,
      end: start,
      duration: 1,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    // Bump order of all later siblings so the new task slots in.
    const reorder: Command = {
      label: `新增同级任务`,
      apply: (file) => {
        const siblings = file.tasks.filter((x) => x.parentId === me.parentId && x.order > me.order);
        const bumped = file.tasks.map((x) =>
          siblings.some((s) => s.id === x.id) ? { ...x, order: x.order + 1 } : x,
        );
        return { ...file, tasks: [...bumped, newTask] };
      },
      invert: (file) => ({ ...file, tasks: file.tasks.filter((x) => x.id !== id) }),
    };
    dispatch(reorder);
    dispatch(setViewStateCommand({ selectedTaskId: id }));
    renamingId.current = id;
    forceRerender();
  };

  // ---- Drag & drop reorder / reparent (PRD §3.10) ----
  const onDragStart = (e: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
    e.dataTransfer.setData('text/plain', node.task.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>, target: TreeNode) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === target.task.id) return;
    // Can't drop onto own descendant.
    if (target.ancestorIds.includes(draggedId)) return;
    // Place as last child of target (drop "into" target).
    dispatch(moveTaskCommand(draggedId, target.task.id, countChildren(target.task.id, file.tasks)));
  };

  return (
    <div
      className="flex shrink-0 flex-col border-r border-border bg-bg-elevated"
      style={{ width: TABLE_WIDTH }}
    >
      <div
        className="grid border-b border-border bg-bg-elevated text-xs font-semibold text-fg-muted"
        style={{ height: HEADER_HEIGHT, gridTemplateColumns: GRID_TEMPLATE }}
      >
        <div className="border-r border-border px-2 py-1">{t('table.columnWbs')}</div>
        <div className="border-r border-border px-2 py-1">{t('table.columnName')}</div>
        <div className="border-r border-border px-2 py-1">{t('table.columnDuration')}</div>
        <div className="px-2 py-1">{t('table.columnProgress')}</div>
      </div>
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto" onScroll={onScroll}>
        <div className="relative" style={{ height: Math.max(rows.length * ROW_HEIGHT, 0) }}>
          {rows.map((node, i) => {
            const y = i * ROW_HEIGHT;
            const selected = file.viewState.selectedTaskId === node.task.id;
            const isRenaming = renamingId.current === node.task.id;
            return (
              <div
                key={node.task.id}
                role="row"
                tabIndex={0}
                draggable
                onDragStart={(e) => onDragStart(e, node)}
                onDrop={(e) => onDrop(e, node)}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => select(node.task.id)}
                onDoubleClick={() => {
                  select(node.task.id);
                  openDrawer();
                }}
                onKeyDown={(e) => onKeyDown(e, node)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(node.task.id);
                  openContextMenu(node.task.id, e.clientX, e.clientY);
                }}
                onBlur={() => {
                  if (isRenaming) {
                    renamingId.current = null;
                    forceRerender();
                  }
                }}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${y}px)`,
                  gridTemplateColumns: GRID_TEMPLATE,
                }}
                className={cn(
                  'absolute left-0 right-0 grid cursor-pointer items-center border-b border-border text-xs outline-none',
                  'hover:bg-bg',
                  selected && 'bg-bg ring-1 ring-inset ring-primary',
                )}
              >
                <div
                  className="overflow-hidden border-r border-border px-2 text-fg-muted"
                  style={{ paddingLeft: 8 + node.depth * 16 }}
                >
                  {node.wbsNumber}
                </div>
                <div className="min-w-0 truncate border-r border-border px-2 font-medium">
                  {node.task.isMilestone && <span className="mr-1 text-warning">◆</span>}
                  {isRenaming ? (
                    <input
                      autoFocus
                      defaultValue={node.task.name}
                      onBlur={(e) => {
                        dispatch(updateTaskCommand(node.task.id, { name: e.target.value }));
                        renamingId.current = null;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') {
                          if (e.key === 'Enter') {
                            dispatch(
                              updateTaskCommand(node.task.id, {
                                name: (e.target as HTMLInputElement).value,
                              }),
                            );
                          }
                          renamingId.current = null;
                          forceRerender();
                        }
                      }}
                      className="w-full bg-transparent outline-none"
                    />
                  ) : (
                    node.task.name || t('table.placeholderName')
                  )}
                </div>
                <div className="border-r border-border px-2 text-right tabular-nums text-fg-muted">
                  {node.task.isMilestone ? '—' : `${node.task.duration}d`}
                </div>
                <div className="px-2 text-right tabular-nums text-fg-muted">
                  {node.task.progress}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function countChildren(parentId: string, tasks: ReadonlyArray<Task>): number {
  return tasks.filter((t) => t.parentId === parentId).length;
}
