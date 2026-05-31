import type { Point, Quad } from "../types";

export const cloneQuad = (quad: Quad): Quad => quad.map((point) => ({ ...point })) as Quad;

export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(width - 1, 0)),
    y: Math.min(Math.max(point.y, 0), Math.max(height - 1, 0)),
  };
}

export function constrainQuad(quad: Quad, width: number, height: number): Quad {
  return quad.map((point) => clampPoint(point, width, height)) as Quad;
}

export function scaleQuad(quad: Quad, scaleX: number, scaleY: number): Quad {
  return quad.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })) as Quad;
}

export function translateQuad(quad: Quad, dx: number, dy: number): Quad {
  return quad.map((point) => ({ x: point.x + dx, y: point.y + dy })) as Quad;
}

export function quadBounds(quad: Quad) {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

export function defaultQuad(width: number, height: number): Quad {
  const insetX = Math.round(width * 0.18);
  const insetY = Math.round(height * 0.18);
  return [
    { x: insetX, y: insetY },
    { x: width - insetX, y: insetY },
    { x: width - insetX, y: height - insetY },
    { x: insetX, y: height - insetY },
  ];
}

export function orderedQuadFromRect(left: number, top: number, right: number, bottom: number): Quad {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function signedArea(quad: Quad): number {
  return quad.reduce((area, point, index) => {
    const next = quad[(index + 1) % quad.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function isValidQuad(quad: Quad): boolean {
  const bounds = quadBounds(quad);
  if (bounds.width < 4 || bounds.height < 4) return false;
  if (Math.abs(signedArea(quad)) < 16) return false;
  if (intersects(quad[0], quad[1], quad[2], quad[3]) || intersects(quad[1], quad[2], quad[3], quad[0])) return false;

  const turns = quad.map((point, index) => {
    const next = quad[(index + 1) % quad.length];
    const after = quad[(index + 2) % quad.length];
    return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
  });
  const nonZero = turns.filter((turn) => Math.abs(turn) > 0.001);
  return nonZero.length === 4 && nonZero.every((turn) => Math.sign(turn) === Math.sign(nonZero[0]));
}

export function moveQuadPoint(
  quad: Quad,
  pointIndex: number,
  nextPoint: Point,
  imageWidth: number,
  imageHeight: number,
): Quad {
  const next = cloneQuad(quad);
  next[pointIndex] = clampPoint(nextPoint, imageWidth, imageHeight);
  return isValidQuad(next) ? next : quad;
}

export function nudgeQuadPoint(
  quad: Quad,
  pointIndex: number,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): Quad {
  return moveQuadPoint(
    quad,
    pointIndex,
    { x: quad[pointIndex].x + dx, y: quad[pointIndex].y + dy },
    imageWidth,
    imageHeight,
  );
}

export function cropOutputSize(quad: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const topWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomWidth = Math.hypot(br.x - bl.x, br.y - bl.y);
  const rightHeight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const leftHeight = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  return {
    width: Math.max(1, Math.round(Math.max(topWidth, bottomWidth))),
    height: Math.max(1, Math.round(Math.max(leftHeight, rightHeight))),
  };
}

export function trimAmountToTolerance(amount: number): number {
  const clamped = Math.min(200, Math.max(0, amount));
  return Math.round(8 + clamped * 0.42);
}
