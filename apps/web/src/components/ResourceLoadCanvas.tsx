/**
 * Resource load-chart canvas — the right pane of the resource view (P1, G7).
 *
 * Shares the time axis with the task view (same ZoomLevel, originDate,
 * scrollLeft from `file.viewState`) so columns align pixel-for-pixel. Vertical
 * scroll writes to `useViewStore.resourceScrollTop` (G19: independent of the
 * task view). The left pane (ResourceList) reads the same scrollTop and aligns
 * rows, mirroring the TaskTable ↔ GanttCanvas contract.
 *
 * Scrolling mirrors GanttCanvas (task view) exactly so both panes behave the
 * same under trackpad / mouse / drag:
 * - A native NON-passive `wheel` listener (React's onWheel is passive on some
 *   browsers, which would block preventDefault) translates deltaX/deltaY into
 *   scroll updates; Ctrl/Cmd+wheel zooms.
 * - Pointer-drag on empty space pans both axes (past PAN_THRESHOLD).
 * - The bottom 12px horizontal shim is a real overflow-x-auto bar, kept in
 *   sync with the store via a `userScrolling` feedback guard (so the Today
 *   button and wheel-pan both move the thumb).
 *
 * There is intentionally NO vertical scroll shim here: the left pane
 * (ResourceList) owns the vertical scrollbar, exactly as TaskTable owns it for
 * the task view. Vertical scroll state still lives in `useViewStore` and both
 * panes render offset by the same value.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore, setViewStateCommand } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { assembleResourceScene, originDateFor, chartEndDate } from '@/engine/scene';
import { renderResourceLoad, resolveThemeColors } from '@/engine/render';
import { todayISO, dateRangeWidth, ROW_HEIGHT } from '@/engine/layout';
import { buildTree } from '@/engine/scene/tree';
import { tasksByResource } from '@/lib/resourceTasks';
import { PAN_THRESHOLD } from '@/engine/interaction';
import { cn } from '@/lib/cn';
import type { ZoomLevel } from '@ganttly/schema';

/** Active drag interaction on the canvas. */
type DragState =
  | { kind: 'idle' }
  | {
      kind: 'pan';
      startX: number;
      startY: number;
      startScrollLeft: number;
      startScrollTop: number;
      engaged: boolean;
    };

