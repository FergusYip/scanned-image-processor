import type { DetectionFailure, DetectionResult, Quad } from "../types";
import { orderedQuadFromRect } from "../lib/geometry";

type RequestMessage = {
  sourceId: string;
  bitmap: ImageBitmap;
  minCropAreaPercent: number;
};

type Component = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
  boundary: Point[];
};

type Point = {
  x: number;
  y: number;
};

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 255;
}

function estimateBackground(data: Uint8ClampedArray, width: number, height: number) {
  const sample = Math.max(8, Math.min(48, Math.floor(Math.min(width, height) / 12)));
  const channels: number[][] = [[], [], []];
  const patches = [
    [0, 0],
    [width - sample, 0],
    [0, height - sample],
    [width - sample, height - sample],
  ];

  for (const [startX, startY] of patches) {
    for (let y = startY; y < startY + sample; y += 2) {
      for (let x = startX; x < startX + sample; x += 2) {
        const offset = (y * width + x) * 4;
        channels[0].push(data[offset]);
        channels[1].push(data[offset + 1]);
        channels[2].push(data[offset + 2]);
      }
    }
  }

  return channels.map(median);
}

function saturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : ((max - min) / max) * 255;
}

function buildMask(data: Uint8ClampedArray, width: number, height: number, bg: number[]) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const distance = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
      const sat = saturation(r, g, b);
      mask[y * width + x] = distance > 26 || sat > 38 ? 1 : 0;
    }
  }
  return mask;
}

function isBoundaryPixel(mask: Uint8Array, width: number, height: number, x: number, y: number) {
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
  return !mask[y * width + x - 1] || !mask[y * width + x + 1] || !mask[(y - 1) * width + x] || !mask[(y + 1) * width + x];
}

