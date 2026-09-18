/**
 * Task bar renderer (PRD §5.2, M1.12/M1.13; chain visuals: dependency-chain
 * spec §3).
 *
 * Draws:
 * - Regular task bars with progress fill (rounded rect)
 * - Milestone diamonds (rotated square)
 * - Critical-path coloring override
 * - Selection focus ring
 * - Dependency-chain accents + spotlight dimming (chain spec §3.4/§3.5):
 *   chain rows get a direction-colored 2px outline (upstream emerald /
 *   downstream cyan), the origin keeps its primary selection ring plus a
 *   breathing halo, and unrelated rows (except ancestor summaries of chain
 *   members) render at reduced opacity so the chain pops.
 *
 * Bars are positioned by their start/end date using the layout primitives.
 * The renderer is given a pre-sliced set of rows; each row carries its GLOBAL
 * `yIndex`, and its viewport pixel Y = HEADER_HEIGHT + yIndex*ROW_HEIGHT - scrollTop
 * (mirrors resourceLoad.ts so bars track the left TaskTable during scroll).
 */
import type { RenderAnimation, Scene, ThemeColors, TaskRow } from './types';
import {
  COLUMN_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  dateToPixel,
  dateRangeWidth,
  milestoneCenterX,
} from '../layout';
import { BAR_INSET_Y, MILESTONE_HALF } from './geometry';

const BAR_RADIUS = 4;
/** Spotlight opacity for rows outside the active dependency chain (§3.5). */
const SPOTLIGHT_ROW_ALPHA = 0.45;
/** Breathing period of the origin halo (§3.4). */
const ORIGIN_HALO_CYCLE_MS = 1600;

export function renderBars(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  theme: ThemeColors,
  animation?: RenderAnimation,
): void {
  const {
    zoom,
    originDate,
    scrollLeft,
    rows,
    selectedTaskId,
    selectedTaskIds,
    showCriticalPath,
    hasActiveBaseline,
    depChain,
  } = scene;

  rows.forEach((row) => {
    // Position by GLOBAL row index minus scrollTop, mirroring the resource
    // view (`HEADER_HEIGHT + row.yIndex*ROW_HEIGHT - scrollTop` in
    // resourceLoad.ts) so bars stay pixel-aligned with the left TaskTable
    // during sub-row scroll. (Previously this used the slice-local `index`
    // and ignored scrollTop, snapping bars to whole rows while the list
    // scrolled smoothly — causing the left/right desync.)
    const y = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
    // Virtualisation: skip rows entirely outside the viewport. Bound against
    // HEADER_HEIGHT (the fixed header occupies y<HEADER_HEIGHT and overlaps any
    // row whose bottom < HEADER_HEIGHT, exactly mirroring the left TaskTable —
    // whose scroll container starts below its own header, so such a row is also
    // clipped there). Rows straddling the header still draw (their lower part
    // shows below the header band).
    if (y + ROW_HEIGHT < HEADER_HEIGHT || y > scene.viewportHeight) return;
    const role = chainRoleOf(depChain, row.id);
    // Spotlight (§3.5): with an active chain, rows that are neither chain
    // members nor ancestor summaries of one render dimmed. Propagated as
    // `baseAlpha` because several row-draw steps set/reset globalAlpha.
    const inSpotlight = !!depChain && role === null && !depChain.relatedSummaryIds.has(row.id);
    drawRow(ctx, row, y, {
      zoom,
      originDate,
      scrollLeft,
      theme,
      selectedTaskId,
      selectedTaskIds,
      showCriticalPath,
      hasActiveBaseline,
      viewportWidth: scene.viewportWidth,
      depChainRole: role,
      animation,
      baseAlpha: inSpotlight ? SPOTLIGHT_ROW_ALPHA : 1,
    });
  });
}

/** A row's membership in the active dependency chain (§3). */
type DepChainRole = 'origin' | 'upstream' | 'downstream';

