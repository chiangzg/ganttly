/**
 * Top-level render entry point.
 *
 * Orchestrates the layer order: grid (background) → today line → bars →
 * arrows → (selection overlays handled inside bars).
 *
 * The function is responsible for HiDPI scaling — the host passes a CSS-sized
 * canvas; we set the transform so drawing operations use CSS pixels.
 */
import type { RenderAnimation, Scene, ThemeColors } from './types';
import { renderGrid } from './grid';
import { renderBars } from './bars';
import { renderArrows } from './arrows';
import { renderTodayLine } from './overlay';

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  scene: Scene;
  theme: ThemeColors;
  /** Device pixel ratio for Retina crispness. */
  dpr: number;
  /** CSS-pixel canvas width/height (must match the canvas's CSS size). */
  cssWidth: number;
  cssHeight: number;
  /**
   * Animation clock (chain spec §5.3). Present only inside the host's rAF loop
   * while a downstream dependency chain is animating; absent for static
   * renders (and under prefers-reduced-motion).
   */
  animation?: RenderAnimation;
}

export function renderScene(input: RenderInput): void {
  const { ctx, scene, theme, dpr, cssWidth, cssHeight, animation } = input;

  // Reset transform and apply DPR scaling so we can draw in CSS pixels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Clear the whole canvas (CSS-size; DPR transform handles real pixels).
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  renderGrid(ctx, scene, theme);
  renderTodayLine(ctx, scene, theme);
  renderBars(ctx, scene, theme, animation);
  renderArrows(ctx, scene, theme, animation);
}

export * from './types';
export { resolveThemeColors } from './theme';
export { renderResourceLoad } from './resourceLoad';