function cross(origin: Point, a: Point, b: Point) {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(points: Point[]) {
  return Math.abs(
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

function polygonPerimeter(points: Point[]) {
  return points.reduce((sum, point, index) => sum + distance(point, points[(index + 1) % points.length]), 0);
}

function maxDistanceToPolygon(point: Point, polygon: Point[]) {
  return Math.min(...polygon.map((start, index) => lineDistance(point, start, polygon[(index + 1) % polygon.length])));
}

function maxBoundaryDeviation(boundary: Point[], polygon: Point[]) {
  return Math.max(...boundary.map((point) => maxDistanceToPolygon(point, polygon)));
}

function lineDistance(point: Point, start: Point, end: Point) {
  const length = distance(start, end);
  if (length === 0) return distance(point, start);
  return Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / length;
}

function simplifyLine(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;

  let maxDistance = 0;
  let splitIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    const currentDistance = lineDistance(points[index], first, last);
    if (currentDistance > maxDistance) {
      maxDistance = currentDistance;
      splitIndex = index;
    }
  }

  if (maxDistance <= epsilon) return [first, last];

  const left = simplifyLine(points.slice(0, splitIndex + 1), epsilon);
  const right = simplifyLine(points.slice(splitIndex), epsilon);
  return left.slice(0, -1).concat(right);
}

function simplifyClosedHull(hull: Point[], epsilon: number) {
  if (hull.length <= 4) return hull;
  const center = {
    x: hull.reduce((sum, point) => sum + point.x, 0) / hull.length,
    y: hull.reduce((sum, point) => sum + point.y, 0) / hull.length,
  };
  const start = hull.reduce((best, point, index) => (distance(point, center) > distance(hull[best], center) ? index : best), 0);
  const rotated = hull.slice(start).concat(hull.slice(0, start), hull[start]);
  const simplified = simplifyLine(rotated, epsilon);
  return simplified.slice(0, -1);
}

function convexHull(points: Point[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= 1) return sorted;

  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }

  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function contourQuad(points: Point[], fallback: Quad): Quad | undefined {
  const hull = convexHull(points);
  if (hull.length < 4) return undefined;

  const hullArea = polygonArea(hull);
  const fallbackArea = polygonArea(fallback);
  const perimeter = polygonPerimeter(hull);
  if (hullArea <= 0 || perimeter <= 0) return undefined;

  let best:
    | {
        quad: Quad;
        score: number;
      }
    | undefined;

  for (const ratio of [0.006, 0.01, 0.014, 0.02, 0.028, 0.04, 0.055, 0.075]) {
    const simplified = simplifyClosedHull(hull, perimeter * ratio);
    if (simplified.length !== 4) continue;

    const area = polygonArea(simplified);
    if (area >= hullArea * 0.82 && area >= fallbackArea * 0.55) {
      const deviation = maxBoundaryDeviation(hull, simplified);
      const areaLoss = Math.max(0, hullArea - area) / hullArea;
      const score = deviation / perimeter + areaLoss * 0.5;
      if (!best || score < best.score) best = { quad: orderQuad(simplified), score };
    }
  }

  return best?.quad;
}

function orderQuad(points: Point[]): Quad {
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  const start = sorted.reduce((best, point, index) => (point.x + point.y < sorted[best].x + sorted[best].y ? index : best), 0);
  return [sorted[start], sorted[(start + 1) % 4], sorted[(start + 2) % 4], sorted[(start + 3) % 4]];
}

function minAreaQuad(points: Point[], fallback: Quad): Quad {
  const hull = convexHull(points);
  if (hull.length < 4) return fallback;

  let best:
    | {
        area: number;
        corners: Point[];
      }
    | undefined;
  const seenAngles = new Set<number>();

  for (let index = 0; index < hull.length; index += 1) {
    const current = hull[index];
    const next = hull[(index + 1) % hull.length];
    const edgeAngle = Math.atan2(next.y - current.y, next.x - current.x);
    const angle = ((edgeAngle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const key = Math.round(angle * 100000);
    if (seenAngles.has(key)) continue;
    seenAngles.add(key);

    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const point of hull) {
      const x = point.x * cos - point.y * sin;
      const y = point.x * sin + point.y * cos;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) {
      const restoreCos = Math.cos(angle);
      const restoreSin = Math.sin(angle);
      const rotated = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
      best = {
        area,
        corners: rotated.map((point) => ({
          x: point.x * restoreCos - point.y * restoreSin,
          y: point.x * restoreSin + point.y * restoreCos,
        })),
      };
    }
  }

  return best ? orderQuad(best.corners) : fallback;
}

function padQuad(quad: Quad, pad: number, width: number, height: number): Quad {
  const center = {
    x: quad.reduce((sum, point) => sum + point.x, 0) / quad.length,
    y: quad.reduce((sum, point) => sum + point.y, 0) / quad.length,
  };
  return quad.map((point) => {
    const length = Math.hypot(point.x - center.x, point.y - center.y) || 1;
    return {
      x: Math.min(width - 1, Math.max(0, point.x + ((point.x - center.x) / length) * pad)),
      y: Math.min(height - 1, Math.max(0, point.y + ((point.y - center.y) / length) * pad)),
    };
  }) as Quad;
}

function findComponents(mask: Uint8Array, width: number, height: number, minArea: number) {
  const seen = new Uint8Array(mask.length);
  const components: Component[] = [];
  const queue: number[] = [];

  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || seen[i]) continue;
    seen[i] = 1;
    queue.length = 0;
    queue.push(i);
    let cursor = 0;
    let left = width;
    let top = height;
    let right = 0;
    let bottom = 0;
    let count = 0;
    const boundary: Point[] = [];

    while (cursor < queue.length) {
      const next = queue[cursor];
      cursor += 1;
      const x = next % width;
      const y = Math.floor(next / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      count += 1;
      if (isBoundaryPixel(mask, width, height, x, y)) boundary.push({ x, y });

      const neighbors = [next - 1, next + 1, next - width, next + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= mask.length || seen[neighbor] || !mask[neighbor]) continue;
        const nx = neighbor % width;
        if (Math.abs(nx - x) > 1) continue;
        seen[neighbor] = 1;
        queue.push(neighbor);
      }
    }

    const boxArea = (right - left + 1) * (bottom - top + 1);
    if (count >= minArea && boxArea >= minArea && count / boxArea > 0.18) {
      components.push({ left, top, right, bottom, count, boundary });
    }
  }

  return components
    .filter((component) => component.right - component.left > 80 && component.bottom - component.top > 80)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .slice(0, 24);
}

function detect(bitmap: ImageBitmap, minCropAreaPercent: number): DetectionResult["quads"] {
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 2600 / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Worker canvas is unavailable.");
  context.drawImage(bitmap, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const bg = estimateBackground(image.data, width, height);
  const mask = buildMask(image.data, width, height, bg);
  const minArea = width * height * (minCropAreaPercent / 100);
  const components = findComponents(mask, width, height, minArea);
  return components.map((component): Quad => {
    const pad = Math.round(Math.min(width, height) * 0.004);
    const fallback = orderedQuadFromRect(component.left, component.top, component.right, component.bottom);
    const quad = component.boundary.length >= 4 ? (contourQuad(component.boundary, fallback) ?? minAreaQuad(component.boundary, fallback)) : fallback;
    return padQuad(
      quad.map((point) => ({ x: point.x / scale, y: point.y / scale })) as Quad,
      pad / scale,
      bitmap.width,
      bitmap.height,
    );
  });
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { sourceId, bitmap, minCropAreaPercent } = event.data;
  try {
    const quads = detect(bitmap, minCropAreaPercent);
    const result: DetectionResult = {
      sourceId,
      width: bitmap.width,
      height: bitmap.height,
      quads,
    };
    self.postMessage({ type: "result", result });
  } catch (error) {
    const failure: DetectionFailure = {
      sourceId,
      message: error instanceof Error ? error.message : "Detection failed.",
    };
    self.postMessage({ type: "failure", failure });
  } finally {
    bitmap.close();
  }
};
