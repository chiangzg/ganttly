/**
 * Today line overlay (PRD §3.10, M3.14).
 *
 * A red vertical line at the current date, drawn over the grid but under the
 * bars. Includes a small "今天" pill at the top.
 */
import type { Scene, ThemeColors } from './types';
import { HEADER_HEIGHT, dateToPixel } from '../layout';

export function renderTodayLine(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  theme: ThemeColors,
): void {
  const x = dateToPixel(scene.today, scene.originDate, scene.zoom) - scene.scrollLeft;
  if (x < -1 || x > scene.viewportWidth + 1) return;

  ctx.save();
  ctx.strokeStyle = theme.todayLine;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x + 0.5, HEADER_HEIGHT);
  ctx.lineTo(x + 0.5, scene.viewportHeight);
  ctx.stroke();
  ctx.restore();
}
