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
 */
import { useEffect, useRef } from 'react';
import {
  useProjectStore,
  addResourceCommand,
  deleteResourceCommand,
  updateResourceCommand,
} from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';
import { cn } from '@/lib/cn';
import { nanoid } from 'nanoid';
import { useTranslation } from 'react-i18next';

const TABLE_WIDTH = 280;
const GRID_TEMPLATE = 'minmax(0, 1fr) 80px 56px 28px';

export function ResourceList() {
  const { t } = useTranslation();
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const resourceScrollTop = useViewStore((s) => s.resourceScrollTop);
  const setResourceScrollTop = useViewStore((s) => s.setResourceScrollTop);
  const selectedResourceId = useViewStore((s) => s.selectedResourceId);
  const setSelectedResourceId = useViewStore((s) => s.setSelectedResourceId);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        <div
          className="relative"
          style={{ height: Math.max(file.resources.length * ROW_HEIGHT, 0) }}
        >
          {file.resources.map((r, i) => {
            const y = i * ROW_HEIGHT;
            const selected = selectedResourceId === r.id;
            return (
              <div
                key={r.id}
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
                <input
                  className="truncate border-r border-border bg-transparent px-2 outline-none focus:bg-bg"
                  value={r.name}
                  title={r.name}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => dispatch(updateResourceCommand(r.id, { name: e.target.value }))}
                />
                <input
                  className="truncate border-r border-border bg-transparent px-2 text-fg-muted outline-none focus:bg-bg"
                  value={r.role ?? ''}
                  placeholder="—"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => dispatch(updateResourceCommand(r.id, { role: e.target.value }))}
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
