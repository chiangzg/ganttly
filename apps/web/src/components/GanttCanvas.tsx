/**
 * Canvas host component (PRD §3.10).
 *
 * Responsibilities:
 * - Size the canvas to fill the right pane (CSS pixels) and bump its backing
 *   store to devicePixelRatio for crisp Retina rendering (PRD pain point A).
 * - Re-render the scene whenever project data or view state changes.
 * - Forward scroll to projectStore (shared with TaskTable).
 * - Mouse interaction: drag bars, resize handles, draw dependency arrows.
 * - Keyboard: Ctrl+wheel zoom, Delete to delete selection, etc.
 *
 * Interaction handlers translate pointer events to Commands via the engine
 * interaction helpers, then dispatch to projectStore (which also pushes to
 * the undo stack — PRD §3.7).
 */
import { useEffect, useRef, useState } from 'react';
import {
  useProjectStore,
  setViewStateCommand,
  addDependencyCommand,
  updateTaskWithRollupCommand,
} from '@/store/useProjectStore';
import { assembleScene, originDateFor, chartEndDate } from '@/engine/scene';
import { renderScene, resolveThemeColors } from '@/engine/render';
import { todayISO, dateRangeWidth, dateToPixel, pixelsPerDay, dayDiff } from '@/engine/layout';
import { hitTest, applyDrag, type DragState, PAN_THRESHOLD } from '@/engine/interaction';
import type { Scene } from '@/engine/render/types';
import { useViewStore } from '@/store/useViewStore';
import { wouldCreateCycle } from '@/lib/schedule';
import { computeCascadeRollup } from '@/lib/summary';
import { cn } from '@/lib/cn';
import { useHolidayHover } from '@/components/useHolidayHover';
import type { ZoomLevel, DependencyType, Task } from '@ganttly/schema';

