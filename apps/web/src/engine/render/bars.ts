/**
 * Task bar renderer (PRD §5.2, M1.12/M1.13).
 *
 * Draws:
 * - Regular task bars with progress fill (rounded rect)
 * - Milestone diamonds (rotated square)
 * - Critical-path coloring override
 * - Selection focus ring
 *
 * Bars are positioned by their start/end date using the layout primitives.
 * The renderer is given pre-flattened rows in row-order; row index N maps
 * to pixel Y = HEADER_HEIGHT + N * ROW_HEIGHT.
 */
import type { Scene, ThemeColors, TaskRow } from './types';
import { COLUMN_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, dateRangeWidth } from '../layout';

const BAR_INSET_Y = 5; // px padding inside row, top/bottom
const BAR_RADIUS = 4;
const MILESTONE_HALF = 9; // half-width of the diamond

export function renderBars(ctx: CanvasRenderingContext2D, scene: Scene, theme: ThemeColors): void {
  const { zoom, originDate, scrollLeft, rows, selectedTaskId, showCriticalPath } = scene;

  rows.forEach((row, index) => {
    const y = HEADER_HEIGHT + index * ROW_HEIGHT;
    // Virtualisation: skip rows entirely outside the viewport.
    if (y + ROW_HEIGHT < HEADER_HEIGHT || y > scene.viewportHeight) return;
    drawRow(ctx, row, y, {
      zoom,
      originDate,
      scrollLeft,
      theme,
      selectedTaskId,
      showCriticalPath,
      viewportWidth: scene.viewportWidth,
    });
  });
}

interface DrawCtx {
  zoom: Scene['zoom'];
  originDate: string;
  scrollLeft: number;
  theme: ThemeColors;
  selectedTaskId: string | null;
  showCriticalPath: boolean;
  viewportWidth: number;
}

function drawRow(ctx: CanvasRenderingContext2D, row: TaskRow, yTop: number, env: DrawCtx): void {
  const xStart = dateToPixel(row.start, env.originDate, env.zoom) - env.scrollLeft;
  const width = Math.max(
    dateRangeWidth(row.start, row.end, env.zoom),
    COLUMN_WIDTH[env.zoom] / 2, // min visible width
  );

  if (row.isSummary) {
    drawSummaryBar(ctx, xStart, yTop, width, row, env);
    return;
  }

  const barColor =
    env.showCriticalPath && row.isCritical ? env.theme.critical : (row.color ?? env.theme.taskBar);
  const progressColor =
    env.showCriticalPath && row.isCritical ? darken(env.theme.critical) : env.theme.taskProgress;

  if (row.isMilestone) {
    drawMilestone(ctx, xStart, yTop + ROW_HEIGHT / 2, barColor, env.theme);
    if (row.id === env.selectedTaskId) {
      drawSelectionRing(ctx, xStart, yTop + ROW_HEIGHT / 2, MILESTONE_HALF + 4, env.theme);
    }
    return;
  }

  // Task bar
  const barY = yTop + BAR_INSET_Y;
  const barH = ROW_HEIGHT - 2 * BAR_INSET_Y;
  drawRoundedRect(ctx, xStart, barY, width, barH, BAR_RADIUS);
  ctx.fillStyle = barColor;
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Progress fill
  if (row.progress > 0) {
    const progressWidth = (width * Math.min(100, Math.max(0, row.progress))) / 100;
    if (progressWidth > 0.5) {
      drawRoundedRect(ctx, xStart, barY, progressWidth, barH, BAR_RADIUS);
      ctx.fillStyle = progressColor;
      ctx.fill();
    }
  }

  // Bar outline (always visible, sharper when selected)
  drawRoundedRect(ctx, xStart, barY, width, barH, BAR_RADIUS);
  ctx.strokeStyle = row.id === env.selectedTaskId ? env.theme.primary : darken(barColor);
  ctx.lineWidth = row.id === env.selectedTaskId ? 2 : 1;
  ctx.stroke();

  // Constraint marker (G5): a small icon at the constrained edge.
  // Start-type constraints (SNET/MSO) → left edge; end-type (MFO/FNLT) → right.
  if (row.constraint) {
    const isStartType =
      row.constraint.type === 'startNoEarlierThan' || row.constraint.type === 'mustStartOn';
    const markerX = isStartType ? xStart : xStart + width;
    const markerColor = row.hasConstraintConflict ? '#f97316' : env.theme.fgMuted; // orange if conflict
    drawConstraintMarker(ctx, markerX, barY, isStartType, markerColor);
  }

  // Label (clipped to viewport; ellipsised if too long)
  const label = row.name;
  if (label) {
    ctx.fillStyle = env.theme.fg;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const labelX = xStart + width + 6;
    // Available label width = right edge of viewport - label start.
    const maxLabelWidth = env.viewportWidth - labelX;
    if (maxLabelWidth > 20) {
      const truncated = ellipsis(ctx, label, Math.max(20, maxLabelWidth));
      ctx.fillText(truncated, labelX, yTop + ROW_HEIGHT / 2);
    }
  }
}

