/**
 * Resource load-chart canvas — the right pane of the resource view (P1, G7).
 *
 * Shares the time axis with the task view (same ZoomLevel, originDate,
 * scrollLeft from `file.viewState`) so columns align pixel-for-pixel. Vertical
 * scroll writes to `useViewStore.resourceScrollTop` (G19: independent of the
 * task view). The left pane (ResourceList) reads the same scrollTop and aligns
 * rows, mirroring the TaskTable ↔ GanttCanvas contract.
 */
import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/store/useProjectStore';
import { useViewStore } from '@/store/useViewStore';
import { assembleResourceScene, originDateFor, chartEndDate } from '@/engine/scene';
import { renderResourceLoad, resolveThemeColors } from '@/engine/render';
import { todayISO, pixelsPerDay, dayDiff, ROW_HEIGHT } from '@/engine/layout';

export function ResourceLoadCanvas() {
  const file = useProjectStore((s) => s.file);
  const resourceScrollTop = useViewStore((s) => s.resourceScrollTop);
  const setResourceScrollTop = useViewStore((s) => s.setResourceScrollTop);
  const selectedResourceId = useViewStore((s) => s.selectedResourceId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

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
    });

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    // Apply DPR transform so the renderer draws in CSS pixels (mirrors renderScene).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    renderResourceLoad(ctx, scene, resolveThemeColors());
  }, [file, size, resourceScrollTop, selectedResourceId]);

  // Horizontal scroll extent mirrors GanttCanvas's ScrollShim: span the date range.
  const origin = originDateFor(file);
  const end = chartEndDate(file, todayISO());
  const totalWidth = Math.max(
    size.width,
    Math.ceil(pixelsPerDay(file.viewState.zoom) * Math.max(0, dayDiff(origin, end))) + 1,
  );

  // Horizontal scroll writes to file.viewState.scrollLeft (shared with the task
  // view so the time axis stays aligned across view switches — G19).
  const setScrollLeft = (left: number) => {
    useProjectStore.setState({
      file: { ...file, viewState: { ...file.viewState, scrollLeft: left } },
    });
  };

  return (
    <div ref={wrapRef} className="relative flex-1 overflow-hidden">
      <div
        className="absolute inset-0 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => setResourceScrollTop(e.currentTarget.scrollTop)}
      >
        {/* Spacer to give vertical scroll the full resource-row height. */}
        <div style={{ height: Math.max(file.resources.length * ROW_HEIGHT, 1), width: 1 }} />
      </div>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0"
        style={{ width: size.width, height: size.height }}
      />
      {/* Horizontal scroll shim — mirrors GanttCanvas; writes scrollLeft to viewState. */}
      <div
        className="absolute bottom-0 left-0 right-0 h-3 overflow-x-auto overflow-y-hidden"
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div style={{ width: totalWidth, height: 1 }} />
      </div>
    </div>
  );
}
