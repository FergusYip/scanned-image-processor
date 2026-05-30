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
};

let cvReady = false;

async function warmOpenCv() {
  if (cvReady) return;
  try {
    await import("@techstark/opencv-js");
    cvReady = true;
  } catch {
    cvReady = false;
  }
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
      mask[y * width + x] = distance > 26 || sat > 38 ? 1 : 0;
    }
  }
  return mask;
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
      components.push({ left, top, right, bottom, count });
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
    return orderedQuadFromRect(
      Math.max(0, (component.left - pad) / scale),
      Math.max(0, (component.top - pad) / scale),
      Math.min(bitmap.width - 1, (component.right + pad) / scale),
      Math.min(bitmap.height - 1, (component.bottom + pad) / scale),
    );
  });
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { sourceId, bitmap, minCropAreaPercent } = event.data;
  try {
    await warmOpenCv();
    const quads = detect(bitmap, minCropAreaPercent);
    const result: DetectionResult = {
      sourceId,
      width: bitmap.width,
      height: bitmap.height,
      quads,
      engine: cvReady ? "opencv" : "canvas",
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
