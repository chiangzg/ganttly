/**
 * Dependency arrow renderer (PRD §5.2, M2.17; chain visuals: dependency-chain
 * spec §3).
 *
 * Each arrow is drawn as a rounded orthogonal path with an arrowhead. Arrow
 * color reflects critical-path status when `showCriticalPath` is on, and the
 * dependency-chain highlight when one is active (chain spec §5.2 priority:
 * conflict orange > chain color > critical red > muted grey; conflicts are
 * never dimmed by the spotlight — errors must stay visible).
 *
 * Chain styling:
 * - upstream (前置·过去): emerald solid line over a soft wide underglow —
 *   settled, no motion (chain spec §3.1).
 * - downstream (后续·未来): cyan line + bright marching dashes + a glow pulse
 *   traveling tail→head, staggered by BFS depth so the chain lights up
 *   level-by-level away from the origin (chain spec §3.2). Without an
 *   animation clock (prefers-reduced-motion / static render) the dashes stay
 *   fixed — still distinct from upstream.
 *
 * ArrowSpec carries pre-computed endpoint positions; the renderer routes around
 * the visible task rows so lines do not cut through bars or milestones.
 */
import type { RenderAnimation, Scene, ThemeColors } from './types';
import {
  COLUMN_WIDTH,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  dateRangeWidth,
  dateToPixel,
  milestoneCenterX,
} from '../layout';
import { MILESTONE_RADIUS } from './geometry';

const ARROW_HEAD_SIZE = 6;
const ROUTE_GAP = 8;
const CHANNEL_GAP = 6;
/** Conflict orange (G4) — the only hard-coded edge color; never dimmed. */
const CONFLICT_COLOR = '#f97316';
const CHAIN_LINE_WIDTH = 2;
const UPSTREAM_GLOW_WIDTH = 5;
/** Marching dash overlay on downstream chain edges (chain spec §3.2). */
const FLOW_DASH: readonly [number, number] = [1.5, 9];
/** One glow pulse takes this long to travel one edge. */
const PULSE_CYCLE_MS = 1600;
/** Each BFS depth level starts its pulses this much later (层层传递). */
const PULSE_STAGGER_MS = 220;
type Side = 'left' | 'right';
export interface ArrowRoutePoint {
  x: number;
  y: number;
}

interface ArrowStyle {
  color: string;
  width: number;
  /** Spotlight alpha for non-chain edges; conflict/chain edges stay at 1. */
  alpha: number;
  role?: 'upstream' | 'downstream';
}

