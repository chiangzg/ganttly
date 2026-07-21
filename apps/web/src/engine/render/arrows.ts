/**
 * Dependency arrow renderer (PRD §5.2, M2.17).
 *
 * Each arrow is drawn as a cubic-bezier path with an arrowhead. Arrow color
 * reflects critical-path status when `showCriticalPath` is on.
 *
 * ArrowSpec carries pre-computed from/to pixel positions; the renderer just
 * draws them. The geometry computation (which edge of which bar) lives in
 * `computeArrows` in scene/assembly, so the renderer stays pure and fast.
 */
import type { Scene, ThemeColors } from './types';
import { HEADER_HEIGHT } from '../layout';

const ARROW_HEAD_SIZE = 6;
const CURVE_RADIUS = 8;

export function renderArrows(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  theme: ThemeColors,
): void {
  // Clip arrows to the content area below the header so bezier curves
  // and arrowheads never overlap the month/day header row.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_HEIGHT, scene.viewportWidth, scene.viewportHeight - HEADER_HEIGHT);
  ctx.clip();

  for (const arrow of scene.arrows) {
    const isCritical = scene.showCriticalPath && arrow.isCritical;
    const color = isCritical ? theme.critical : theme.fgMuted;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = isCritical ? 2 : 1;
    drawArrowPath(ctx, arrow.fromX, arrow.fromY, arrow.toX, arrow.toY);
  }

  ctx.restore();
}

function drawArrowPath(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  // Bezier control points: horizontal bias if from is left of to; otherwise
  // route up/over first.
  const horizontalTravel = toX - fromX;
  const cpOffset =
    Math.sign(horizontalTravel) * Math.min(Math.abs(horizontalTravel) / 2, CURVE_RADIUS * 4);

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.bezierCurveTo(fromX + cpOffset, fromY, toX - cpOffset, toY, toX, toY);
  ctx.stroke();

  // Arrowhead at toX/toY — pointing right or left depending on direction.
  const dir = horizontalTravel >= 0 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - dir * ARROW_HEAD_SIZE, toY - ARROW_HEAD_SIZE / 2);
  ctx.lineTo(toX - dir * ARROW_HEAD_SIZE, toY + ARROW_HEAD_SIZE / 2);
  ctx.closePath();
  ctx.fill();
}
