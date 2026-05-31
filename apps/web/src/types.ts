export type Point = {
  x: number;
  y: number;
};

export type Quad = [Point, Point, Point, Point];

export type SourceStatus = "queued" | "processing" | "ready" | "no-crops" | "error";

export type CropRegion = {
  id: string;
  sourceId: string;
  points: Quad;
  autoPoints: Quad;
  edited: boolean;
};

export type SourceImage = {
  id: string;
  fileName: string;
  fileType: string;
  objectUrl: string;
  originalWidth: number;
  originalHeight: number;
  displayWidth: number;
  displayHeight: number;
  status: SourceStatus;
  crops: CropRegion[];
  selectedCropId?: string;
  batchSelected: boolean;
  error?: string;
};

export type AppSettings = {
  minCropAreaPercent: number;
  jpegQuality: number;
};

export type DetectionResult = {
  sourceId: string;
  width: number;
  height: number;
  quads: Quad[];
};

export type DetectionFailure = {
  sourceId: string;
  message: string;
};

export type PreviewState = {
  cropId: string;
  url: string;
  width: number;
  height: number;
};
