import type { CropRegion, Quad, SourceImage } from "../types";
import { cropOutputSize, quadBounds } from "./geometry";

type Matrix3 = [number, number, number, number, number, number, number, number, number];

const bitmapCache = new Map<string, Promise<ImageBitmap>>();

function getBitmap(source: SourceImage): Promise<ImageBitmap> {
  const cached = bitmapCache.get(source.id);
  if (cached) return cached;
  const next = fetch(source.objectUrl)
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob, { imageOrientation: "from-image" }));
  bitmapCache.set(source.id, next);
  return next;
}

function solveLinearSystem(matrix: number[][], values: number[]): number[] {
  const rows = matrix.map((row, index) => [...row, values[index]]);
  const n = values.length;

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col] || 1;
    for (let j = col; j <= n; j += 1) rows[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let j = col; j <= n; j += 1) rows[row][j] -= factor * rows[col][j];
    }
  }

  return rows.map((row) => row[n]);
}

function homographyFromOutputToSource(quad: Quad, width: number, height: number): Matrix3 {
  const src = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];

  const a: number[][] = [];
  const b: number[] = [];
  src.forEach((point, index) => {
    const target = quad[index];
    a.push([point.x, point.y, 1, 0, 0, 0, -point.x * target.x, -point.y * target.x]);
    b.push(target.x);
    a.push([0, 0, 0, point.x, point.y, 1, -point.x * target.y, -point.y * target.y]);
    b.push(target.y);
  });

  const h = solveLinearSystem(a, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function sampleBilinear(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
  const wx = x - x0;
  const wy = y - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  return [0, 1, 2, 3].map((channel) => {
    const top = data[i00 + channel] * (1 - wx) + data[i10 + channel] * wx;
    const bottom = data[i01 + channel] * (1 - wx) + data[i11 + channel] * wx;
    return top * (1 - wy) + bottom * wy;
  });
}

export async function renderCropCanvas(
  source: SourceImage,
  crop: CropRegion,
  maxPreviewSide?: number,
): Promise<HTMLCanvasElement> {
  const bitmap = await getBitmap(source);
  const output = cropOutputSize(crop.points);
  const scale = maxPreviewSide ? Math.min(1, maxPreviewSide / Math.max(output.width, output.height)) : 1;
  const width = Math.max(1, Math.round(output.width * scale));
  const height = Math.max(1, Math.round(output.height * scale));
  const scaledQuad = crop.points.map((point) => ({ x: point.x * scale, y: point.y * scale })) as Quad;
  const bounds = quadBounds(scaledQuad);

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = Math.ceil(bounds.width + 4);
  sourceCanvas.height = Math.ceil(bounds.height + 4);
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) throw new Error("Canvas is unavailable.");
  sourceContext.drawImage(
    bitmap,
    bounds.left / scale - 2 / scale,
    bounds.top / scale - 2 / scale,
    sourceCanvas.width / scale,
    sourceCanvas.height / scale,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
  );

  const localQuad = scaledQuad.map((point) => ({ x: point.x - bounds.left + 2, y: point.y - bounds.top + 2 })) as Quad;
  const sourceData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  const target = context.createImageData(width, height);
  const h = homographyFromOutputToSource(localQuad, width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denom = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / denom;
      const sy = (h[3] * x + h[4] * y + h[5]) / denom;
      const rgba = sampleBilinear(sourceData.data, sourceCanvas.width, sourceCanvas.height, sx, sy);
      const offset = (y * width + x) * 4;
      target.data[offset] = rgba[0];
      target.data[offset + 1] = rgba[1];
      target.data[offset + 2] = rgba[2];
      target.data[offset + 3] = 255;
    }
  }

  context.putImageData(target, 0, 0);
  return canvas;
}

export async function renderCropBlob(source: SourceImage, crop: CropRegion, quality: number): Promise<Blob> {
  const canvas = await renderCropCanvas(source, crop);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode JPEG."))),
      "image/jpeg",
      Math.min(1, Math.max(0.1, quality / 100)),
    );
  });
}
