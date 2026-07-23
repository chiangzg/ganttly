/**
 * Resource load-chart renderer (P1 feature one, G7).
 *
 * Draws per-resource load bars across the same time axis as the Gantt view
 * (shared ZoomLevel + layout coordinates — Q4: zero new pxPerDay duplication).
 * For each working day a resource is loaded, a vertical bar fills from the row
 * baseline upward proportional to load% (absolute scale: the cell height = 100%
 * load, so a bar never exceeds its row). Bars are green when within capacity
 * (load ≤ 100×capacity) and red when overloaded. The 100% capacity line is drawn
 * per row as a reference.
 *
 * Drill-down: when a resource is expanded, task-lane rows (`kind: 'task'`) are
 * interleaved with resource rows. Each lane draws one horizontal rectangle
 * spanning `[task.start, task.end]`, filled with the SAME green/red load-band
 * rule as the daily bars (load ≤ 100×capacity = green, else red), with the
 * resource's `load%` on this task labelled inside. Rows are positioned by their
 * global `yIndex` so lanes line up with the left list.
 *
 * The grid background + header is reused from `renderGrid` by constructing a
 * minimal Scene view (grid only reads zoom/origin/scroll/holidays), keeping
 * the time axis visually identical to the task view.
 */
import type { ResourceScene, Scene, ThemeColors } from './types';
import { HEADER_HEIGHT, ROW_HEIGHT, dateRangeWidth, dateToPixel, pixelsPerDay } from '../layout';
import { renderGrid } from './grid';
import { renderTodayLine } from './overlay';

/** Bar fill colors by load band. */
const GREEN = '#22c55e'; // ≤100% — within capacity
const RED = '#ef4444'; // >100% — overload