function chainRoleOf(chain: Scene['depChain'], taskId: string): DepChainRole | null {
  if (!chain) return null;
  if (taskId === chain.originId) return 'origin';
  if (chain.upstream.has(taskId)) return 'upstream';
  if (chain.downstream.has(taskId)) return 'downstream';
  return null;
}

interface DrawCtx {
  zoom: Scene['zoom'];
  originDate: string;
  scrollLeft: number;
  theme: ThemeColors;
  /** Anchor / primary selected task id (draws the focus ring). */
  selectedTaskId: string | null;
  /** Multi-select set (plan §4.6); every member gets a selected outline. */
  selectedTaskIds: ReadonlySet<string>;
  showCriticalPath: boolean;
  /** When true, rows draw a baseline reference track below the live bar. */
  hasActiveBaseline: boolean;
  viewportWidth: number;
  /** Chain membership of this row; null when no chain is active. */
  depChainRole: DepChainRole | null;
  /** Animation clock — present only inside the host's rAF loop (§5.3). */
  animation?: RenderAnimation;
  /** Row-level alpha base (spotlight). All globalAlpha writes multiply it. */
  baseAlpha: number;
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
  // Progress fill follows the task color (darkened ×0.8, same rule as the
  // critical-path variant); only uncolored tasks fall back to the theme token.
  const progressColor =
    env.showCriticalPath && row.isCritical
      ? darken(env.theme.critical)
      : row.color
        ? darken(row.color)
        : env.theme.taskProgress;

  // Baseline comparison layout (spec §5.9): when active, the baseline track is
  // drawn FIRST (lower visual layer) at the bottom of the row, then the live
  // bar is drawn on top in the upper region. The live bar is shrunk vertically
  // so both fit within the 32px row without overlap.
  const compare = env.hasActiveBaseline;

  if (row.isMilestone) {
    // Draw the reference from the SNAPSHOT geometry. A moved milestone must
    // show two diamonds at different dates, and a task whose milestone status
    // changed since capture must retain the baseline's original shape.
    if (compare && row.baseline) drawBaselineReference(ctx, row.baseline, yTop, env);
    const cy = compare ? yTop + ROW_HEIGHT / 2 - 3 : yTop + ROW_HEIGHT / 2;
    // Anchor the diamond to its day's END line (right boundary) — see
    // `milestoneCenterX`. `xStart` is the start line; the centre is one
    // `pixelsPerDay` to its right.
    const cx = milestoneCenterX(row.start, env.originDate, env.zoom) - env.scrollLeft;
    const half = compare ? 8 : MILESTONE_HALF;
    drawMilestone(ctx, cx, cy, barColor, env.theme, half);
    if (row.id === env.selectedTaskId) {
      drawDiamondRing(ctx, cx, cy, half + 4, env.theme.primary);
    }
    if (env.depChainRole === 'origin') {
      drawOriginHaloDiamond(ctx, cx, cy, half + 7, env);
    } else if (env.depChainRole) {
      drawDiamondRing(ctx, cx, cy, half + 4, chainAccentColor(env));
    }
    // Label starts at the diamond's right edge instead of `xStart + width`,
    // since width is one-day-wide and would push the label too far right.
    drawRowLabel(ctx, row, cx + half, 0, yTop, env);
    return;
  }

  // Task bar. In compare mode: yTop+4, height ~16, leaving room for the 4px
  // baseline track at yTop+24 with a ≥3px gap (spec §5.9).
  const barY = compare ? yTop + 4 : yTop + BAR_INSET_Y;
  const barH = compare ? 16 : ROW_HEIGHT - 2 * BAR_INSET_Y;

  // Baseline reference track first (lower layer).
  if (compare && row.baseline) drawBaselineReference(ctx, row.baseline, yTop, env);

  drawRoundedRect(ctx, xStart, barY, width, barH, BAR_RADIUS);
  ctx.fillStyle = barColor;
  ctx.globalAlpha = env.baseAlpha * 0.35;
  ctx.fill();
  ctx.globalAlpha = env.baseAlpha;