export function GanttCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const file = useProjectStore((s) => s.file);
  const dispatch = useProjectStore((s) => s.dispatch);
  const openDrawer = useViewStore((s) => s.openDrawer);
  const [, forceRerender] = useState(0);
  const dragRef = useRef<DragState>({ kind: 'idle' });
  const hoverConnectRef = useRef<string | null>(null);
  // Snapshot of tasks + final geometry for a drag, so pointer-up can dispatch a
  // Command that captures the TRUE pre-drag state (the live cursor-following
  // updates bypass the store's undo stack). See pointer-down / pointer-up.
  const dragSnapshotRef = useRef<{
    taskId: string;
    preDragTasks: Task[];
    final: { start: string; end: string };
  } | null>(null);

  // Keep a fresh scene ref so pointer handlers can read it without re-binding.
  const sceneRef = useRef<Scene | null>(null);

  // Holiday hover tooltip — shared with the resource view (PRD §3.5, §7.3).
  const {
    onHoverMove,
    clearHover,
    tooltip: holidayTooltip,
  } = useHolidayHover({
    getSceneFields: () => {
      const scene = sceneRef.current;
      if (!scene) return null;
      return {
        scrollLeft: scene.scrollLeft,
        originDate: scene.originDate,
        zoom: scene.zoom,
        holidays: scene.holidays,
      };
    },
    viewportWidth: size.width,
  });

  // Latest file kept in a ref so the non-passive wheel listener (added once)
  // can read the current view state without going stale or being re-bound.
  const fileRef = useRef(file);
  fileRef.current = file;

  // Update scroll (horizontal/vertical) directly on the store — bypasses the
  // Command/undo stack because scrolling is ephemeral and should not pollute
  // undo (consistent with the ScrollShim behaviour).
  const setScroll = ({ scrollLeft, scrollTop }: { scrollLeft?: number; scrollTop?: number }) => {
    const f = fileRef.current;
    const next = {
      scrollLeft: scrollLeft ?? f.viewState.scrollLeft,
      scrollTop: scrollTop ?? f.viewState.scrollTop,
    };
    if (next.scrollLeft === f.viewState.scrollLeft && next.scrollTop === f.viewState.scrollTop) {
      return;
    }
    useProjectStore.setState({
      file: { ...f, viewState: { ...f.viewState, ...next } },
    });
  };

  // Native non-passive wheel listener: React's onWheel is passive on some
  // browsers, so we attach our own to support trackpad/mouse panning with
  // preventDefault. Ctrl/Cmd+wheel still zooms.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      const f = fileRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Pinch-zoom on trackpad fires ctrlKey+wheel; let the React onWheel
        // path handle discrete zoom steps.
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
        scrollTop: Math.max(0, f.viewState.scrollTop + dy),
      });
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [dispatch]);

  // Observe container size — drives canvas CSS size.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    });
    ro.observe(container);
    const rect = container.getBoundingClientRect();
    setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    return () => ro.disconnect();
  }, []);

  // Re-render on every change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scene = assembleScene(file, {
      viewportWidth: size.width,
      viewportHeight: size.height,
      today: todayISO(),
    });
    sceneRef.current = scene;
    const theme = resolveThemeColors();
    renderScene({ ctx, scene, theme, dpr, cssWidth: size.width, cssHeight: size.height });
  }, [file, size]);

  // ----- Pointer interaction -----
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(scene, x, y);
    if (hit.kind === 'empty') {
      // Press on empty space: tentatively start a pan. We only "engage" the pan
      // once the pointer moves past PAN_THRESHOLD; if it never does (a click),
      // we clear the selection on pointer-up instead.
      dragRef.current = {
        kind: 'pan',
        startX: x,
        startY: y,
        startScrollLeft: file.viewState.scrollLeft,
        startScrollTop: file.viewState.scrollTop,
        engaged: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    dispatch(setViewStateCommand({ selectedTaskId: hit.taskId }));
    const row = scene.rows.find((r) => r.id === hit.taskId);
    if (!row) return;

    if (hit.kind === 'body') {
      const barXStart = dateToPixel(row.start, scene.originDate, scene.zoom) - scene.scrollLeft;
      const grabOffsetPx = x - barXStart;
      const grabOffsetDays = Math.round(grabOffsetPx / pixelsPerDay(scene.zoom));
      dragRef.current = { kind: 'move', taskId: hit.taskId, grabOffsetDays };
      dragSnapshotRef.current = {
        taskId: hit.taskId,
        preDragTasks: file.tasks,
        final: { start: row.start, end: row.end },
      };
    } else if (hit.kind === 'left-handle') {
      dragRef.current = { kind: 'resize-left', taskId: hit.taskId };
      dragSnapshotRef.current = {
        taskId: hit.taskId,
        preDragTasks: file.tasks,
        final: { start: row.start, end: row.end },
      };
    } else if (hit.kind === 'right-handle') {
      dragRef.current = { kind: 'resize-right', taskId: hit.taskId };
      dragSnapshotRef.current = {
        taskId: hit.taskId,
        preDragTasks: file.tasks,
        final: { start: row.start, end: row.end },
      };
    } else if (hit.kind === 'right-edge') {
      dragRef.current = { kind: 'connect', fromTaskId: hit.taskId };
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // When not dragging, detect holiday hover for the tooltip (PRD §3.5).
    if (dragRef.current.kind === 'idle') {
      onHoverMove(x, y);
      return;
    }

    if (dragRef.current.kind === 'pan') {
      const dx = x - dragRef.current.startX;
      const dy = y - dragRef.current.startY;
      if (!dragRef.current.engaged) {
        if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
        dragRef.current.engaged = true;
      }
      const scrollLeft = Math.max(0, dragRef.current.startScrollLeft + dx);
      const scrollTop = Math.max(0, dragRef.current.startScrollTop + dy);
      setScroll({ scrollLeft, scrollTop });
      return;
    }

    if (dragRef.current.kind === 'connect') {
      // Track which task is under the cursor for the drop preview.
      const hit = hitTest(scene, x, y);
      hoverConnectRef.current = hit.kind === 'empty' ? null : hit.taskId;
      return;
    }

    const row = scene.rows.find((r) => r.id === (dragRef.current as { taskId: string }).taskId);
    if (!row) return;
    const next = applyDrag(scene, row, dragRef.current, x, y);
    if (next) {
      // Track the latest drag geometry so pointer-up knows the final commit.
      if (dragSnapshotRef.current) dragSnapshotRef.current.final = next;
      // Apply a live (non-undoable) update so the bar follows the cursor.
      // The final commit happens on pointer-up via a Command; the snapshot's
      // preDragTasks lets that Command's invert restore the true pre-drag state.
      useProjectStore.setState({
        file: {
          ...file,
          tasks: applyDragWithRollup(file.tasks, row.id, next),
        },
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) {
      dragRef.current = { kind: 'idle' };
      return;
    }
    const drag = dragRef.current;
    dragRef.current = { kind: 'idle' };
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (drag.kind === 'connect') {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = hitTest(scene, x, y);
      if (hit.kind !== 'empty' && hit.taskId !== drag.fromTaskId) {
        const toId = hit.taskId;
        if (!wouldCreateCycle(file.tasks, { successorId: toId, predecessorId: drag.fromTaskId })) {
          const type: DependencyType = e.shiftKey ? 'SS' : 'FS';
          dispatch(addDependencyCommand(toId, { targetId: drag.fromTaskId, type, lag: 0 }));
        } else {
          window.alert('检测到循环依赖,无法创建');
        }
      }
      hoverConnectRef.current = null;
      return;
    }

    if (drag.kind === 'pan') {
      // If we never crossed the threshold, treat it as a click on empty space:
      // clear the selection. Otherwise the pan already updated scroll.
      if (!drag.engaged) {
        dispatch(setViewStateCommand({ selectedTaskId: null }));
      }
      return;
    }

    if (drag.kind === 'move' || drag.kind === 'resize-left' || drag.kind === 'resize-right') {
      const snap = dragSnapshotRef.current;
      dragSnapshotRef.current = null;
      if (!snap) return;
      const { taskId, preDragTasks, final } = snap;

      // No-op if the pointer never moved enough to change geometry.
      const preTask = preDragTasks.find((t) => t.id === taskId);
      if (!preTask || (preTask.start === final.start && preTask.end === final.end)) {
        forceRerender((n) => n + 1);
        return;
      }

      const currentFile = useProjectStore.getState().file;
      const finalDuration = dayDiff(final.start, final.end) + 1;
      useProjectStore.setState({
        file: { ...currentFile, tasks: preDragTasks },
      });
      dispatch(
        updateTaskWithRollupCommand(taskId, {
          start: final.start,
          end: final.end,
          duration: finalDuration,
        }),
      );
    }
  };

  // ----- Double-click to open task drawer -----
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(scene, x, y);
    if (hit.kind !== 'empty') {
      dispatch(setViewStateCommand({ selectedTaskId: hit.taskId }));
      openDrawer();
    }
  };

  // ----- Wheel: Ctrl/Cmd+wheel = zoom, otherwise pan -----
  return (
    <div ref={containerRef} data-gantt-chart className="relative flex-1 overflow-hidden bg-bg">
      <canvas
        ref={canvasRef}
        className={cn(
          'absolute inset-0',
          dragRef.current.kind === 'pan' && dragRef.current.engaged
            ? 'cursor-grabbing'
            : 'cursor-default',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => {
          clearHover();
        }}
      />
      {holidayTooltip}
      <ScrollShim viewportWidth={size.width} />
    </div>
  );
}

function ScrollShim({ viewportWidth }: { viewportWidth: number }) {
  const file = useProjectStore((s) => s.file);
  const scrollLeft = file.viewState.scrollLeft;
  const shimRef = useRef<HTMLDivElement>(null);
  const userScrolling = useRef(false);

  // Total scrollable width = chart extent + current viewport (so there's room
  // to scroll the last column into view). Replaces the old hardcoded 4000.
  const originDate = originDateFor(file);
  const endIso = chartEndDate(file, todayISO());
  const chartWidth = dateRangeWidth(originDate, endIso, file.viewState.zoom);
  const contentWidth = Math.max(chartWidth + viewportWidth, viewportWidth + 100);

  // Reflect store-driven scroll changes (wheel pan, Today button) onto the bar.
  useEffect(() => {
    const el = shimRef.current;
    if (!el || userScrolling.current) return;
    if (Math.abs(el.scrollLeft - scrollLeft) > 1) el.scrollLeft = scrollLeft;
  }, [scrollLeft]);

  return (
    <div
      ref={shimRef}
      className="absolute inset-x-0 bottom-0 overflow-x-auto overflow-y-hidden"
      style={{ height: 12 }}
      onScroll={(e) => {
        const left = e.currentTarget.scrollLeft;
        userScrolling.current = true;
        if (left !== scrollLeft) {
          useProjectStore.setState({
            file: { ...file, viewState: { ...file.viewState, scrollLeft: left } },
          });
        }
        // Release the "user scrolling" flag next tick so the store→DOM sync
        // effect can take over again after the user stops dragging the bar.
        requestAnimationFrame(() => {
          userScrolling.current = false;
        });
      }}
    >
      <div style={{ width: contentWidth, height: 1 }} />
    </div>
  );
}

/**
 * Apply a drag move to `draggedId` and cascade rollup to its ancestor summary
 * tasks. Returns a new tasks array; does not mutate the input. Used for the
 * live (non-undoable) cursor-following update during pointer-move; the final
 * commit happens on pointer-up via a Command.
 */
function applyDragWithRollup(
  tasks: Task[],
  draggedId: string,
  next: { start: string; end: string },
): Task[] {
  // 1. Apply the drag to the target task.
  let result = tasks.map((t) =>
    t.id === draggedId
      ? {
          ...t,
          start: next.start,
          end: next.end,
          duration: dayDiff(next.start, next.end) + 1,
        }
      : t,
  );
  // 2. Cascade rollup to all ancestor summaries. Merge all patches in a single
  //    pass (O(n)) rather than one map per patch.
  const patches = computeCascadeRollup(result, draggedId);
  if (patches.length > 0) {
    const patchMap = new Map(patches.map((p) => [p.id, p.patch]));
    result = result.map((t) => {
      const p = patchMap.get(t.id);
      return p ? { ...t, ...p } : t;
    });
  }
  return result;
}
