import { describe, expect, it } from 'vitest';
import { computeZoomAround, nextZoomLevel } from '@/lib/zoomAround';
import { dateToPixel, pixelToDate } from '@/engine/layout';
import type { ZoomLevel } from '@ganttly/schema';

const ORIGIN = '2026-01-05';

describe('nextZoomLevel', () => {
  it('steps toward coarser (+1) and finer (-1)', () => {
    expect(nextZoomLevel('day', 1)).toBe('week');
    expect(nextZoomLevel('week', 1)).toBe('month');
    expect(nextZoomLevel('week', -1)).toBe('day');
    expect(nextZoomLevel('month', -1)).toBe('week');
  });

  it('clamps at the boundaries (returns same zoom)', () => {
    expect(nextZoomLevel('day', -1)).toBe('day'); // already finest
    expect(nextZoomLevel('year', 1)).toBe('year'); // already coarsest
  });
});

describe('computeZoomAround — anchor stability', () => {
  it('keeps the anchor date at the same screen X when zooming IN (finer)', () => {
    // Zooming finer (week→day) INCREASES px/day, so the anchor date's pixel
    // grows and scrollLeft grows with it — no clamping. pick values where the
    // anchor is well into the chart.
    const currentZoom: ZoomLevel = 'week';
    const nextZoom: ZoomLevel = 'day';
    const scrollLeft = 200;
    const offsetX = 300; // anchor well past the left edge
    const anchorChartX = scrollLeft + offsetX; // 500 → ~25 days from origin

    const result = computeZoomAround(ORIGIN, currentZoom, nextZoom, anchorChartX, offsetX);

    expect(result.zoom).toBe('day');
    // The date under the cursor must be unchanged.
    const anchorDateOld = pixelToDate(anchorChartX, ORIGIN, currentZoom);
    const anchorDateNew = pixelToDate(result.scrollLeft + offsetX, ORIGIN, nextZoom);
    expect(anchorDateNew).toBe(anchorDateOld);
  });

  it('clamps scrollLeft to >= 0 when the anchor is at the chart origin', () => {
    // Anchor at chart X = 2 (≈ day 0, the origin date). Zooming out
    // (month→week: px/day 4→20) keeps the anchor date near pixel 0; with a
    // large anchorScreenX the computed scrollLeft goes negative and must clamp.
    const result = computeZoomAround(ORIGIN, 'month', 'week', 2, 200);
    expect(result.scrollLeft).toBe(0);
    expect(result.zoom).toBe('week');
  });

  it('returns scrollLeft 0 (no change meaningful) when zoom does not change', () => {
    const result = computeZoomAround(ORIGIN, 'week', 'week', 300, 150);
    expect(result.zoom).toBe('week');
    expect(result.scrollLeft).toBe(0);
  });

  it('works for toolbar (center-anchor) semantics', () => {
    // Viewport 800 wide, scrollLeft 1000 → center chart X = 1400. Zooming
    // finer (day→week: px/day 32→20) shrinks pixels; with the center far into
    // the chart the recomputed scrollLeft stays positive.
    const viewportWidth = 800;
    const scrollLeft = 1000;
    const centerChartX = scrollLeft + viewportWidth / 2;
    const result = computeZoomAround(ORIGIN, 'day', 'week', centerChartX, viewportWidth / 2);
    expect(result.zoom).toBe('week');
    // The center date is preserved.
    const centerDateOld = pixelToDate(centerChartX, ORIGIN, 'day');
    const centerDateNew = pixelToDate(result.scrollLeft + viewportWidth / 2, ORIGIN, 'week');
    expect(centerDateNew).toBe(centerDateOld);
  });

  it('preserves the anchor pixel position within one column-width tolerance', () => {
    // The anchor DATE's pixel at the new zoom, minus the new scrollLeft, equals
    // the anchor screen X (the date's left edge lands under the cursor).
    const result = computeZoomAround(ORIGIN, 'week', 'day', 500, 200);
    const anchorDate = pixelToDate(500, ORIGIN, 'week');
    const anchorPxNew = dateToPixel(anchorDate, ORIGIN, 'day');
    expect(anchorPxNew - result.scrollLeft).toBeCloseTo(200, 0);
  });
});

describe('computeZoomAround — zooming out coarser', () => {
  it('keeps anchor stable when zooming month → week with a far-right anchor', () => {
    // Zooming OUT (month→week: px/day 4→20) grows pixels. Anchor far into the
    // chart so the date's new pixel minus anchorScreenX stays positive.
    const scrollLeft = 600;
    const offsetX = 500;
    const anchorChartX = scrollLeft + offsetX; // 1100 → ~275 days at month
    const result = computeZoomAround(ORIGIN, 'month', 'week', anchorChartX, offsetX);
    const oldDate = pixelToDate(anchorChartX, ORIGIN, 'month');
    const newDate = pixelToDate(result.scrollLeft + offsetX, ORIGIN, 'week');
    expect(newDate).toBe(oldDate);
  });
});
