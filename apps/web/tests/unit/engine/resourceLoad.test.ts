/**
 * Renderer geometry tests for the resource load-chart (P1 feature one, G7).
 *
 * These guard against the cell-overflow bug: an overloaded bar (load > 100%)
 * must never paint outside its row vertically, and low-capacity resources must
 * render bars on an absolute (not capacity-scaled) height so overload is still
 * visually obvious. We stub the 2D canvas with a recording Proxy and assert on
 * the geometry of the recorded `fillRect` calls.
 */
import { describe, expect, it } from 'vitest';
import type { ResourceScene, ThemeColors } from '@/engine/render/types';
import { renderResourceLoad } from '@/engine/render/resourceLoad';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';

// Absolute-scale model: the cell height = 100% load.
const FULL_BAR_HEIGHT = ROW_HEIGHT - 6; // 26px

const THEME: ThemeColors = {
  bg: '#fff',
  bgElevated: '#eee',
  border: '#ccc',
  fg: '#000',
  fgMuted: '#888',
  primary: '#3b82f6',
  accent: '#06b6d4',
  danger: '#ef4444',
  nonWorking: '#f5f5f5',
  warning: '#d97706',
  taskBar: '#3b82f6',
  taskProgress: '#1d4ed8',
  critical: '#dc2626',
  todayLine: '#ef4444',
};

/** A recording canvas stub. `rects` captures every fillRect with the fillStyle
 * active at the moment of the call. Everything else is a no-op Proxy property. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

function makeCtx() {
  const rects: Rect[] = [];
  const texts: { text: string; x: number; y: number; fill: string }[] = [];
  let fillStyle = '';
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop) {
      switch (prop) {
        case 'fillStyle':
          return fillStyle;
        case 'rects':
          return rects;
        case 'texts':
          return texts;
        case 'fillRect':
          return (x: number, y: number, w: number, h: number) => {
            rects.push({ x, y, w, h, fill: fillStyle });
          };
        case 'fillText':
          return (text: string, x: number, y: number) => {
            texts.push({ text, x, y, fill: fillStyle });
          };
        default:
          // methods → no-op fn; other properties → identity setter sink
          return typeof prop === 'string' ? () => {} : undefined;
      }
    },
    set(_t, prop, value) {
      if (prop === 'fillStyle') fillStyle = String(value);
      return true;
    },
  };
  return { ctx: new Proxy({}, handler) as unknown as CanvasRenderingContext2D, rects, texts };
}

/** Build a minimal resource scene with one resource carrying one bar. */
function makeScene(opts: {
  capacity: number;
  load: number;
  date?: string;
  zoom?: 'day' | 'week' | 'month' | 'year';
}): ResourceScene {
  // day zoom = 32px/day → barWidth = 31 (≥ 20, so labels also draw).
  const date = opts.date ?? '2026-02-02';
  return {
    zoom: opts.zoom ?? 'day',
    originDate: date,
    scrollLeft: 0,
    scrollTop: 0,
    viewportWidth: 800,
    viewportHeight: 400,
    today: date,
    holidays: [],
    rows: [
      {
        kind: 'resource',
        yIndex: 0,
        id: 'r1',
        name: 'Alice',
        capacity: opts.capacity,
        bars: [{ resourceId: 'r1', date, load: opts.load }],
        expanded: false,
        taskCount: 0,
      },
    ],
    selectedResourceId: null,
    selectedTaskIdInResource: null,
  };
}

// Row 0 vertical extent in viewport coords (scrollTop = 0).
const ROW_TOP = HEADER_HEIGHT; // 56
const ROW_BOTTOM = ROW_TOP + ROW_HEIGHT; // 88

/** Filter recorded rects down to the load bar itself (skip grid/header/capacity
 * fills) by selecting rects whose x is the bar's x (≈0.5) and width = barWidth. */
function barRects(rects: Rect[]) {
  // The bar is drawn at x = 0.5 (dateToPixel(0) - 0 + 0.5), width ≈ 31.
  return rects.filter((r) => r.x === 0.5);
}

