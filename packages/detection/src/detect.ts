export type Point = {
  x: number;
  y: number;
};

export type Quad = [Point, Point, Point, Point];

export type DetectionResult = {
  sourceId: string;
  width: number;
  height: number;
  quads: Quad[];
};

export type DetectOptions = {
  minCropAreaPercent?: number;
};

export type RgbaImage = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

type Component = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  count: number;
  boundary: Point[];
  columnCounts: Map<number, number>;
  rowCounts: Map<number, number>;
};

type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function orderedQuadFromRect(left: number, top: number, right: number, bottom: number): Quad {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

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
      const brightness = (r + g + b) / 3;
      const isLightNeutral = brightness > 235 && sat < 24;
      mask[y * width + x] = !isLightNeutral && (distance > 26 || sat > 38) ? 1 : 0;
    }
  }
  return mask;
}

function buildBackgroundMask(data: Uint8ClampedArray, width: number, height: number, bg: number[]) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const colorDistance = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
      mask[y * width + x] = colorDistance <= 20 && saturation(r, g, b) <= 28 ? 1 : 0;
    }
  }
  return mask;
}

function splitHorizontalGaps(mask: Uint8Array, width: number, height: number) {
  const split = new Uint8Array(mask);
  const minRun = Math.max(8, Math.round(height * 0.003));
  const sparseThreshold = Math.max(6, Math.round(width * 0.015));
  let gapStart: number | undefined;

  for (let y = 0; y < height; y += 1) {
    let active = 0;
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      active += mask[offset + x];
    }

    if (active <= sparseThreshold) {
      gapStart ??= y;
      continue;
    }

    if (gapStart !== undefined) {
      if (y - gapStart >= minRun) {
        split.fill(0, gapStart * width, y * width);
      }
      gapStart = undefined;
    }
  }

  if (gapStart !== undefined && height - gapStart >= minRun) {
    split.fill(0, gapStart * width, height * width);
  }

  return split;
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

function backgroundFraction(mask: Uint8Array, width: number, left: number, top: number, right: number, bottom: number) {
  let background = 0;
  let total = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      background += mask[y * width + x];
      total += 1;
    }
  }
  return total === 0 ? 1 : background / total;
}

function verticalBackgroundFraction(mask: Uint8Array, width: number, x: number, top: number, bottom: number, radius: number) {
  return backgroundFraction(mask, width, Math.max(0, x - radius), top, Math.min(width - 1, x + radius), bottom);
}

function horizontalBackgroundFraction(mask: Uint8Array, width: number, y: number, left: number, right: number, radius: number) {
  const height = Math.floor(mask.length / width);
  return backgroundFraction(mask, width, left, Math.max(0, y - radius), right, Math.min(height - 1, y + radius));
}

function findFirstContentAfterEdgeNoise(
  low: number,
  high: number,
  threshold: number,
  minBackgroundRun: number,
  backgroundAt: (value: number) => number,
) {
  let backgroundRun = 0;
  let sawBackgroundRun = low > 0;

  for (let value = low; value <= high; value += 1) {
    const isBackground = backgroundAt(value) >= threshold;
    if (isBackground) {
      backgroundRun += 1;
      if (backgroundRun >= minBackgroundRun) sawBackgroundRun = true;
      continue;
    }

    if (sawBackgroundRun) return value;
    backgroundRun = 0;
  }

  return low;
}

function findLastContentBeforeEdgeNoise(
  low: number,
  high: number,
  limit: number,
  threshold: number,
  minBackgroundRun: number,
  backgroundAt: (value: number) => number,
) {
  let backgroundRun = 0;
  let sawBackgroundRun = high < limit;

  for (let value = high; value >= low; value -= 1) {
    const isBackground = backgroundAt(value) >= threshold;
    if (isBackground) {
      backgroundRun += 1;
      if (backgroundRun >= minBackgroundRun) sawBackgroundRun = true;
      continue;
    }

    if (sawBackgroundRun) return value;
    backgroundRun = 0;
  }

  return high;
}

