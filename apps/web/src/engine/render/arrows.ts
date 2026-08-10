/**
 * Dependency arrow renderer (PRD §5.2, M2.17).
 *
 * Each arrow is drawn as a rounded orthogonal path with an arrowhead. Arrow color
 * reflects critical-path status when `showCriticalPath` is on.
 *
 * ArrowSpec carries pre-computed endpoint positions; the renderer routes around
 * the visible task rows so lines do not cut through bars or milestones.
 */
import type { Scene, ThemeColors } from './types';
import { COLUMN_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, dateRangeWidth, dateToPixel } from '../layout';
import { MILESTONE_RADIUS } from './geometry';

const ARROW_HEAD_SIZE = 6;
const ROUTE_GAP = 8;
type Side = 'left' | 'right';
export interface ArrowRoutePoint {
  x: number;
  y: number;
}

export function renderArrows(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  theme: ThemeColors,
): void {
  // Clip arrows to the content area below the header so routes
  // and arrowheads never overlap the month/day header row.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_HEIGHT, scene.viewportWidth, scene.viewportHeight - HEADER_HEIGHT);
  ctx.clip();

  for (const arrow of scene.arrows) {
    const isCritical = scene.showCriticalPath && arrow.isCritical;
    // G4: conflict arrows are orange, taking priority over critical-path red.
    const isConflict = arrow.isConflict;
    const color = isConflict ? '#f97316' : isCritical ? theme.critical : theme.fgMuted;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = isConflict || isCritical ? 2 : 1;
    drawArrowPath(ctx, arrow, scene);
  }

  ctx.restore();
}

function drawArrowPath(
  ctx: CanvasRenderingContext2D,
  arrow: Scene['arrows'][number],
  scene: Scene,
): void {
  const toSide = sideFor(arrow.type, 'to');
  const points = computeArrowRoute(arrow, scene);
  const finalDir =
    Math.sign(points[points.length - 1]!.x - points[points.length - 2]!.x) ||
    (toSide === 'right' ? -1 : 1);

  ctx.beginPath();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    const previous = points[i - 1]!;
    const next = points[i + 1];
    if (!next) {
      ctx.lineTo(point.x, point.y);
      continue;
    }
    const radius = Math.min(
      ROUTE_GAP / 2,
      distance(previous, point) / 2,
      distance(point, next) / 2,
    );
    const inPoint = moveToward(point, previous, radius);
    const outPoint = moveToward(point, next, radius);
    ctx.lineTo(inPoint.x, inPoint.y);
    ctx.quadraticCurveTo(point.x, point.y, outPoint.x, outPoint.y);
  }
  ctx.stroke();

  // Arrowhead follows the final horizontal segment, so it never points into a
  // bar or a milestone when the route approaches from the opposite side.
  const toX = arrow.toX;
  const toY = arrow.toY;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - finalDir * ARROW_HEAD_SIZE, toY - ARROW_HEAD_SIZE / 2);
  ctx.lineTo(toX - finalDir * ARROW_HEAD_SIZE, toY + ARROW_HEAD_SIZE / 2);
  ctx.closePath();
  ctx.fill();
}

function sideFor(type: Scene['arrows'][number]['type'], role: 'from' | 'to'): Side {
  if (role === 'from') return type === 'SS' || type === 'SF' ? 'left' : 'right';
  return type === 'FF' || type === 'SF' ? 'right' : 'left';
}