export function renderResourceLoad(
  ctx: CanvasRenderingContext2D,
  scene: ResourceScene,
  theme: ThemeColors,
): void {
  const { zoom, originDate, scrollLeft, viewportWidth, viewportHeight } = scene;
  const pxPerDay = pixelsPerDay(zoom);
  const dayBarWidth = Math.max(2, pxPerDay - 1);

  // Reuse the task-view grid (time axis, holidays, header labels) by handing
  // it a minimal Scene projection. renderGrid reads only the fields below.
  const gridScene: Scene = {
    zoom: scene.zoom,
    originDate: scene.originDate,
    scrollLeft: scene.scrollLeft,
    scrollTop: scene.scrollTop, // so horizontal row separators follow the rows (aligned with ResourceList)
    viewportWidth: scene.viewportWidth,
    viewportHeight: scene.viewportHeight,
    today: scene.today,
    holidays: scene.holidays,
    rows: [],
    totalRows: 0,
    arrows: [],
    showCriticalPath: false,
    selectedTaskId: null,
  };
  renderGrid(ctx, gridScene, theme);
  // Today line (PRD §3.10) — keep it visible in the resource view too, over the
  // grid but under the load bars, mirroring renderScene's layer order.
  renderTodayLine(ctx, gridScene, theme);

  // Row virtualization: only draw rows intersecting the viewport. Rows carry
  // their own global yIndex; since the array is dense and 0-indexed, the loop
  // index == yIndex, but we read row.yIndex for positioning to stay robust.
  const firstRow = Math.max(0, Math.floor(scene.scrollTop / ROW_HEIGHT));
  const lastRow = Math.min(
    scene.rows.length - 1,
    Math.ceil((scene.scrollTop + viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT),
  );

  for (let r = firstRow; r <= lastRow; r++) {
    const row = scene.rows[r];
    if (!row) continue;
    const rowTop = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
    const rowBottom = rowTop + ROW_HEIGHT;

    if (row.kind === 'task-header') {
      // The column labels live in ResourceList. Keep the corresponding chart
      // row visually quiet while preserving the shared row pitch/alignment.
      ctx.fillStyle = theme.bgElevated;
      ctx.globalAlpha = 0.72;
      ctx.fillRect(0, rowTop, viewportWidth, ROW_HEIGHT);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.border;
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(0, rowTop + 0.5);
      ctx.lineTo(viewportWidth, rowTop + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }

    if (row.kind === 'task') {
      renderTaskLane(ctx, row, {
        zoom,
        originDate,
        scrollLeft,
        viewportWidth,
        rowTop,
        selected: scene.selectedTaskIdInResource === row.taskId,
        theme,
      });
      continue;
    }

    // --- Resource row (kind: 'resource') ---
    const capacity = row.capacity;
    const selected = scene.selectedResourceId === row.id;

    // Selection highlight band.
    if (selected) {
      ctx.fillStyle = theme.primary;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(0, rowTop, viewportWidth, ROW_HEIGHT);
      ctx.globalAlpha = 1;
    }

    // Capacity reference line at 100% (full capacity height).
    const fullBarHeight = ROW_HEIGHT - 6;
    const capacityY = rowBottom - 3 - fullBarHeight * capacity;
    ctx.strokeStyle = theme.fgMuted;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, capacityY);
    ctx.lineTo(viewportWidth, capacityY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Load bars.
    for (const bar of row.bars) {
      const x = dateToPixel(bar.date, originDate, zoom) - scrollLeft;
      if (x + dayBarWidth < 0 || x > viewportWidth) continue;
      // Absolute scale: the cell height represents 100% load regardless of the
      // resource's capacity, so the bar can NEVER exceed the row vertically.
      // (Previously height was scaled by capacity + a stacked red spike, which
      // overflowed the cell at capacity≈1.0 and visually shrank bars for
      // part-time resources — and divided by zero at capacity=0.)
      const ratio = Math.min(bar.load / 100, 1); // height caps at 100% load = cell top
      const barH = fullBarHeight * ratio; // ≤ fullBarHeight, always fits the cell
      const overload = bar.load > 100 * capacity; // capacity only affects the color threshold
      ctx.fillStyle = overload ? RED : GREEN;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 0.5, rowBottom - 3 - barH, dayBarWidth, barH);
      ctx.globalAlpha = 1;

      // R4.1: load percentage label — anchored at the TOP INSIDE of the bar:
      // it stays inside the bar and rides up as the bar grows (anchored to the
      // bar's top edge, not the row baseline), so low-capacity resources don't
      // drop the label to the bottom. White reads on both green and red fills
      // (only drawn when the bar is wide enough).
      if (dayBarWidth >= 20) {
        ctx.fillStyle = '#fff';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const barTop = rowBottom - 3 - barH;
        ctx.fillText(`${Math.round(bar.load)}%`, x + dayBarWidth / 2, barTop + 2);
      }
    }
  }
}

/** Draw a single task-lane row: a load-colored rectangle over [start, end]. */
function renderTaskLane(
  ctx: CanvasRenderingContext2D,
  row: Extract<ResourceScene['rows'][number], { kind: 'task' }>,
  opts: {
    zoom: ResourceScene['zoom'];
    originDate: string;
    scrollLeft: number;
    viewportWidth: number;
    rowTop: number;
    selected: boolean;
    theme: ThemeColors;
  },
): void {
  const { zoom, originDate, scrollLeft, viewportWidth, rowTop, selected, theme } = opts;

  // Selection highlight band (mirrors resource-row selection).
  if (selected) {
    ctx.fillStyle = theme.primary;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(0, rowTop, viewportWidth, ROW_HEIGHT);
    ctx.globalAlpha = 1;
  }

  if (row.isMilestone) {
    // Milestone: draw a diamond marker at the start date instead of a span.
    const cx = dateToPixel(row.start, originDate, zoom) - scrollLeft + pixelsPerDay(zoom) / 2;
    const cy = rowTop + ROW_HEIGHT / 2;
    const half = 5;
    ctx.fillStyle = theme.warning;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(cx, cy - half);
    ctx.lineTo(cx + half, cy);
    ctx.lineTo(cx, cy + half);
    ctx.lineTo(cx - half, cy);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  const x = dateToPixel(row.start, originDate, zoom) - scrollLeft;
  const w = Math.max(2, dateRangeWidth(row.start, row.end, zoom));
  if (x + w < 0 || x > viewportWidth) return;

  // Fill the lane rectangle with the load-band color (green ≤ cap, red > cap).
  const padY = 5;
  const rectTop = rowTop + padY;
  const rectH = ROW_HEIGHT - padY * 2;
  const overload = row.load > 100 * row.capacity;
  ctx.fillStyle = overload ? RED : GREEN;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(x + 0.5, rectTop, w, rectH);
  ctx.globalAlpha = 1;

  // load% label inside the rectangle (white reads on both fills), only when the
  // rectangle is wide enough — mirrors the daily-bar label policy.
  if (w >= 24) {
    ctx.fillStyle = '#fff';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(row.load)}%`, x + 6, rowTop + ROW_HEIGHT / 2);
  }
}