export function ResourceLoadCanvas() {
  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const resourceScrollTop = useViewStore((s) => s.resourceScrollTop);
  const setResourceScrollTop = useViewStore((s) => s.setResourceScrollTop);
  const selectedResourceId = useViewStore((s) => s.selectedResourceId);
  const expandedResourceIds = useViewStore((s) => s.expandedResourceIds);
  const selectedTaskIdInResource = useViewStore((s) => s.selectedTaskIdInResource);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<DragState>({ kind: 'idle' });

  // Latest file/scrollTop kept in refs so the once-bound native wheel listener
  // and pointer handlers can read current state without going stale or being
  // re-bound every render (mirrors GanttCanvas's fileRef pattern).
  const fileRef = useRef(file);
  fileRef.current = file;
  const scrollTopRef = useRef(resourceScrollTop);
  scrollTopRef.current = resourceScrollTop;

  // Observe the wrapper size so the canvas matches its CSS box.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Update scroll (horizontal/vertical). Horizontal writes to
  // `file.viewState.scrollLeft` (shared with the task view so the time axis
  // stays aligned across view switches — G19). Vertical writes to
  // `useViewStore.resourceScrollTop` (G19: independent of task-view scrollTop).
  // Both bypass the Command/undo stack because scrolling is ephemeral, exactly
  // as GanttCanvas's setScroll does for the task view.
  const setScroll = ({ scrollLeft, scrollTop }: { scrollLeft?: number; scrollTop?: number }) => {
    const f = fileRef.current;
    const curTop = scrollTopRef.current;
    const nextLeft = scrollLeft ?? f.viewState.scrollLeft;
    const nextTop = scrollTop ?? curTop;
    if (nextLeft === f.viewState.scrollLeft && nextTop === curTop) return;
    if (nextLeft !== f.viewState.scrollLeft) {
      useProjectStore.setState({
        file: { ...f, viewState: { ...f.viewState, scrollLeft: nextLeft } },
      });
    }
    if (nextTop !== curTop) {
      setResourceScrollTop(Math.max(0, nextTop));
    }
  };

  // Latest scene row count, kept in a ref so the spacer height (rendered
  // outside this effect) stays in sync with the flattened rows the renderer
  // actually sees (resources + expanded task lanes).
  const rowCountRef = useRef(0);

  // Render whenever inputs that affect the picture change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scene = assembleResourceScene(file, {
      viewportWidth: size.width,
      viewportHeight: size.height,
      today: todayISO(),
      scrollTop: resourceScrollTop,
      selectedResourceId,
      expandedResourceIds,
      selectedTaskIdInResource,
    });
    rowCountRef.current = scene.rows.length;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    // Apply DPR transform so the renderer draws in CSS pixels (mirrors renderScene).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    renderResourceLoad(ctx, scene, resolveThemeColors());
  }, [
    file,
    size,
    resourceScrollTop,
    selectedResourceId,
    expandedResourceIds,
    selectedTaskIdInResource,
  ]);

  // Native non-passive wheel listener: React's onWheel is passive on some
  // browsers, so we attach our own to support trackpad/mouse panning with
  // preventDefault. Ctrl/Cmd+wheel zooms. Mirrors GanttCanvas.tsx:95-123.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const f = fileRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Pinch-zoom on trackpad fires ctrlKey+wheel; Ctrl/Cmd+wheel zooms.
        e.preventDefault();
        const order: ZoomLevel[] = ['day', 'week', 'month', 'year'];
        const idx = order.indexOf(f.viewState.zoom);
        const next = order[Math.max(0, Math.min(order.length - 1, idx + (e.deltaY > 0 ? 1 : -1)))];
        if (next) dispatch(setViewStateCommand({ zoom: next }));
        return;
      }
      e.preventDefault();
      // Trackpads emit deltaX for horizontal gestures; mouse wheels emit only
      // deltaY (Shift+wheel = horizontal). Combine both signals.
      const dx = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      const dy = e.shiftKey ? 0 : e.deltaY;
      if (dx === 0 && dy === 0) return;
      setScroll({
        scrollLeft: Math.max(0, f.viewState.scrollLeft + dx),
        scrollTop: Math.max(0, scrollTopRef.current + dy),
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [dispatch]);

  // ----- Pointer drag-to-pan (mirrors GanttCanvas pan path, simplified) -----
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    dragRef.current = {
      kind: 'pan',
      startX: x,
      startY: y,
      startScrollLeft: file.viewState.scrollLeft,
      startScrollTop: resourceScrollTop,
      engaged: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.kind !== 'pan') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - dragRef.current.startX;
    const dy = y - dragRef.current.startY;
    if (!dragRef.current.engaged) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
      dragRef.current.engaged = true;
    }
    setScroll({
      scrollLeft: Math.max(0, dragRef.current.startScrollLeft + dx),
      scrollTop: Math.max(0, dragRef.current.startScrollTop + dy),
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.kind === 'pan') {
      dragRef.current = { kind: 'idle' };
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // Horizontal scroll extent mirrors GanttCanvas's ScrollShim: span the date range.
  const origin = originDateFor(file);
  const end = chartEndDate(file, todayISO());
  const chartWidth = dateRangeWidth(origin, end, file.viewState.zoom);
  const totalWidth = Math.max(chartWidth + size.width, size.width + 100);

  // Total flattened row count (resources + expanded task lanes). MUST match
  // ResourceList's computation so both panes share identical total height and
  // the vertical scrollbar/thumb stays aligned with the content.
  const rowCount = useMemo(() => {
    const tree = buildTree(file.tasks);
    const childSet = new Set<string>();
    const walk = (nodes: ReadonlyArray<(typeof tree)[number]>): void => {
      for (const n of nodes) {
        if (n.children.length > 0) childSet.add(n.task.id);
        walk(n.children);
      }
    };
    walk(tree);
    const map = tasksByResource(file.tasks, (id) => childSet.has(id));
    let count = file.resources.length;
    for (const r of file.resources) {
      if (expandedResourceIds.has(r.id)) count += map.get(r.id)?.length ?? 0;
    }
    return count;
  }, [file.tasks, file.resources, expandedResourceIds]);

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative flex-1 overflow-hidden bg-bg',
        dragRef.current.kind === 'pan' && dragRef.current.engaged
          ? 'cursor-grabbing'
          : 'cursor-default',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Spacer reserves the full vertical scroll height so the store-driven
          scrollTop stays clamped to real content height. (The visible vertical
          scrollbar lives in ResourceList on the left, mirroring TaskTable.) */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ height: Math.max(rowCount * ROW_HEIGHT, 0) }}
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0"
        style={{ width: size.width, height: size.height }}
      />
      {/* Horizontal scroll shim — mirrors GanttCanvas's ScrollShim; keeps the
          thumb in sync with the store (incl. Today button / wheel pan) via the
          userScrolling guard to avoid feedback loops. */}
      <HorizontalScrollShim totalWidth={totalWidth} viewportWidth={size.width} />
    </div>
  );
}

/**
 * Horizontal scrollbar proxy for the resource canvas. A thin (12px) real
 * `overflow-x-auto` strip overlaid at the bottom, bidirectionally synced to
 * `file.viewState.scrollLeft`. The `userScrolling` ref breaks the store→DOM→
 * store feedback loop, mirroring GanttCanvas's ScrollShim.
 */
function HorizontalScrollShim({
  totalWidth,
  viewportWidth,
}: {
  totalWidth: number;
  viewportWidth: number;
}) {
  const file = useProjectStore((s) => s.file);
  const scrollLeft = file.viewState.scrollLeft;
  const shimRef = useRef<HTMLDivElement>(null);
  const userScrolling = useRef(false);
  // Spacer must exceed the viewport so the last column can scroll into view.
  const contentWidth = Math.max(totalWidth, viewportWidth + 100);

  // Reflect store-driven scroll changes (wheel pan, Today button) onto the bar.
  useEffect(() => {
    const el = shimRef.current;
    if (!el || userScrolling.current) return;
    if (Math.abs(el.scrollLeft - scrollLeft) > 1) el.scrollLeft = scrollLeft;
  }, [scrollLeft]);

  return (
    <div
      ref={shimRef}
      className="absolute bottom-0 left-0 right-0 overflow-x-auto overflow-y-hidden"
      style={{ height: 12 }}
      onScroll={(e) => {
        const left = e.currentTarget.scrollLeft;
        userScrolling.current = true;
        if (left !== scrollLeft) {
          useProjectStore.setState({
            file: { ...file, viewState: { ...file.viewState, scrollLeft: left } },
          });
        }
        // Release the guard next tick so the store→DOM sync effect can take
        // over again after the user stops dragging the bar.
        requestAnimationFrame(() => {
          userScrolling.current = false;
        });
      }}
    >
      <div style={{ width: contentWidth, height: 1 }} />
    </div>
  );
}
