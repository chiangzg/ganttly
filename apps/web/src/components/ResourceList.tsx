/**
 * Resource list — the left pane of the resource view (P1 feature one, G7).
 *
 * Mirrors TaskTable's layout and vertical-scroll-sync contract so that rows
 * align pixel-for-pixel with ResourceLoadCanvas on the right:
 * - Shared `ROW_HEIGHT` (32) / `HEADER_HEIGHT` (56) from `@/engine/layout`.
 * - Scroll writes to `useViewStore.resourceScrollTop` (G19: independent of the
 *   task view's `file.viewState.scrollTop`, because row counts differ).
 *
 * The right pane (ResourceLoadCanvas) reads `resourceScrollTop` and renders
 * with the same row pitch, exactly as GanttCanvas follows TaskTable.
 *
 * Drill-down: clicking a resource's expand arrow inserts task lanes beneath
 * it (WBS | name | duration | progress, indented). The flattened row list
 * (resources + expanded task lanes) drives BOTH this list and the canvas, so
 * both panes share identical total height and row indices.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { Task } from '@ganttly/schema';
import {
  useProjectStore,
  addResourceCommand,
  deleteResourceCommand,
  updateResourceCommand,
  setViewStateCommand,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { buildTree } from '@/engine/scene/tree';
import { tasksByResource } from '@/lib/resourceTasks';
import { cn } from '@/lib/cn';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';

const TABLE_WIDTH = 280;
const GRID_TEMPLATE = 'minmax(0, 1fr) 80px 56px 28px';
/** Task-lane grid: expand arrow | WBS | name | duration | progress. */
const TASK_GRID_TEMPLATE = '20px 44px minmax(0, 1fr) 52px 44px';