function refineBoundsFromBackground(component: Component, backgroundMask: Uint8Array, width: number, height: number): Bounds {
  const margin = Math.round(Math.min(width, height) * 0.016);
  const edgeRadius = Math.max(2, Math.round(Math.min(width, height) * 0.002));
  const minBackgroundRun = Math.max(4, edgeRadius * 2);
  const roi: Bounds = {
    left: Math.max(0, component.left - margin),
    top: Math.max(0, component.top - margin),
    right: Math.min(width - 1, component.right + margin),
    bottom: Math.min(height - 1, component.bottom + margin),
  };

  const threshold = 0.88;
  const left = findFirstContentAfterEdgeNoise(roi.left, roi.right, threshold, minBackgroundRun, (x) =>
    verticalBackgroundFraction(backgroundMask, width, x, roi.top, roi.bottom, edgeRadius),
  );
  const right = findLastContentBeforeEdgeNoise(roi.left, roi.right, width - 1, threshold, minBackgroundRun, (x) =>
    verticalBackgroundFraction(backgroundMask, width, x, roi.top, roi.bottom, edgeRadius),
  );
  const top = findFirstContentAfterEdgeNoise(roi.top, roi.bottom, threshold, minBackgroundRun, (y) =>
    horizontalBackgroundFraction(backgroundMask, width, y, roi.left, roi.right, edgeRadius),
  );
  const bottom = findLastContentBeforeEdgeNoise(roi.top, roi.bottom, height - 1, threshold, minBackgroundRun, (y) =>
    horizontalBackgroundFraction(backgroundMask, width, y, roi.left, roi.right, edgeRadius),
  );

  if (right <= left || bottom <= top) {
    return component;
  }

  return { left, top, right, bottom };
}

function denseAxisBounds(counts: Map<number, number>, low: number, high: number) {
  let maxCount = 0;
  for (const count of counts.values()) maxCount = Math.max(maxCount, count);
  const threshold = Math.max(10, Math.floor(maxCount * 0.08));

  let start = low;
  for (let value = low; value <= high; value += 1) {
    if ((counts.get(value) ?? 0) >= threshold) {
      start = value;
      break;
    }
  }

  let end = high;
  for (let value = high; value >= low; value -= 1) {
    if ((counts.get(value) ?? 0) >= threshold) {
      end = value;
      break;
    }
  }

  return { start, end };
}

function denseComponentBounds(component: Component): Bounds {
  const x = denseAxisBounds(component.columnCounts, component.left, component.right);
  const y = denseAxisBounds(component.rowCounts, component.top, component.bottom);
  if (x.end <= x.start || y.end <= y.start) return component;
  return {
    left: x.start,
    top: y.start,
    right: x.end,
    bottom: y.end,
  };
}

function insetBounds(bounds: Bounds, inset: number): Bounds {
  return {
    left: Math.min(bounds.left + inset, bounds.right),
    top: Math.min(bounds.top + inset, bounds.bottom),
    right: Math.max(bounds.right - inset, bounds.left),
    bottom: Math.max(bounds.bottom - inset, bounds.top),
  };
}

function keepPlausibleImageEdges(refined: Bounds, component: Component, width: number, height: number): Bounds {
  const edgeMargin = Math.round(Math.min(width, height) * 0.02);
  return {
    left: refined.left <= 1 && component.left > edgeMargin ? component.left : refined.left,
    top: refined.top <= 1 && component.top > edgeMargin ? component.top : refined.top,
    right: refined.right >= width - 2 && component.right < width - edgeMargin ? component.right : refined.right,
    bottom: refined.bottom >= height - 2 && component.bottom < height - edgeMargin ? component.bottom : refined.bottom,
  };
}