describe('renderResourceLoad — bar geometry', () => {
  it('clamps an overloaded bar (cap=1, load=150%) inside the row', () => {
    const { ctx, rects } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 1.0, load: 150 }), THEME);
    const bars = barRects(rects);
    expect(bars.length).toBe(1);
    const b = bars[0]!;
    // Top edge must not go above the row; bottom must not exceed the row.
    expect(b.y).toBeGreaterThanOrEqual(ROW_TOP);
    expect(b.y + b.h).toBeLessThanOrEqual(ROW_BOTTOM);
    // At load≥100% the bar caps at fullBarHeight.
    expect(b.h).toBeCloseTo(FULL_BAR_HEIGHT, 5);
    expect(b.fill).toBe('#ef4444'); // RED
  });

  it('keeps a 120% overload inside the row (not overflowing the cell)', () => {
    const { ctx, rects } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 1.0, load: 120 }), THEME);
    const b = barRects(rects)[0]!;
    expect(b.y).toBeGreaterThanOrEqual(ROW_TOP);
    expect(b.y + b.h).toBeLessThanOrEqual(ROW_BOTTOM);
    expect(b.fill).toBe('#ef4444');
  });

  it('scales a non-overloaded bar proportionally on the absolute scale', () => {
    const { ctx, rects } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 1.0, load: 50 }), THEME);
    const b = barRects(rects)[0]!;
    // 50% → half of fullBarHeight; green; within row.
    expect(b.h).toBeCloseTo(FULL_BAR_HEIGHT * 0.5, 5);
    expect(b.fill).toBe('#22c55e'); // GREEN
    expect(b.y + b.h).toBeLessThanOrEqual(ROW_BOTTOM);
  });

  it('renders a low-capacity overload with a tall red bar (absolute scale)', () => {
    // cap=0.3 → overload threshold is 30%. load=90% is 3× capacity → must be red
    // and tall (90% of fullBarHeight ≈ 23.4px), NOT the tiny ~11px bar the old
    // capacity-scaled model produced.
    const { ctx, rects } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 0.3, load: 90 }), THEME);
    const b = barRects(rects)[0]!;
    expect(b.fill).toBe('#ef4444');
    expect(b.h).toBeCloseTo(FULL_BAR_HEIGHT * 0.9, 5);
    expect(b.y).toBeGreaterThanOrEqual(ROW_TOP);
  });

  it('a part-time resource within capacity renders green and proportional', () => {
    // cap=0.3, load=25% (< 30% threshold) → green, 25% of fullBarHeight.
    const { ctx, rects } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 0.3, load: 25 }), THEME);
    const b = barRects(rects)[0]!;
    expect(b.fill).toBe('#22c55e');
    expect(b.h).toBeCloseTo(FULL_BAR_HEIGHT * 0.25, 5);
  });

  it('does not crash or produce NaN dimensions at capacity=0', () => {
    const { ctx, rects } = makeCtx();
    expect(() =>
      renderResourceLoad(ctx, makeScene({ capacity: 0, load: 50 }), THEME),
    ).not.toThrow();
    const b = barRects(rects)[0]!;
    expect(Number.isFinite(b.y)).toBe(true);
    expect(Number.isFinite(b.h)).toBe(true);
    // capacity=0 ⇒ any load > 0 is overload ⇒ red.
    expect(b.fill).toBe('#ef4444');
  });
});

describe('renderResourceLoad — percentage label placement', () => {
  /** The single load-bar label drawn by the renderer (the grid/header also
   * draw fillText, but only one uses the "NN%" format on the bar). */
  function barLabel(texts: { text: string; x: number; y: number; fill: string }[]) {
    const labels = texts.filter((t) => /^\d+%$/.test(t.text));
    expect(labels.length).toBe(1);
    return labels[0]!;
  }

  it('anchors the label at the TOP INSIDE the bar (barTop + 2)', () => {
    const { ctx, rects, texts } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 1.0, load: 80 }), THEME);
    const b = barRects(rects)[0]!;
    const lbl = barLabel(texts);
    // Label baseline-anchor is 'top', drawn at barTop + 2 → sits just under the
    // bar's top edge, inside the bar.
    expect(lbl.y).toBeCloseTo(b.y + 2, 5);
    expect(lbl.fill).toBe('#fff');
  });

  it('rides the label up as the bar grows (label tracks barTop, not rowBottom)', () => {
    // load=40% → short bar near the bottom; load=90% → tall bar near the top.
    const shortCtx = makeCtx();
    renderResourceLoad(shortCtx.ctx, makeScene({ capacity: 1.0, load: 40 }), THEME);
    const tallCtx = makeCtx();
    renderResourceLoad(tallCtx.ctx, makeScene({ capacity: 1.0, load: 90 }), THEME);
    const shortLbl = barLabel(shortCtx.texts);
    const tallLbl = barLabel(tallCtx.texts);
    // Taller bar ⇒ higher barTop ⇒ higher (smaller-y) label.
    expect(tallLbl.y).toBeLessThan(shortLbl.y);
  });

  it('keeps the label inside the bar for a low-capacity green bar', () => {
    // cap=0.3, load=25% → green bar ~6.5px tall. Label must still anchor at its
    // top edge (barTop + 2), not drop to the row bottom.
    const { ctx, rects, texts } = makeCtx();
    renderResourceLoad(ctx, makeScene({ capacity: 0.3, load: 25 }), THEME);
    const b = barRects(rects)[0]!;
    const lbl = barLabel(texts);
    expect(lbl.y).toBeCloseTo(b.y + 2, 5);
    // Bar height ≈ 6.5px; label anchored at +2 from the top stays inside.
    expect(lbl.y).toBeGreaterThanOrEqual(b.y);
  });
});