export function ResourceList() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const resourceScrollTop = useViewStore((s) => s.resourceScrollTop);
  const setResourceScrollTop = useViewStore((s) => s.setResourceScrollTop);
  const selectedResourceId = useViewStore((s) => s.selectedResourceId);
  const setSelectedResourceId = useViewStore((s) => s.setSelectedResourceId);
  const expandedResourceIds = useViewStore((s) => s.expandedResourceIds);
  const toggleResourceExpanded = useViewStore((s) => s.toggleResourceExpanded);
  const selectedTaskIdInResource = useViewStore((s) => s.selectedTaskIdInResource);
  const setSelectedTaskIdInResource = useViewStore((s) => s.setSelectedTaskIdInResource);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Leaf-task reverse lookup (consistent with computeResourceLoad's leaf rule).
  const tasksByRes = useMemo(() => {
    const tree = buildTree(file.tasks);
    const childSet = new Set<string>();
    const walk = (nodes: ReadonlyArray<(typeof tree)[number]>): void => {
      for (const n of nodes) {
        if (n.children.length > 0) childSet.add(n.task.id);
        walk(n.children);
      }
    };
    walk(tree);
    const wbsByTaskId = new Map<string, string>();
    const indexWbs = (nodes: ReadonlyArray<(typeof tree)[number]>): void => {
      for (const n of nodes) {
        wbsByTaskId.set(n.task.id, n.wbsNumber);
        indexWbs(n.children);
      }
    };
    indexWbs(tree);
    const map = tasksByResource(file.tasks, (id) => childSet.has(id));
    return { map, wbsByTaskId };
  }, [file.tasks]);

  // Flattened rows (resources + expanded task lanes), shared with the canvas
  // so both panes use the same row count and y positions.
  type FlatRow =
    | { kind: 'resource'; resourceId: string; yIndex: number }
    | { kind: 'task'; resourceId: string; task: Task; yIndex: number };
  const flatRows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = [];
    let yIndex = 0;
    for (const r of file.resources) {
      out.push({ kind: 'resource', resourceId: r.id, yIndex: yIndex++ });
      if (expandedResourceIds.has(r.id)) {
        const list = tasksByRes.map.get(r.id) ?? [];
        for (const task of list) {
          out.push({ kind: 'task', resourceId: r.id, task, yIndex: yIndex++ });
        }
      }
    }
    return out;
  }, [file.resources, expandedResourceIds, tasksByRes]);

  // Reflect store-driven scroll changes onto this panel (mirrors TaskTable).
  const localScrolling = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || localScrolling.current) return;
    if (Math.abs(el.scrollTop - resourceScrollTop) > 1) {
      el.scrollTop = resourceScrollTop;
    }
  }, [resourceScrollTop]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    localScrolling.current = true;
    if (top !== resourceScrollTop) setResourceScrollTop(top);
    requestAnimationFrame(() => {
      localScrolling.current = false;
    });
  };

  const addResource = () => {
    const id = nanoid(10);
    dispatch(
      addResourceCommand({
        id,
        name: t('resource.placeholderName'),
        capacity: 1.0,
      }),
    );
    setSelectedResourceId(id);
  };

  const removeResource = (resourceId: string) => {
    dispatch(deleteResourceCommand(resourceId));
    if (selectedResourceId === resourceId) setSelectedResourceId(null);
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
        <div className="border-r border-border px-2 py-1">{t('resource.columnName')}</div>
        <div className="border-r border-border px-2 py-1">{t('resource.columnRole')}</div>
        <div className="border-r border-border px-2 py-1">{t('resource.columnCapacity')}</div>
        <div className="px-2 py-1" />
      </div>
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto" onScroll={onScroll}>
        <div className="relative" style={{ height: Math.max(flatRows.length * ROW_HEIGHT, 0) }}>
          {flatRows.map((row) => {
            const y = row.yIndex * ROW_HEIGHT;
            if (row.kind === 'resource') {
              const r = file.resources.find((res) => res.id === row.resourceId);
              if (!r) return null;
              const selected = selectedResourceId === r.id;
              const taskCount = tasksByRes.map.get(r.id)?.length ?? 0;
              const expanded = expandedResourceIds.has(r.id);
              return (
                <div
                  key={`r-${r.id}`}
                  role="row"
                  tabIndex={0}
                  onClick={() => setSelectedResourceId(r.id)}
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
                  <div className="flex items-center overflow-hidden border-r border-border px-1">
                    {taskCount > 0 && (
                      <button
                        type="button"
                        title={expanded ? t('resource.collapse') : t('resource.expand')}
                        className="mr-1 inline-flex shrink-0 items-center justify-center text-[10px] text-fg-muted hover:text-fg"
                        style={{ width: 14, height: 14 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleResourceExpanded(r.id);
                        }}
                      >
                        {expanded ? '▼' : '▶'}
                      </button>
                    )}
                    <input
                      className="min-w-0 flex-1 truncate bg-transparent px-1 outline-none focus:bg-bg"
                      value={r.name}
                      title={r.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        dispatch(updateResourceCommand(r.id, { name: e.target.value }))
                      }
                    />
                  </div>
                  <input
                    className="truncate border-r border-border bg-transparent px-2 text-fg-muted outline-none focus:bg-bg"
                    value={r.role ?? ''}
                    placeholder="—"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      dispatch(updateResourceCommand(r.id, { role: e.target.value }))
                    }
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={10}
                    className="border-r border-border bg-transparent px-2 text-fg-muted outline-none focus:bg-bg"
                    value={Math.round((r.capacity ?? 1) * 100)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      dispatch(
                        updateResourceCommand(r.id, {
                          capacity: Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100)),
                        }),
                      )
                    }
                  />
                  <button
                    className="px-1 text-fg-muted hover:text-destructive"
                    title={t('resource.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeResource(r.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            }
            // Task lane row — mirrors TaskTable's 4-column row.
            const task = row.task;
            const selected = selectedTaskIdInResource === task.id;
            const wbs = tasksByRes.wbsByTaskId.get(task.id) ?? '';
            return (
              <div
                key={`t-${row.resourceId}-${task.id}`}
                role="row"
                tabIndex={0}
                onClick={() => setSelectedTaskIdInResource(task.id)}
                onDoubleClick={() => {
                  // TaskDrawer reads file.viewState.selectedTaskId, so set it
                  // at open time. The lane highlight stays on the resource-view
                  // selection (selectedTaskIdInResource), independent per G19.
                  dispatch(setViewStateCommand({ selectedTaskId: task.id }));
                  openDrawer();
                }}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${y}px)`,
                  gridTemplateColumns: TASK_GRID_TEMPLATE,
                }}
                className={cn(
                  'absolute left-0 right-0 grid cursor-pointer items-center border-b border-border text-xs outline-none',
                  'hover:bg-bg',
                  selected && 'bg-bg ring-1 ring-inset ring-primary',
                )}
              >
                <div className="flex items-center justify-center text-fg-muted">
                  <span className="text-[10px]">•</span>
                </div>
                <div className="overflow-hidden border-r border-border px-1 text-right tabular-nums text-fg-muted">
                  {wbs}
                </div>
                <div className="min-w-0 truncate border-r border-border px-2 font-medium">
                  {task.isMilestone && <span className="mr-1 text-warning">◆</span>}
                  {task.name || t('table.placeholderName')}
                </div>
                <div className="border-r border-border px-1 text-right tabular-nums text-fg-muted">
                  {task.isMilestone ? '—' : `${task.duration}d`}
                </div>
                <div className="px-1 text-right tabular-nums text-fg-muted">{task.progress}%</div>
              </div>
            );
          })}
        </div>
      </div>
      <button
        className="border-t border-border px-2 py-1 text-left text-xs text-primary hover:bg-bg"
        onClick={addResource}
      >
        + {t('resource.add')}
      </button>
    </div>
  );
}