function hasLongDiagonalEdge(quad: Quad, bounds: Bounds) {
  const boundsWidth = Math.max(1, bounds.right - bounds.left + 1);
  const boundsHeight = Math.max(1, bounds.bottom - bounds.top + 1);
  return quad.some((point, index) => {
    const next = quad[(index + 1) % quad.length];
    const horizontalSpan = Math.abs(next.x - point.x) / boundsWidth;
    const verticalSpan = Math.abs(next.y - point.y) / boundsHeight;
    return horizontalSpan > 0.08 && verticalSpan > 0.3;
  });
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
    const columnCounts = new Map<number, number>();
    const rowCounts = new Map<number, number>();

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
      columnCounts.set(x, (columnCounts.get(x) ?? 0) + 1);
      rowCounts.set(y, (rowCounts.get(y) ?? 0) + 1);
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
      components.push({ left, top, right, bottom, count, boundary, columnCounts, rowCounts });
    }
  }

  return components
    .filter((component) => component.right - component.left > 80 && component.bottom - component.top > 80)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .slice(0, 24);
}

function resizeRgba(image: RgbaImage, width: number, height: number): Uint8ClampedArray {
  if (image.width === width && image.height === height) {
    return image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data);
  }

  const resized = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y / height) * image.height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x / width) * image.width));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      resized[targetOffset] = image.data[sourceOffset];
      resized[targetOffset + 1] = image.data[sourceOffset + 1];
      resized[targetOffset + 2] = image.data[sourceOffset + 2];
      resized[targetOffset + 3] = image.data[sourceOffset + 3] ?? 255;
    }
  }
  return resized;
}

export function detectQuadsFromRgba(image: RgbaImage, options: DetectOptions = {}): Quad[] {
  const minCropAreaPercent = options.minCropAreaPercent ?? 4;
  const longest = Math.max(image.width, image.height);
  const scale = Math.min(1, 2600 / longest);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = resizeRgba(image, width, height);
  const bg = estimateBackground(data, width, height);
  const mask = splitHorizontalGaps(buildMask(data, width, height, bg), width, height);
  const backgroundMask = buildBackgroundMask(data, width, height, bg);
  const minArea = width * height * (minCropAreaPercent / 100);
  const components = findComponents(mask, width, height, minArea);
  return components.map((component): Quad => {
    const denseBounds = denseComponentBounds(component);
    const refinedBounds = refineBoundsFromBackground({ ...component, ...denseBounds }, backgroundMask, width, height);
    const bounds = insetBounds(keepPlausibleImageEdges(refinedBounds, { ...component, ...denseBounds }, width, height), 1);
    const pad = Math.round(Math.min(width, height) * 0.002);
    const fallback = orderedQuadFromRect(bounds.left, bounds.top, bounds.right, bounds.bottom);
    const fitted = component.boundary.length >= 4 ? (contourQuad(component.boundary, fallback) ?? minAreaQuad(component.boundary, fallback)) : fallback;
    const fittedArea = polygonArea(fitted);
    const fallbackArea = polygonArea(fallback);
    const quad = fittedArea >= fallbackArea * 0.9 && fittedArea <= fallbackArea * 1.08 && !hasLongDiagonalEdge(fitted, bounds) ? fitted : fallback;
    return padQuad(
      quad.map((point) => ({ x: point.x / scale, y: point.y / scale })) as Quad,
      pad / scale,
      image.width,
      image.height,
    );
  });
}

export function createDetectionResult(sourceId: string, image: RgbaImage, options: DetectOptions = {}): DetectionResult {
  return {
    sourceId,
    width: image.width,
    height: image.height,
    quads: detectQuadsFromRgba(image, options),
  };
}

export function detectQuadsFromImageBitmap(bitmap: ImageBitmap, options: DetectOptions = {}): Quad[] {
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 2600 / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Worker canvas is unavailable.");
  context.drawImage(bitmap, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  return detectQuadsFromRgba({ data: image.data, width, height }, options).map(
    (quad) => quad.map((point) => ({ x: point.x / scale, y: point.y / scale })) as Quad,
  );
}
