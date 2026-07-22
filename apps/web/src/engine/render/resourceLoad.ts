/**
 * Resource load-chart renderer (P1 feature one, G7).
 *
 * Draws per-resource load bars across the same time axis as the Gantt view
 * (shared ZoomLevel + layout coordinates — Q4: zero new pxPerDay duplication).
 * For each working day a resource is loaded, a vertical bar fills from the row
 * baseline upward proportional to load%. Bars are green ≤100% (capacity) and
 * red >100% (overload). The 100% capacity line is drawn per row as a reference.
 *
 * The grid background + header is reused from `renderGrid` by constructing a
 * minimal Scene view (grid only reads zoom/origin/scroll/holidays), keeping
 * the time axis visually identical to the task view.
 */
import type { ResourceScene, Scene, ThemeColors } from './types';
import { HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, pixelsPerDay } from '../layout';
import { renderGrid } from './grid';

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
  const barWidth = Math.max(2, pxPerDay - 1);

  // Reuse the task-view grid (time axis, holidays, header labels) by handing
  // it a minimal Scene projection. renderGrid reads only the fields below.
  const gridScene: Scene = {
    zoom: scene.zoom,
    originDate: scene.originDate,
    scrollLeft: scene.scrollLeft,
    scrollTop: 0, // grid rows are independent of scroll
    viewportWidth: scene.viewportWidth,
    viewportHeight: scene.viewportHeight,
    today: scene.today,
    holidays: scene.holidays,
    rows: [],
    arrows: [],
    showCriticalPath: false,
    selectedTaskId: null,
  };
  renderGrid(ctx, gridScene, theme);

  // Row virtualization: only draw rows intersecting the viewport.
  const firstRow = Math.max(0, Math.floor(scene.scrollTop / ROW_HEIGHT));
  const lastRow = Math.min(
    scene.rows.length - 1,
    Math.ceil((scene.scrollTop + viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT),
  );

  for (let r = firstRow; r <= lastRow; r++) {
    const row = scene.rows[r];
    if (!row) continue;
    const rowTop = HEADER_HEIGHT + r * ROW_HEIGHT - scene.scrollTop;
    const rowBottom = rowTop + ROW_HEIGHT;
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
      if (x + barWidth < 0 || x > viewportWidth) continue;
      const ratio = Math.min(bar.load / 100, 1.5); // cap visual at 150%
      const barH = fullBarHeight * Math.min(ratio, capacity);
      const overload = bar.load > 100 * capacity;
      ctx.fillStyle = overload ? RED : GREEN;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 0.5, rowBottom - 3 - barH, barWidth, barH);
      // Overload spike: the portion above capacity in solid red.
      if (overload) {
        const overloadRatio = Math.min((bar.load / 100 - capacity) / capacity, 0.5);
        const oh = fullBarHeight * capacity * overloadRatio;
        ctx.globalAlpha = 1;
        ctx.fillRect(x + 0.5, rowBottom - 3 - barH - oh, barWidth, oh);
      }
      ctx.globalAlpha = 1;

      // R4.1: load percentage label above the bar (only when wide enough).
      if (barWidth >= 20) {
        ctx.fillStyle = overload ? RED : theme.fgMuted;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const labelY = rowBottom - 3 - barH - (overload ? 10 : 2);
        ctx.fillText(`${Math.round(bar.load)}%`, x + barWidth / 2, labelY);
      }
    }
  }
}
