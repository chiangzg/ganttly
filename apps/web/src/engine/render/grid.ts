/**
 * Grid + holiday highlight renderer (PRD §5.2, M1.10/M1.11).
 *
 * Draws:
 * 1. Non-working-day background stripes (weekends + holidays)
 * 2. Vertical grid lines (with thicker lines at week boundaries)
 * 3. Horizontal row separators
 * 4. Two-row header: upper label (month/year), lower label (day/week/month)
 *
 * Pure: takes ctx + scene + theme, draws without side effects beyond the canvas.
 */
import type { Scene, ThemeColors } from './types';
import { COLUMN_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, dateToPixel, pixelsPerDay } from '../layout';
import { dayOfWeek } from '@/lib/calendar';

const MONTH_NAMES_ZH = [
  '1月',
  '2月',
  '3月',
  '4月',
  '5月',
  '6月',
  '7月',
  '8月',
  '9月',
  '10月',
  '11月',
  '12月',
];
const UPPER_ROW_HEIGHT = 28;

export function renderGrid(ctx: CanvasRenderingContext2D, scene: Scene, theme: ThemeColors): void {
  const { zoom, originDate, scrollLeft, viewportWidth, viewportHeight, holidays } = scene;
  const pxPerDay = pixelsPerDay(zoom);
  const colWidth = COLUMN_WIDTH[zoom];
  const holidayMap = new Map(holidays.map((h) => [h.date, h]));

  // Visible date range — pad by a few columns to avoid edge pop-in.
  const padCols = 3;
  const firstDay = Math.floor((scrollLeft - padCols * colWidth) / pxPerDay);
  const lastDay = Math.ceil((scrollLeft + viewportWidth + padCols * colWidth) / pxPerDay);

  // 1. Non-working-day stripes.
  for (let d = firstDay; d <= lastDay; d++) {
    const iso = addDays(originDate, d);
    const dow = dayOfWeek(iso);
    const isWeekend = dow === 0 || dow === 6;
    const holiday = holidayMap.get(iso);
    const isNonWorking = holiday?.type === 'holiday' || (!holiday && isWeekend);
    if (isNonWorking) {
      const x = dateToPixel(iso, originDate, zoom) - scrollLeft;
      ctx.fillStyle = theme.nonWorking;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x, HEADER_HEIGHT, colWidth, viewportHeight - HEADER_HEIGHT);
      ctx.globalAlpha = 1;
    }
  }

  // 2. Vertical grid lines (thicker at week boundaries).
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  for (let d = firstDay; d <= lastDay; d++) {
    const iso = addDays(originDate, d);
    const x = Math.round(dateToPixel(iso, originDate, zoom) - scrollLeft) + 0.5;
    ctx.strokeStyle = dayOfWeek(iso) === 1 ? theme.fgMuted : theme.border;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, viewportHeight);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 3. Horizontal row separators.
  ctx.strokeStyle = theme.border;
  ctx.globalAlpha = 0.4;
  const visibleRows = Math.ceil((viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT) + 1;
  for (let r = 0; r <= visibleRows; r++) {
    const y = Math.round(HEADER_HEIGHT + r * ROW_HEIGHT) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(viewportWidth, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 4. Header background + dividers.
  ctx.fillStyle = theme.bgElevated;
  ctx.fillRect(0, 0, viewportWidth, HEADER_HEIGHT);
  ctx.strokeStyle = theme.border;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_HEIGHT + 0.5);
  ctx.lineTo(viewportWidth, HEADER_HEIGHT + 0.5);
  ctx.moveTo(0, UPPER_ROW_HEIGHT + 0.5);
  ctx.lineTo(viewportWidth, UPPER_ROW_HEIGHT + 0.5);
  ctx.stroke();

  // 5. Header text.
  renderHeaderLabels(ctx, scene, theme, firstDay, lastDay);
}

function renderHeaderLabels(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  theme: ThemeColors,
  firstDay: number,
  lastDay: number,
): void {
  const { zoom, originDate, scrollLeft } = scene;
  const pxPerDay = pixelsPerDay(zoom);
  const colWidth = COLUMN_WIDTH[zoom];

  ctx.textBaseline = 'middle';

  // Lower row labels.
  ctx.fillStyle = theme.fgMuted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let d = firstDay; d <= lastDay; d++) {
    const iso = addDays(originDate, d);
    const [, , day] = iso.split('-').map(Number);
    if (!day) continue;
    const x = dateToPixel(iso, originDate, zoom) - scrollLeft;
    let label: string | null = null;
    switch (zoom) {
      case 'day':
        label = String(day);
        break;
      case 'week':
        if (dayOfWeek(iso) === 1) label = iso.slice(5).replace('-', '/');
        break;
      case 'month':
        if (day === 1) label = iso.slice(0, 7);
        break;
      case 'year':
        if (day === 1) label = `${Number(iso.slice(5, 7))}月`;
        break;
    }
    if (label) {
      ctx.fillText(
        label,
        x + colWidth / 2,
        UPPER_ROW_HEIGHT + (HEADER_HEIGHT - UPPER_ROW_HEIGHT) / 2,
      );
    }
  }

  // Upper row labels — group label spanning the relevant range.
  ctx.fillStyle = theme.fg;
  ctx.font = 'bold 11px system-ui, sans-serif';
  const upperY = UPPER_ROW_HEIGHT / 2;
  for (let d = firstDay; d <= lastDay; d++) {
    const iso = addDays(originDate, d);
    const [y, m] = iso.split('-').map(Number);
    if (!y || !m) continue;
    const day = Number(iso.slice(8, 10));
    const x = dateToPixel(iso, originDate, zoom) - scrollLeft;
    let spanDays = 0;
    let labelText = '';
    if (zoom === 'day' || zoom === 'week' || zoom === 'month') {
      if (day !== 1) continue;
      // Span = days until next month start.
      const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      spanDays = diffDays(iso, nextMonth);
      labelText = MONTH_NAMES_ZH[m - 1] ?? '';
    } else {
      // year
      if (day !== 1 || m !== 1) continue;
      const nextYear = `${y + 1}-01-01`;
      spanDays = diffDays(iso, nextYear);
      labelText = String(y);
    }
    const spanPx = spanDays * pxPerDay;
    ctx.fillText(labelText, x + spanPx / 2, upperY);
  }
}

/** Whole-day delta end - start. */
function diffDays(startISO: string, endISO: string): number {
  const [a, b, c] = startISO.split('-').map(Number);
  const [d, e, f] = endISO.split('-').map(Number);
  const ms = Date.UTC(d!, e! - 1, f!) - Date.UTC(a!, b! - 1, c!);
  return Math.round(ms / 86_400_000);
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y!, m! - 1, d!) + n * 86_400_000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
