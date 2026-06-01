import type { CropRegion } from "../types";
import { canvasToBlob, renderCropFromBitmap } from "../lib/canvasCrop";

type RenderRequest = {
  type: "render";
  requestId: number;
  sourceId: string;
  objectUrl: string;
  crop: CropRegion;
  quality: number;
  maxPreviewSide?: number;
};

type ClearRequest = {
  type: "clear";
  sourceId?: string;
};

type RequestMessage = RenderRequest | ClearRequest;

const bitmapCache = new Map<string, Promise<ImageBitmap>>();

function getBitmap(sourceId: string, objectUrl: string) {
  const cached = bitmapCache.get(sourceId);
  if (cached) return cached;
  const next = fetch(objectUrl)
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob, { imageOrientation: "from-image" }));
  bitmapCache.set(sourceId, next);
  return next;
}

function clearBitmap(sourceId?: string) {
  if (sourceId) {
    bitmapCache.delete(sourceId);
    return;
  }
  bitmapCache.clear();
}

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  if (event.data.type === "clear") {
    clearBitmap(event.data.sourceId);
    return;
  }

  const { requestId, sourceId, objectUrl, crop, quality, maxPreviewSide } = event.data;
  try {
    const canvas = renderCropFromBitmap(await getBitmap(sourceId, objectUrl), crop, maxPreviewSide);
    const blob = await canvasToBlob(canvas, quality);
    self.postMessage({ type: "result", requestId, blob });
  } catch (error) {
    self.postMessage({
      type: "failure",
      requestId,
      message: error instanceof Error ? error.message : "Crop render failed.",
    });
  }
};