export function renderArrows(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  theme: ThemeColors,
  animation?: RenderAnimation,
): void {
  // Clip arrows to the content area below the header so routes
  // and arrowheads never overlap the month/day header row.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEADER_HEIGHT, scene.viewportWidth, scene.viewportHeight - HEADER_HEIGHT);
  ctx.clip();

  for (const arrow of scene.arrows) {
    const style = resolveArrowStyle(arrow, scene, theme);
    const points = computeArrowRoute(arrow, scene);
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.globalAlpha = style.alpha;

    if (style.role === 'upstream') {
      // Settled underglow first (wide, faint), then the crisp solid line.
      ctx.save();
      ctx.globalAlpha = style.alpha * 0.18;
      ctx.lineWidth = UPSTREAM_GLOW_WIDTH;
      traceArrowPath(ctx, points);
      ctx.stroke();
      ctx.restore();
      ctx.lineWidth = style.width;
      traceArrowPath(ctx, points);
      ctx.stroke();
      drawArrowhead(ctx, arrow, points, ARROW_HEAD_SIZE + 1);
    } else if (style.role === 'downstream') {
      traceArrowPath(ctx, points);
      ctx.stroke();
      drawArrowhead(ctx, arrow, points, ARROW_HEAD_SIZE + 1);
      drawFlowOverlay(ctx, points, animation);
      if (animation && scene.depChain) {
        const depth = scene.depChain.downstream.get(arrow.toId) ?? 1;
        drawTravelPulse(ctx, points, depth, animation.now, style.color);
      }
    } else {
      traceArrowPath(ctx, points);
      ctx.stroke();
      drawArrowhead(ctx, arrow, points, ARROW_HEAD_SIZE);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/** Edge style resolution — the single precedence table (chain spec §5.2). */
function resolveArrowStyle(
  arrow: Scene['arrows'][number],
  scene: Scene,
  theme: ThemeColors,
): ArrowStyle {
  // G4: conflict arrows are orange, taking priority over everything else and
  // never dimmed by the spotlight.
  if (arrow.isConflict) return { color: CONFLICT_COLOR, width: 2, alpha: 1 };
  if (arrow.chainRole === 'downstream') {
    return { color: theme.depDownstream, width: CHAIN_LINE_WIDTH, alpha: 1, role: 'downstream' };
  }
  if (arrow.chainRole === 'upstream') {
    return { color: theme.depUpstream, width: CHAIN_LINE_WIDTH, alpha: 1, role: 'upstream' };
  }
  const isCritical = scene.showCriticalPath && arrow.isCritical;
  if (isCritical) {
    // Non-chain critical edges stay red but recede under the spotlight.
    return { color: theme.critical, width: 2, alpha: scene.depChain ? 0.35 : 1 };
  }
  return { color: theme.fgMuted, width: 1, alpha: scene.depChain ? 0.15 : 1 };
}

/**
 * Bright dashes marching tail→head along a downstream edge. With an animation
 * clock they flow; without one (prefers-reduced-motion, static renders) they
 * freeze — the downstream direction stays visually distinct from upstream.
 */
function drawFlowOverlay(
  ctx: CanvasRenderingContext2D,
  points: ArrowRoutePoint[],
  animation?: RenderAnimation,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  if (animation) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash(FLOW_DASH);
    const period = FLOW_DASH[0] + FLOW_DASH[1];
    ctx.lineDashOffset = -((animation.now / 45) % period);
  } else {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([3, 5]);
  }
  traceArrowPath(ctx, points);
  ctx.stroke();
  ctx.restore();
}

/**
 * A white glow dot traveling the edge tail→head once per cycle, delayed by the
 * successor's BFS depth so pulses ripple outward level-by-level (chain spec
 * §3.2). Sin envelope fades the dot in/out at the endpoints.
 */
function drawTravelPulse(
  ctx: CanvasRenderingContext2D,
  points: ArrowRoutePoint[],
  depth: number,
  now: number,
  color: string,
): void {
  const cycle = PULSE_CYCLE_MS;
  const raw = now - depth * PULSE_STAGGER_MS;
  const t = (((raw % cycle) + cycle) % cycle) / cycle;
  const alpha = Math.sin(Math.PI * t);
  if (alpha <= 0.02) return;
  const pos = pointAtLength(points, t);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Linear position at fraction `t` (0..1) of the polyline's total length. */
function pointAtLength(points: ArrowRoutePoint[], t: number): ArrowRoutePoint {
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1]! + distance(points[i - 1]!, points[i]!));
  }
  const target = t * cumulative[cumulative.length - 1]!;
  for (let i = 1; i < points.length; i++) {
    if (cumulative[i]! >= target) {
      const segment = cumulative[i]! - cumulative[i - 1]!;
      const local = segment > 0 ? (target - cumulative[i - 1]!) / segment : 0;
      return {
        x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * local,
        y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * local,
      };
    }
  }
  return points[points.length - 1]!;
}