  // Progress fill
  if (row.progress > 0) {
    const progressWidth = (width * Math.min(100, Math.max(0, row.progress))) / 100;
    if (progressWidth > 0.5) {
      drawRoundedRect(ctx, xStart, barY, progressWidth, barH, BAR_RADIUS);
      ctx.fillStyle = progressColor;
      ctx.fill();
    }
  }

  // Bar outline (always visible, sharper when selected). §4.6: every task in
  // the multi-select set gets a 2px primary outline; the anchor additionally
  // gets the selection ring further below. Non-selected bars use a 1px darken.
  // Chain members (§3.4) get their direction color instead of the darken —
  // the origin is always the selected one and keeps the primary outline.
  const isSelected = env.selectedTaskIds.has(row.id);
  const chainAccent =
    env.depChainRole && env.depChainRole !== 'origin' ? chainAccentColor(env) : null;
  drawRoundedRect(ctx, xStart, barY, width, barH, BAR_RADIUS);
  ctx.strokeStyle = isSelected ? env.theme.primary : (chainAccent ?? darken(barColor));
  ctx.lineWidth = isSelected || chainAccent ? 2 : 1;
  ctx.stroke();

  // Origin breathing halo (§3.4) — the ripple's source, in the selection
  // color so it reads as "focus", not as another chain direction.
  if (env.depChainRole === 'origin') {
    drawOriginHalo(ctx, xStart, barY, width, barH, env);
  }

  // Constraint marker (G5): a small icon at the constrained edge.
  // Start-type constraints (SNET/MSO) → left edge; end-type (MFO/FNLT) → right.
  if (row.constraint) {
    const isStartType =
      row.constraint.type === 'startNoEarlierThan' || row.constraint.type === 'mustStartOn';
    const markerX = isStartType ? xStart : xStart + width;
    const markerColor = row.hasConstraintConflict ? '#f97316' : env.theme.fgMuted; // orange if conflict
    drawConstraintMarker(ctx, markerX, barY, isStartType, markerColor);
  }

  drawRowLabel(ctx, row, xStart, width, yTop, env);
}

/**
 * Draw the baseline reference track — a thin neutral bar at the bottom of the
 * row (spec §5.9). Alpha ~0.55, 4px tall, 2px radius, optional 1px low-contrast
 * outline. No dashed lines (they fragment at month/year zoom).
 */
function drawBaselineTrack(
  ctx: CanvasRenderingContext2D,
  startISO: string,
  endISO: string,
  yTop: number,
  env: DrawCtx,
): void {
  const xStart = dateToPixel(startISO, env.originDate, env.zoom) - env.scrollLeft;
  const width = Math.max(dateRangeWidth(startISO, endISO, env.zoom), COLUMN_WIDTH[env.zoom] / 2);
  const trackY = yTop + 24; // spec §5.9
  const trackH = 4;
  drawRoundedRect(ctx, xStart, trackY, width, trackH, 2);
  ctx.globalAlpha = env.baseAlpha * 0.55;
  ctx.fillStyle = env.theme.baseline;
  ctx.fill();
  ctx.globalAlpha = env.baseAlpha;
  ctx.strokeStyle = env.theme.baseline;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Draw the captured shape independently from the task's current milestone state. */
function drawBaselineReference(
  ctx: CanvasRenderingContext2D,
  baseline: TaskRow['baseline'],
  yTop: number,
  env: DrawCtx,
): void {
  if (!baseline) return;
  if (baseline.duration === 0) {
    const baselineX = milestoneCenterX(baseline.start, env.originDate, env.zoom) - env.scrollLeft;
    drawBaselineMilestone(ctx, baselineX, yTop + ROW_HEIGHT - 8, env.theme.baseline);
    return;
  }
  drawBaselineTrack(ctx, baseline.start, baseline.end, yTop, env);
}

/** Small hollow baseline milestone diamond (spec §5.9). */
function drawBaselineMilestone(
  ctx: CanvasRenderingContext2D,
  cxBase: number,
  cy: number,
  color: string,
): void {
  const half = 5;
  ctx.save();
  ctx.translate(cxBase, cy);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-half, -half, half * 2, half * 2);
  ctx.restore();
}