export function computeArrowRoute(arrow: Scene['arrows'][number], scene: Scene): ArrowRoutePoint[] {
  const fromSide = sideFor(arrow.type, 'from');
  const toSide = sideFor(arrow.type, 'to');
  const fromExit = {
    x: arrow.fromX + (fromSide === 'right' ? ROUTE_GAP : -ROUTE_GAP),
    y: arrow.fromY,
  };
  const toEntry = { x: arrow.toX + (toSide === 'right' ? ROUTE_GAP : -ROUTE_GAP), y: arrow.toY };
  const obstacles = scene.rows.map((row) => {
    const x = dateToPixel(row.start, scene.originDate, scene.zoom) - scene.scrollLeft;
    const width = Math.max(
      dateRangeWidth(row.start, row.end, scene.zoom),
      COLUMN_WIDTH[scene.zoom] / 2,
    );
    const y = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
    if (row.isMilestone) {
      return {
        id: row.id,
        left: x - MILESTONE_RADIUS,
        right: x + MILESTONE_RADIUS,
        top: y + ROW_HEIGHT / 2 - MILESTONE_RADIUS,
        bottom: y + ROW_HEIGHT / 2 + MILESTONE_RADIUS,
      };
    }
    return { id: row.id, left: x, right: x + width, top: y + 5, bottom: y + ROW_HEIGHT - 5 };
  });
  const expanded = obstacles.map((o) => ({
    ...o,
    left: o.left - ROUTE_GAP,
    right: o.right + ROUTE_GAP,
    top: o.top - 2,
    bottom: o.bottom + 2,
  }));
  const yMin = Math.min(arrow.fromY, arrow.toY);
  const yMax = Math.max(arrow.fromY, arrow.toY);
  const blocking = expanded.filter((o) => o.bottom >= yMin && o.top <= yMax);
  const peers = scene.arrows
    .filter(
      (candidate) => candidate.toId === arrow.toId && sideFor(candidate.type, 'to') === toSide,
    )
    .sort((a, b) => a.fromY - b.fromY || a.fromId.localeCompare(b.fromId));
  const channelIndex = Math.max(0, peers.indexOf(arrow));
  const outward = toSide === 'left' ? -1 : 1;
  const midpoint = (fromExit.x + toEntry.x) / 2;
  const preferredX = midpoint + outward * channelIndex * 6;
  const candidateXs = new Set<number>([fromExit.x, toEntry.x, midpoint, preferredX]);
  for (const obstacle of blocking) {
    candidateXs.add(obstacle.left - 1);
    candidateXs.add(obstacle.right + 1);
    candidateXs.add(obstacle.left - 1 + outward * channelIndex * 6);
    candidateXs.add(obstacle.right + 1 + outward * channelIndex * 6);
  }
  const safeXs = [...candidateXs].filter((x) => blocking.every((o) => x < o.left || x > o.right));
  const corridorX = (safeXs.length > 0 ? safeXs : [midpoint]).sort(
    (a, b) => Math.abs(a - preferredX) - Math.abs(b - preferredX),
  )[0]!;
  const fromRow = scene.rows.find((row) => row.id === arrow.fromId);
  const toRow = scene.rows.find((row) => row.id === arrow.toId);
  const fromCenterY = fromRow
    ? HEADER_HEIGHT + (fromRow.yIndex + 0.5) * ROW_HEIGHT - scene.scrollTop
    : arrow.fromY;
  const toCenterY = toRow
    ? HEADER_HEIGHT + (toRow.yIndex + 0.5) * ROW_HEIGHT - scene.scrollTop
    : arrow.toY;
  const above = fromCenterY - ROW_HEIGHT / 2 - ROUTE_GAP;
  const below = fromCenterY + ROW_HEIGHT / 2 + ROUTE_GAP;
  if (fromCenterY === toCenterY) {
    const detourY = above >= HEADER_HEIGHT + 2 ? above : below;
    return compactRoute([
      { x: arrow.fromX, y: arrow.fromY },
      fromExit,
      { x: fromExit.x, y: detourY },
      { x: corridorX, y: detourY },
      { x: toEntry.x, y: detourY },
      toEntry,
      { x: arrow.toX, y: arrow.toY },
    ]);
  }

  const verticalDirection = Math.sign(toCenterY - fromCenterY);
  const fromLaneY = fromCenterY + (verticalDirection * ROW_HEIGHT) / 2;
  const toLaneY = toCenterY - (verticalDirection * ROW_HEIGHT) / 2;
  return compactRoute([
    { x: arrow.fromX, y: arrow.fromY },
    fromExit,
    { x: fromExit.x, y: fromLaneY },
    { x: corridorX, y: fromLaneY },
    { x: corridorX, y: toLaneY },
    { x: toEntry.x, y: toLaneY },
    toEntry,
    { x: arrow.toX, y: arrow.toY },
  ]);
}

function compactRoute(points: ArrowRoutePoint[]): ArrowRoutePoint[] {
  const compacted: ArrowRoutePoint[] = [];
  for (const point of points) {
    const previous = compacted[compacted.length - 1];
    if (previous?.x === point.x && previous.y === point.y) continue;
    const beforePrevious = compacted[compacted.length - 2];
    if (
      beforePrevious &&
      previous &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      compacted[compacted.length - 1] = point;
      continue;
    }
    compacted.push(point);
  }
  return compacted;
}

function distance(a: ArrowRoutePoint, b: ArrowRoutePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function moveToward(
  point: ArrowRoutePoint,
  toward: ArrowRoutePoint,
  amount: number,
): ArrowRoutePoint {
  const length = distance(point, toward);
  if (length === 0) return point;
  return {
    x: point.x + ((toward.x - point.x) / length) * amount,
    y: point.y + ((toward.y - point.y) / length) * amount,
  };
}