function drawSummaryBar(
  ctx: CanvasRenderingContext2D,
  xStart: number,
  yTop: number,
  width: number,
  row: TaskRow,
  env: DrawCtx,
): void {
  const barColor =
    env.showCriticalPath && row.isCritical ? env.theme.critical : (row.color ?? env.theme.taskBar);
  const progressColor =
    env.showCriticalPath && row.isCritical ? darken(env.theme.critical) : env.theme.taskProgress;

  const summaryBarH = Math.round((ROW_HEIGHT - 2 * BAR_INSET_Y) * 0.45);
  const summaryBarY = yTop + ROW_HEIGHT / 2;
  const darkColor = darken(barColor);

  // Main bar (dark fill)
  drawRoundedRect(ctx, xStart, summaryBarY, width, summaryBarH, 1);
  ctx.fillStyle = darkColor;
  ctx.fill();

  // Progress fill
  if (row.progress > 0) {
    const progressWidth = (width * Math.min(100, Math.max(0, row.progress))) / 100;
    if (progressWidth > 0.5) {
      drawRoundedRect(ctx, xStart, summaryBarY, progressWidth, summaryBarH, 1);
      ctx.fillStyle = progressColor;
      ctx.fill();
    }
  }

  // Down triangles at both ends
  const triSize = 4;
  drawDownTriangle(ctx, xStart, summaryBarY + summaryBarH, triSize, darkColor);
  drawDownTriangle(ctx, xStart + width, summaryBarY + summaryBarH, triSize, darkColor);

  // Label (bold)
  const label = row.name;
  if (label) {
    ctx.fillStyle = env.theme.fg;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const labelX = xStart + width + 6;
    const maxLabelWidth = env.viewportWidth - labelX;
    if (maxLabelWidth > 20) {
      const truncated = ellipsis(ctx, label, Math.max(20, maxLabelWidth));
      ctx.fillText(truncated, labelX, yTop + ROW_HEIGHT / 2);
    }
  }
}

function drawDownTriangle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  size: number,
  color: string,
): void {
  ctx.beginPath();
  ctx.moveTo(cx - size, topY);
  ctx.lineTo(cx + size, topY);
  ctx.lineTo(cx, topY + size);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Draw a constraint marker at the bar edge (G5). A small flag/triangle pointing
 * inward from the constrained side. Start constraints flag the left edge;
 * finish constraints flag the right edge. Orange when the constraint conflicts
 * with a dependency (G4).
 */
function drawConstraintMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  barY: number,
  isStartSide: boolean,
  color: string,
): void {
  const size = 5;
  const y = barY - 1;
  ctx.beginPath();
  if (isStartSide) {
    // Left edge: triangle pointing right into the bar.
    ctx.moveTo(x, y);
    ctx.lineTo(x + size, y + size / 2);
    ctx.lineTo(x, y + size);
  } else {
    // Right edge: triangle pointing left into the bar.
    ctx.moveTo(x, y);
    ctx.lineTo(x - size, y + size / 2);
    ctx.lineTo(x, y + size);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawMilestone(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
  _theme: ThemeColors,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = color;
  ctx.fillRect(-MILESTONE_HALF, -MILESTONE_HALF, MILESTONE_HALF * 2, MILESTONE_HALF * 2);
  ctx.restore();
}

function drawSelectionRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  theme: ThemeColors,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = theme.primary;
  ctx.lineWidth = 2;
  ctx.strokeRect(-radius, -radius, radius * 2, radius * 2);
  ctx.restore();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = text.slice(0, mid) + '…';
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : text.slice(0, lo) + '…';
}

/** Darken a color by ~20%. Accepts hex (#RRGGBB) or rgb(). */
function darken(color: string): string {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1]!, 16);
    const r = Math.floor(((n >> 16) & 0xff) * 0.8);
    const g = Math.floor(((n >> 8) & 0xff) * 0.8);
    const b = Math.floor((n & 0xff) * 0.8);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const rgb = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map((v) => Math.floor(Number(v) * 0.8));
    return `rgb(${r}, ${g}, ${b})`;
  }
  return color;
}