/**
 * Shared row-label drawing (extracted to avoid duplication in compare paths).
 *
 * Combines the task name with a short assignee summary (plan §3.3):
 *   - assigned:   "开发实现 · 王强"  (or "开发实现 · 王强 +2")
 *   - unassigned: "开发实现 · 未分配" (muted)
 *   - no summary (summary rows / legacy scenes): name only.
 *
 * Truncation keeps the task name intact as long as possible: if the combined
 * label overflows, the trailing assignee part is cut first, then the whole
 * label is ellipsised as a fallback.
 */
function drawRowLabel(
  ctx: CanvasRenderingContext2D,
  row: TaskRow,
  xStart: number,
  width: number,
  yTop: number,
  env: DrawCtx,
): void {
  const name = row.name;
  if (!name) return;
  // `assigneeSummary === undefined` means the scene didn't compute one
  // (e.g. a summary row) — keep the legacy name-only label.
  const hasAssigneeField = row.assigneeSummary !== undefined;
  const summary = hasAssigneeField ? row.assigneeSummary || UNASSIGNED : null;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const labelX = xStart + width + 6;
  const maxLabelWidth = env.viewportWidth - labelX;
  if (maxLabelWidth <= 20) return;

  const centerY = yTop + ROW_HEIGHT / 2;

  // Name-only path: single fill, theme.fg.
  if (summary === null) {
    ctx.fillStyle = env.theme.fg;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(ellipsis(ctx, name, Math.max(20, maxLabelWidth)), labelX, centerY);
    return;
  }

  // Combined path: "name · summary". Measure both to truncate the summary
  // first, then the name, so the name survives as long as possible.
  ctx.font = '12px system-ui, sans-serif';
  const sep = ' · ';
  const nameW = ctx.measureText(name).width;
  const sepW = ctx.measureText(sep).width;
  const summaryW = ctx.measureText(summary).width;
  const total = nameW + sepW + summaryW;

  // Everything fits → draw name in fg, separator+summary in fgMuted.
  if (total <= maxLabelWidth) {
    ctx.fillStyle = env.theme.fg;
    ctx.fillText(name, labelX, centerY);
    ctx.fillStyle = env.theme.fgMuted;
    ctx.fillText(sep + summary, labelX + nameW, centerY);
    return;
  }

  // Truncate the summary to whatever room remains after the name + separator.
  // Keep at least the full name; the summary is allowed to vanish entirely.
  const roomForSummary = Math.max(0, maxLabelWidth - nameW - sepW);
  if (roomForSummary > 4) {
    const trimmedSummary = ellipsis(ctx, summary, roomForSummary);
    ctx.fillStyle = env.theme.fg;
    ctx.fillText(name, labelX, centerY);
    ctx.fillStyle = env.theme.fgMuted;
    ctx.fillText(sep + trimmedSummary, labelX + nameW, centerY);
    return;
  }

  // Not enough room even for "name · …" — ellipsis the name alone (fg).
  ctx.fillStyle = env.theme.fg;
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(ellipsis(ctx, name, Math.max(20, maxLabelWidth)), labelX, centerY);
}