/** Build the rounded orthogonal path (moveTo + lineTo/quadraticCurveTo). */
function traceArrowPath(ctx: CanvasRenderingContext2D, points: ArrowRoutePoint[]): void {
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
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  arrow: Scene['arrows'][number],
  points: ArrowRoutePoint[],
  size: number,
): void {
  const toSide = sideFor(arrow.type, 'to');
  // Arrowhead follows the final horizontal segment, so it never points into a
  // bar or a milestone when the route approaches from the opposite side.
  const finalDir =
    Math.sign(points[points.length - 1]!.x - points[points.length - 2]!.x) ||
    (toSide === 'right' ? -1 : 1);
  const toX = arrow.toX;
  const toY = arrow.toY;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - finalDir * size, toY - size / 2);
  ctx.lineTo(toX - finalDir * size, toY + size / 2);
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
    const y = HEADER_HEIGHT + row.yIndex * ROW_HEIGHT - scene.scrollTop;
    if (row.isMilestone) {
      // Diamond is centred on its day's END line — see `milestoneCenterX`.
      const cx = milestoneCenterX(row.start, scene.originDate, scene.zoom) - scene.scrollLeft;
      return {
        id: row.id,
        left: cx - MILESTONE_RADIUS,
        right: cx + MILESTONE_RADIUS,
        top: y + ROW_HEIGHT / 2 - MILESTONE_RADIUS,
        bottom: y + ROW_HEIGHT / 2 + MILESTONE_RADIUS,
      };
    }
    const x = dateToPixel(row.start, scene.originDate, scene.zoom) - scene.scrollLeft;
    const width = Math.max(
      dateRangeWidth(row.start, row.end, scene.zoom),
      COLUMN_WIDTH[scene.zoom] / 2,
    );
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
  // The endpoint shapes only constrain their short exit/entry segments. The
  // vertical corridor starts in the row gap, so treating those shapes as if
  // they blocked the whole route forces aligned dependencies to detour around
  // the far edge of their own bars.
  const blocking = expanded.filter(
    (o) => o.id !== arrow.fromId && o.id !== arrow.toId && o.bottom >= yMin && o.top <= yMax,
  );
  const peers = scene.arrows
    .filter(
      (candidate) => candidate.toId === arrow.toId && sideFor(candidate.type, 'to') === toSide,
    )
    .sort((a, b) => a.fromY - b.fromY || a.fromId.localeCompare(b.fromId));
  const channelIndex = Math.max(0, peers.indexOf(arrow));
  const midpoint = (fromExit.x + toEntry.x) / 2;
  const preferredX = midpoint + centeredChannelOffset(channelIndex, peers.length);
  const candidateXs = new Set<number>([fromExit.x, toEntry.x, midpoint, preferredX]);
  for (const obstacle of blocking) {
    candidateXs.add(obstacle.left - 1);
    candidateXs.add(obstacle.right + 1);
    const offset = centeredChannelOffset(channelIndex, peers.length);
    candidateXs.add(obstacle.left - 1 + offset);
    candidateXs.add(obstacle.right + 1 + offset);
  }
  const safeXs = [...candidateXs].filter((x) => blocking.every((o) => x < o.left || x > o.right));
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
  const buildRoute = (corridorX: number): ArrowRoutePoint[] => {
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
  };

  const candidates = (safeXs.length > 0 ? safeXs : [midpoint]).map((x) => ({
    x,
    route: buildRoute(x),
  }));
  candidates.sort((a, b) => {
    const aScore = routeScore(a.route, a.x, preferredX, midpoint, arrow, peers);
    const bScore = routeScore(b.route, b.x, preferredX, midpoint, arrow, peers);
    return compareScores(aScore, bScore);
  });
  return candidates[0]!.route;
}

function centeredChannelOffset(index: number, count: number): number {
  if (count <= 1 || index < 0) return 0;
  return (index - (count - 1) / 2) * CHANNEL_GAP;
}

type RouteScore = readonly [
  length: number,
  sharedChannelRisk: number,
  bends: number,
  preferredDistance: number,
  midpointDistance: number,
  x: number,
];

function routeScore(
  route: ArrowRoutePoint[],
  corridorX: number,
  preferredX: number,
  midpoint: number,
  arrow: Scene['arrows'][number],
  peers: Scene['arrows'],
): RouteScore {
  const length = route.slice(1).reduce((total, point, index) => {
    const previous = route[index]!;
    return total + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
  }, 0);
  const sharedChannelRisk = peers.reduce((risk, peer, index) => {
    if (peer === arrow) return risk;
    const peerFromSide = sideFor(peer.type, 'from');
    const peerToSide = sideFor(peer.type, 'to');
    const peerMidpoint =
      (peer.fromX +
        (peerFromSide === 'right' ? ROUTE_GAP : -ROUTE_GAP) +
        peer.toX +
        (peerToSide === 'right' ? ROUTE_GAP : -ROUTE_GAP)) /
      2;
    const peerChannel = peerMidpoint + centeredChannelOffset(index, peers.length);
    const peerEntry = peer.toX + (peerToSide === 'right' ? ROUTE_GAP : -ROUTE_GAP);
    return (
      risk +
      Math.max(0, CHANNEL_GAP - Math.abs(corridorX - peerChannel)) +
      Math.max(0, CHANNEL_GAP - Math.abs(corridorX - peerEntry))
    );
  }, 0);
  const bends = Math.max(0, route.length - 2);
  return [
    length,
    sharedChannelRisk,
    bends,
    Math.abs(corridorX - preferredX),
    Math.abs(corridorX - midpoint),
    corridorX,
  ];
}

function compareScores(a: RouteScore, b: RouteScore): number {
  for (let index = 0; index < a.length; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
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
