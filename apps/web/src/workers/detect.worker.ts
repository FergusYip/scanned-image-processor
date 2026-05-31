import { detectQuadsFromImageBitmap } from "@scanned-image-processor/detection";
import type { DetectionFailure, DetectionResult } from "../types";

type RequestMessage = {
  sourceId: string;
  bitmap: ImageBitmap;
  minCropAreaPercent: number;
};

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const { sourceId, bitmap, minCropAreaPercent } = event.data;
  try {
    const result: DetectionResult = {
      sourceId,
      width: bitmap.width,
      height: bitmap.height,
      quads: detectQuadsFromImageBitmap(bitmap, { minCropAreaPercent }),
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