/** Muted placeholder shown after the task name when a leaf has no assignees. */
const UNASSIGNED = '未分配';

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
  // The summary body is darken(barColor), so the progress fill uses the BASE
  // color (lighter than the body) instead of darkening again, which would be
  // invisible on top of it. Uncolored summaries keep the theme token.
  const progressColor =
    env.showCriticalPath && row.isCritical
      ? darken(env.theme.critical)
      : (row.color ?? env.theme.taskProgress);

  const summaryBarH = Math.round((ROW_HEIGHT - 2 * BAR_INSET_Y) * 0.45);
  // In compare mode, nudge the live summary bar up so the baseline track fits
  // below (spec §5.9 — "当前摘要条继续使用较深实色...在比较模式中适当上移").
  const summaryBarY = env.hasActiveBaseline ? yTop + 8 : yTop + ROW_HEIGHT / 2;
  const darkColor = darken(barColor);

  // Baseline summary track FIRST (lower layer): a 3-4px thin track with small
  // end caps (spec §5.9). Only when a snapshot exists for this summary.
  if (env.hasActiveBaseline && row.baseline) {
    drawBaselineSummaryTrack(ctx, row.baseline.start, row.baseline.end, yTop, env);
  }

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

/** Thin baseline summary track with small end caps (spec §5.9). */
function drawBaselineSummaryTrack(
  ctx: CanvasRenderingContext2D,
  startISO: string,
  endISO: string,
  yTop: number,
  env: DrawCtx,
): void {
  const xStart = dateToPixel(startISO, env.originDate, env.zoom) - env.scrollLeft;
  const width = Math.max(dateRangeWidth(startISO, endISO, env.zoom), COLUMN_WIDTH[env.zoom] / 2);
  const trackY = yTop + ROW_HEIGHT - 8;
  const trackH = 3;
  ctx.globalAlpha = env.baseAlpha * 0.55;
  drawRoundedRect(ctx, xStart, trackY, width, trackH, 1);
  ctx.fillStyle = env.theme.baseline;
  ctx.fill();
  ctx.globalAlpha = env.baseAlpha;
  // Small end caps.
  ctx.fillStyle = env.theme.baseline;
  ctx.fillRect(xStart - 1, trackY - 1, 1.5, trackH + 2);
  ctx.fillRect(xStart + width - 0.5, trackY - 1, 1.5, trackH + 2);
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
  half: number = MILESTONE_HALF,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = color;
  ctx.fillRect(-half, -half, half * 2, half * 2);
  ctx.restore();
}

/** Diamond-shaped ring (rotated square) in the given color (§3.4). */
function drawDiamondRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(-radius, -radius, radius * 2, radius * 2);
  ctx.restore();
}

/** Direction color for a chain-member row (§3.4). Call only for members. */
function chainAccentColor(env: DrawCtx): string {
  return env.depChainRole === 'upstream' ? env.theme.depUpstream : env.theme.depDownstream;
}

/**
 * Origin breathing halo for a task bar (§3.4): a soft primary ring outside the
 * bar whose alpha swells 0.22↔0.5 over ~1.6s — the ripple's source. Static at
 * mid-alpha when no animation clock is available (reduced motion).
 */
function drawOriginHalo(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  env: DrawCtx,
): void {
  const breathe = breatheAt(env);
  ctx.save();
  ctx.strokeStyle = env.theme.primary;
  ctx.globalAlpha = env.baseAlpha * (0.25 + 0.3 * breathe);
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, x - 3, y - 3, w + 6, h + 6, BAR_RADIUS + 2);
  ctx.stroke();
  ctx.restore();
}

/** Origin halo variant for milestones — a larger, softer diamond ring. */
function drawOriginHaloDiamond(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  env: DrawCtx,
): void {
  const breathe = breatheAt(env);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = env.theme.primary;
  ctx.globalAlpha = env.baseAlpha * (0.25 + 0.3 * breathe);
  ctx.lineWidth = 2;
  ctx.strokeRect(-radius, -radius, radius * 2, radius * 2);
  ctx.restore();
}

/** 0..1 breathing phase; static 0.5 without an animation clock. */
function breatheAt(env: DrawCtx): number {
  if (!env.animation) return 0.5;
  const t = (env.animation.now % ORIGIN_HALO_CYCLE_MS) / ORIGIN_HALO_CYCLE_MS;
  return (Math.sin(t * Math.PI * 2) + 1) / 2;
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
