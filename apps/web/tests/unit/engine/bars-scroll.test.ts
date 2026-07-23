/**
 * Unit tests for task-bar vertical positioning under scroll (PR A: the
 * left/right desync fix).
 *
 * Guards the regression where `renderBars` positioned bars by the SLICE-LOCAL
 * index and ignored `scrollTop` (so bars snapped to whole rows while the left
 * TaskTable scrolled smoothly — the reported misalignment). Bars must now
 * honour sub-row scroll: pixel Y = HEADER_HEIGHT + row.yIndex*ROW_HEIGHT - scrollTop,
 * mirroring `resourceLoad.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { Scene, ThemeColors } from '@/engine/render/types';
import { renderBars } from '@/engine/render/bars';
import { HEADER_HEIGHT, ROW_HEIGHT } from '@/engine/layout';

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

interface Move {
  x: number;
  y: number;
}

/** Recording canvas stub. Bars are drawn via the path API (moveTo/lineTo/
 * quadraticCurveTo + fill/stroke), so we capture `moveTo` calls — the first
 * one per `drawRoundedRect` is `moveTo(x + radius, barY)` where
 * `barY = yTop + BAR_INSET_Y`, giving us each row's top edge. */
function makeCtx() {
  const moves: Move[] = [];
  let fillStyle = '';
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, prop) {
      switch (prop) {
        case 'fillStyle':
          return fillStyle;
        case 'moves':
          return moves;
        case 'moveTo':
          return (x: number, y: number) => {
            moves.push({ x, y });
          };
        case 'measureText':
          // width 0 → label fits, skips ellipsis truncation (no text asserts here).
          return () => ({ width: 0 });
        default:
          return typeof prop === 'string' ? () => {} : undefined;
      }
    },
    set(_t, prop, value) {
      if (prop === 'fillStyle') fillStyle = String(value);
      return true;
    },
  };
  return { ctx: new Proxy({}, handler) as unknown as CanvasRenderingContext2D, moves };
}

/** One task bar at global row `yIndex`. start==end so width = min (1/2 col). */
function row(yIndex: number, id = `t${yIndex}`) {
  return {
    id,
    name: id,
    start: '2026-02-02',
    end: '2026-02-06',
    progress: 0,
    isMilestone: false,
    depth: 0,
    wbsNumber: String(yIndex + 1),
    yIndex,
  };
}

function makeScene(rows: ReturnType<typeof row>[], scrollTop: number): Scene {
  return {
    zoom: 'week',
    originDate: '2026-02-02',
    scrollLeft: 0,
    scrollTop,
    viewportWidth: 800,
    viewportHeight: 400,
    today: '2026-02-02',
    holidays: [],
    rows,
    totalRows: rows.length,
    arrows: [],
    showCriticalPath: false,
    selectedTaskId: null,
  };
}

/**
 * A bar body is drawn via `drawRoundedRect`, whose first path op is
 * `moveTo(x + radius, barY)` with radius=4 and barY = yTop + BAR_INSET_Y. Since
 * every test bar sits at x=0 (start==originDate, scrollLeft 0), its first
 * moveTo lands at x===4. Each bar emits exactly two such moves (fill path +
 * outline path) at the same y. We collect the DISTINCT y values (sorted) — one
 * per drawn bar — and subtract the inset to recover each row's true top edge.
 */
const BAR_INSET_Y = 5;
const BAR_MOVE_X = 4; // radius

function barTops(moves: Move[]): number[] {
  const ys = moves.filter((m) => m.x === BAR_MOVE_X).map((m) => m.y - BAR_INSET_Y);
  return Array.from(new Set(ys)).sort((a, b) => a - b);
}

describe('renderBars — vertical positioning honours scrollTop', () => {
  it('places row 0 at HEADER_HEIGHT when scrollTop = 0', () => {
    const { ctx, moves } = makeCtx();
    renderBars(ctx, makeScene([row(0)], 0), THEME);
    expect(barTops(moves)).toEqual([HEADER_HEIGHT]);
  });

  it('shifts row 0 up by scrollTop (sub-row scroll respected)', () => {
    // scrollTop = 10 (not a multiple of ROW_HEIGHT). The old buggy code left
    // the bar at HEADER_HEIGHT (56); the fix moves it to 56 - 10 = 46. Row 0's
    // bottom (78) still clears HEADER_HEIGHT so it draws (top straddles header).
    const { ctx, moves } = makeCtx();
    renderBars(ctx, makeScene([row(0)], 10), THEME);
    expect(barTops(moves)).toEqual([HEADER_HEIGHT - 10]);
  });

  it('positions each row by its GLOBAL yIndex, not a slice-local index', () => {
    // scrollTop = 10. Row 2 (global index 2) must sit at 56 + 2*32 - 10 = 110,
    // NOT at 56 + 0*32 (slice-local 0). Row 0 still straddles the header and
    // draws, so three distinct tops ascending by ROW_HEIGHT.
    const { ctx, moves } = makeCtx();
    renderBars(ctx, makeScene([row(0), row(1), row(2)], 10), THEME);
    expect(barTops(moves)).toEqual([
      HEADER_HEIGHT - 10,
      HEADER_HEIGHT + ROW_HEIGHT - 10,
      HEADER_HEIGHT + 2 * ROW_HEIGHT - 10,
    ]);
  });

  it('skips rows scrolled fully above the header band (virtualisation)', () => {
    // scrollTop = 400 → row 0 (top at 56 - 400 = -344, bottom -312) is entirely
    // above HEADER_HEIGHT and must be skipped; only row 20 (in view) draws.
    const { ctx, moves } = makeCtx();
    renderBars(ctx, makeScene([row(0), row(20)], 400), THEME);
    expect(barTops(moves)).toEqual([HEADER_HEIGHT + 20 * ROW_HEIGHT - 400]);
  });
});
