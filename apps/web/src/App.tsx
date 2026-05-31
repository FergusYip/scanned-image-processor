import JSZip from "jszip";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileImage,
  Focus,
  HelpCircle,
  ImagePlus,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Redo2,
  RefreshCcw,
  GripVertical,
  Settings,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, CropRegion, DetectionFailure, DetectionResult, Point, Quad, SourceImage } from "./types";
import { cropFileName, uniqueZipName } from "./lib/filenames";
import {
  cloneQuad,
  cropOutputSize,
  defaultQuad,
  isValidQuad,
  moveQuadPoint,
  nudgeQuadPoint,
} from "./lib/geometry";
import { renderCropBlob, renderCropCanvas } from "./lib/canvasCrop";

const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const detectionTimeoutMs = 20000;
const previewMinWidth = 260;
const viewfinderSize = 172;
const viewfinderMagnification = 4;

const initialSettings: AppSettings = {
  minCropAreaPercent: 4,
  jpegQuality: 92,
};

const keyboardHelp = [
  { keys: ["Delete", "Backspace"], label: "Delete selected crop" },
  { keys: ["[", "]"], label: "Previous or next crop" },
  { keys: ["P", "N"], label: "Previous or next crop" },
  { keys: ["Shift + [", "Shift + ]"], label: "Previous or next image" },
  { keys: ["PageUp", "PageDown"], label: "Previous or next image" },
  { keys: ["Arrow keys"], label: "Nudge selected handle" },
  { keys: ["Shift + Arrow keys"], label: "Nudge selected handle by 10 px" },
  { keys: ["+", "-"], label: "Zoom in or out" },
  { keys: ["0"], label: "Fit image" },
  { keys: ["Esc"], label: "Clear selected handle or close this help" },
];

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function defaultPreviewWidth() {
  return typeof window === "undefined" ? 320 : window.innerWidth * 0.5;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button className="iconButton" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} data-active={active}>
      {children}
    </button>
  );
}

function createCrop(sourceId: string, points: Quad): CropRegion {
  return {
    id: id("crop"),
    sourceId,
    points: cloneQuad(points),
    autoPoints: cloneQuad(points),
    edited: false,
  };
}

async function sourceFromFile(file: File): Promise<SourceImage> {
  const objectUrl = URL.createObjectURL(file);
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const source: SourceImage = {
    id: id("source"),
    fileName: file.name,
    fileType: file.type,
    objectUrl,
    originalWidth: bitmap.width,
    originalHeight: bitmap.height,
    displayWidth: bitmap.width,
    displayHeight: bitmap.height,
    status: "queued",
    crops: [],
    batchSelected: true,
  };
  bitmap.close();
  return source;
}

export function App() {
  const [sources, setSources] = useState<SourceImage[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string>();
  const [settings, setSettings] = useState(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedHandle, setSelectedHandle] = useState<number>();
  const [dragHandle, setDragHandle] = useState<number>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(defaultPreviewWidth);
  const [notice, setNotice] = useState<string>();
  const [stageSize, setStageSize] = useState({ width: 900, height: 620 });
  const [viewfinder, setViewfinder] = useState<{ stageX: number; stageY: number; sourceX: number; sourceY: number }>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | undefined>(undefined);
  const queueRef = useRef<SourceImage[]>([]);
  const runningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const previewResizeRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const viewportFrameRef = useRef<number | undefined>(undefined);
  const pendingViewportRef = useRef<{ zoom: number; pan: Point } | undefined>(undefined);

  const activeSource = sources.find((source) => source.id === activeSourceId);
  const selectedCrop = activeSource?.crops.find((crop) => crop.id === activeSource.selectedCropId);
  const cropIndex = activeSource && selectedCrop ? activeSource.crops.findIndex((crop) => crop.id === selectedCrop.id) + 1 : 0;
  const selectedSources = sources.filter((source) => source.batchSelected);
  const previewSource = activeSource;
  const previewCrop = selectedCrop;
  const previewCropPointsKey = previewCrop?.points.map((point) => `${point.x},${point.y}`).join("|");

  const updateSource = useCallback((sourceId: string, updater: (source: SourceImage) => SourceImage) => {
    setSources((current) => current.map((source) => (source.id === sourceId ? updater(source) : source)));
  }, []);

  const runQueue = useCallback(() => {
    if (runningRef.current || queueRef.current.length === 0) return;
    runningRef.current = true;
    const source = queueRef.current.shift()!;
    updateSource(source.id, (current) => ({ ...current, status: "processing", error: undefined }));

    const worker = workerRef.current ?? new Worker(new URL("./workers/detect.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    let timeoutId: number | undefined;
    let settled = false;

    const finishRun = () => {
      if (settled) return false;
      settled = true;
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleWorkerError);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      runningRef.current = false;
      window.setTimeout(runQueue, 0);
      return true;
    };

    const handleMessage = (event: MessageEvent<{ type: string; result?: DetectionResult; failure?: DetectionFailure }>) => {
      if (event.data.type === "result" && event.data.result) {
        const { result } = event.data;
        setSources((current) =>
          current.map((item) => {
            if (item.id !== result.sourceId) return item;
            const crops = result.quads.filter(isValidQuad).map((quad) => createCrop(item.id, quad));
            return {
              ...item,
              originalWidth: result.width,
              originalHeight: result.height,
              status: crops.length > 0 ? "ready" : "no-crops",
              crops,
              selectedCropId: crops[0]?.id,
              error: undefined,
            };
          }),
        );
      } else if (event.data.failure) {
        updateSource(event.data.failure.sourceId, (current) => ({ ...current, status: "error", error: event.data.failure!.message }));
      }
      finishRun();
    };

    const handleWorkerError = (event: ErrorEvent) => {
      if (!finishRun()) return;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = undefined;
      updateSource(source.id, (current) => ({ ...current, status: "error", error: event.message || "Detection worker failed." }));
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleWorkerError);
    timeoutId = window.setTimeout(() => {
      if (!finishRun()) return;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = undefined;
      updateSource(source.id, (current) => ({ ...current, status: "error", error: "Detection timed out." }));
    }, detectionTimeoutMs);

    fetch(source.objectUrl)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob, { imageOrientation: "from-image" }))
      .then((bitmap) => worker.postMessage({ sourceId: source.id, bitmap, minCropAreaPercent: settings.minCropAreaPercent }, [bitmap]))
      .catch((error) => {
        if (!finishRun()) return;
        updateSource(source.id, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : "Could not read image." }));
      });
  }, [settings, updateSource]);

  const enqueue = useCallback(
    (items: SourceImage[]) => {
      queueRef.current.push(...items);
      runQueue();
    },
    [runQueue],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const nextFiles = Array.from(files);
      const supported = nextFiles.filter((file) => supportedTypes.has(file.type));
      const unsupported = nextFiles.filter((file) => !supportedTypes.has(file.type));
      const created = await Promise.all(supported.map(sourceFromFile));
      if (unsupported.length > 0) setNotice(`${unsupported.length} unsupported file${unsupported.length === 1 ? "" : "s"} skipped.`);
      if (created.length === 0) return;
      setSources((current) => [...current, ...created]);
      setActiveSourceId((current) => current ?? created[0].id);
      enqueue(created);
    },
    [enqueue],
  );

  const addManualCrop = () => {
    if (!activeSource) return;
    const crop = createCrop(activeSource.id, defaultQuad(activeSource.originalWidth, activeSource.originalHeight));
    updateSource(activeSource.id, (source) => ({ ...source, status: "ready", crops: [...source.crops, crop], selectedCropId: crop.id }));
  };

  const deleteCrop = () => {
    if (!activeSource || !selectedCrop) return;
    if (!confirm("Delete selected crop?")) return;
    updateSource(activeSource.id, (source) => {
      const deletedIndex = source.crops.findIndex((crop) => crop.id === selectedCrop.id);
      const crops = source.crops.filter((crop) => crop.id !== selectedCrop.id);
      const nextIndex = Math.min(Math.max(deletedIndex, 0), crops.length - 1);
      return { ...source, crops, selectedCropId: crops[nextIndex]?.id, status: crops.length ? "ready" : "no-crops" };
    });
  };

  const deleteSource = (sourceId: string) => {
    const source = sources.find((item) => item.id === sourceId);
    if (!source || !confirm(`Remove ${source.fileName}?`)) return;
    URL.revokeObjectURL(source.objectUrl);
    setSources((current) => current.filter((item) => item.id !== sourceId));
    setActiveSourceId((current) => (current === sourceId ? sources.find((item) => item.id !== sourceId)?.id : current));
  };

  const resetCrop = () => {
    if (!activeSource || !selectedCrop) return;
    updateSource(activeSource.id, (source) => ({
      ...source,
      crops: source.crops.map((crop) => (crop.id === selectedCrop.id ? { ...crop, points: cloneQuad(crop.autoPoints), edited: false } : crop)),
    }));
  };

  const redetect = () => {
    if (!activeSource) return;
    if (activeSource.crops.some((crop) => crop.edited) && !confirm("Re-detecting will replace manual crop edits for this source. Continue?")) return;
    updateSource(activeSource.id, (source) => ({ ...source, status: "queued", crops: [], selectedCropId: undefined }));
    enqueue([{ ...activeSource, status: "queued", crops: [], selectedCropId: undefined }]);
  };

  const selectCropOffset = (offset: number) => {
    if (!activeSource || activeSource.crops.length === 0) return;
    const current = Math.max(0, activeSource.crops.findIndex((crop) => crop.id === activeSource.selectedCropId));
    const next = (current + offset + activeSource.crops.length) % activeSource.crops.length;
    updateSource(activeSource.id, (source) => ({ ...source, selectedCropId: source.crops[next].id }));
  };

  const selectSourceOffset = (offset: number) => {
    if (sources.length === 0) return;
    const current = Math.max(0, sources.findIndex((source) => source.id === activeSourceId));
    const next = (current + offset + sources.length) % sources.length;
    setActiveSourceId(sources[next].id);
  };

  const updateSelectedCrop = (updater: (crop: CropRegion) => CropRegion) => {
    if (!activeSource || !selectedCrop) return;
    updateSource(activeSource.id, (source) => ({
      ...source,
      crops: source.crops.map((crop) => (crop.id === selectedCrop.id ? updater(crop) : crop)),
    }));
  };

  const setCropPoint = (cropId: string, pointIndex: number, point: Point) => {
    if (!activeSource) return;
    updateSource(activeSource.id, (source) => ({
      ...source,
      selectedCropId: cropId,
      crops: source.crops.map((crop) => {
        if (crop.id !== cropId) return crop;
        return {
          ...crop,
          points: moveQuadPoint(crop.points, pointIndex, point, source.originalWidth, source.originalHeight),
          edited: true,
        };
      }),
    }));
  };

  const applyViewport = useCallback((next: { zoom: number; pan: Point }) => {
    zoomRef.current = next.zoom;
    panRef.current = next.pan;
    setZoom(next.zoom);
    setPan(next.pan);
  }, []);

  const scheduleViewport = useCallback((next: { zoom: number; pan: Point }) => {
    zoomRef.current = next.zoom;
    panRef.current = next.pan;
    pendingViewportRef.current = next;
    if (viewportFrameRef.current !== undefined) return;
    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = undefined;
      const pending = pendingViewportRef.current;
      pendingViewportRef.current = undefined;
      if (!pending) return;
      setZoom(pending.zoom);
      setPan(pending.pan);
    });
  }, []);

  const resetViewport = useCallback(() => applyViewport({ zoom: 1, pan: { x: 0, y: 0 } }), [applyViewport]);

  const baseImageMetrics = useMemo(() => {
    if (!activeSource) return undefined;
    const maxWidth = Math.max(320, stageSize.width - 56);
    const maxHeight = Math.max(260, stageSize.height - 56);
    const fit = Math.min(maxWidth / activeSource.originalWidth, maxHeight / activeSource.originalHeight, 1);
    const width = activeSource.originalWidth * fit;
    const height = activeSource.originalHeight * fit;
    return { fit, width, height };
  }, [activeSource, stageSize.height, stageSize.width]);

  const imageMetrics = baseImageMetrics ? { ...baseImageMetrics, left: pan.x, top: pan.y } : undefined;

  const setZoomAroundPoint = useCallback(
    (nextZoom: number, anchor?: Point, immediate = false) => {
      const clamped = Math.min(6, Math.max(1, nextZoom));
      const stage = stageRef.current?.getBoundingClientRect();

      if (!activeSource || !imageMetrics || !stage) {
        const next = { zoom: clamped, pan: panRef.current };
        if (immediate) applyViewport(next);
        else scheduleViewport(next);
        return;
      }

      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const focus = anchor ?? { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 };
      const oldScale = imageMetrics.fit * currentZoom;
      const nextScale = imageMetrics.fit * clamped;
      const oldLeft = stage.left + stage.width / 2 - (imageMetrics.width * currentZoom) / 2 + currentPan.x;
      const oldTop = stage.top + stage.height / 2 - (imageMetrics.height * currentZoom) / 2 + currentPan.y;
      const sourceX = (focus.x - oldLeft) / oldScale;
      const sourceY = (focus.y - oldTop) / oldScale;
      const nextWidth = activeSource.originalWidth * nextScale;
      const nextHeight = activeSource.originalHeight * nextScale;

      const next = {
        zoom: clamped,
        pan: {
          x: focus.x - (stage.left + stage.width / 2 - nextWidth / 2) - sourceX * nextScale,
          y: focus.y - (stage.top + stage.height / 2 - nextHeight / 2) - sourceY * nextScale,
        },
      };
      if (immediate) applyViewport(next);
      else scheduleViewport(next);
    },
    [activeSource, applyViewport, imageMetrics, scheduleViewport],
  );

  useEffect(() => {
    resetViewport();
    setSelectedHandle(undefined);
  }, [activeSourceId, resetViewport]);

  useEffect(() => {
    return () => {
      if (viewportFrameRef.current !== undefined) window.cancelAnimationFrame(viewportFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!previewSource || !previewCrop) {
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return undefined;
      });
      return;
    }
    let cancelled = false;
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      renderCropCanvas(previewSource, previewCrop, 900)
        .then((canvas) => {
          if (cancelled) return;
          canvas.toBlob((blob) => {
            if (!blob || cancelled) return;
            const url = URL.createObjectURL(blob);
            setPreviewUrl((current) => {
              if (current) URL.revokeObjectURL(current);
              return url;
            });
          }, "image/jpeg", 0.9);
        })
        .finally(() => {
          if (!cancelled) setPreviewBusy(false);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    previewCrop,
    previewCropPointsKey,
    previewSource,
    previewSource?.objectUrl,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (helpOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setHelpOpen(false);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoomAroundPoint(zoomRef.current * 1.15, undefined, true);
      }
      if (event.key === "-") {
        event.preventDefault();
        setZoomAroundPoint(zoomRef.current / 1.15, undefined, true);
      }
      if (event.key === "0") {
        event.preventDefault();
        resetViewport();
      }
      if (event.key === "[" || event.key === "{") {
        event.preventDefault();
        if (event.shiftKey || event.key === "{") selectSourceOffset(-1);
        else selectCropOffset(-1);
      }
      if (event.key === "]" || event.key === "}") {
        event.preventDefault();
        if (event.shiftKey || event.key === "}") selectSourceOffset(1);
        else selectCropOffset(1);
      }
      if (key === "p") {
        event.preventDefault();
        selectCropOffset(-1);
      }
      if (key === "n") {
        event.preventDefault();
        selectCropOffset(1);
      }
      if (event.key === "PageUp") {
        event.preventDefault();
        selectSourceOffset(-1);
      }
      if (event.key === "PageDown") {
        event.preventDefault();
        selectSourceOffset(1);
      }
      if (event.key === "Escape") {
        setSelectedHandle(undefined);
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedCrop) {
        event.preventDefault();
        deleteCrop();
      }
      if (selectedHandle !== undefined && selectedCrop && activeSource && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
        const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
        updateSelectedCrop((crop) => ({
          ...crop,
          points: nudgeQuadPoint(crop.points, selectedHandle, dx, dy, activeSource.originalWidth, activeSource.originalHeight),
          edited: true,
        }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const downloadSources = async (items: SourceImage[], label: string) => {
    const ready = items.filter((source) => source.status !== "processing" && source.crops.length > 0);
    if (ready.length === 0) {
      setNotice("No ready crops to download.");
      return;
    }
    const skipped = items.length - ready.length;
    const zip = ready.length > 1 || ready.some((source) => source.crops.length > 1) ? new JSZip() : undefined;
    const used = new Set<string>();
    for (const source of ready) {
      for (let index = 0; index < source.crops.length; index += 1) {
        const crop = source.crops[index];
        const blob = await renderCropBlob(source, crop, settings.jpegQuality);
        const name = uniqueZipName(cropFileName(source.fileName, index + 1, source.crops.length), used);
        if (zip) zip.file(name, blob);
        else triggerDownload(blob, name);
      }
    }
    if (zip) {
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(blob, `${label}.zip`);
    }
    setNotice(skipped > 0 ? `${skipped} source${skipped === 1 ? "" : "s"} skipped because no crops were ready.` : "Download prepared.");
  };

  const triggerDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onStagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current || dragHandle !== undefined) return;
    scheduleViewport({
      zoom: zoomRef.current,
      pan: {
        x: panStartRef.current.panX + event.clientX - panStartRef.current.x,
        y: panStartRef.current.panY + event.clientY - panStartRef.current.y,
      },
    });
  };

  const onOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!activeSource || !selectedCrop || dragHandle === undefined || !imageMetrics || !stageRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const stageRect = stageRef.current.getBoundingClientRect();
    const scale = imageMetrics.fit * zoom;
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    setViewfinder({
      stageX: event.clientX - stageRect.left,
      stageY: event.clientY - stageRect.top,
      sourceX: x,
      sourceY: y,
    });
    setCropPoint(selectedCrop.id, dragHandle, { x, y });
  };

  const onPreviewResizeMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = previewResizeRef.current;
    if (!start) return;
    const previewMaxWidth = window.innerWidth * 0.5;
    const nextWidth = start.width + start.x - event.clientX;
    setPreviewWidth(Math.min(previewMaxWidth, Math.max(previewMinWidth, nextWidth)));
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  };

  return (
    <main className="appShell" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <input ref={fileInputRef} className="hiddenInput" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => event.target.files && addFiles(event.target.files)} />

      <header className="topbar">
        <div className="toolGroup">
          <IconButton label="Upload images" onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} />
          </IconButton>
          <IconButton label="Add crop" onClick={addManualCrop} disabled={!activeSource}>
            <ImagePlus size={18} />
          </IconButton>
          <IconButton label="Delete crop" onClick={deleteCrop} disabled={!selectedCrop}>
            <Trash2 size={18} />
          </IconButton>
          <IconButton label="Reset crop" onClick={resetCrop} disabled={!selectedCrop}>
            <Redo2 size={18} />
          </IconButton>
          <IconButton label="Re-detect source" onClick={redetect} disabled={!activeSource || activeSource.status === "processing"}>
            <RefreshCcw size={18} />
          </IconButton>
        </div>
        <div className="sourceTitle" title={activeSource?.fileName ?? "No source selected"}>
          {activeSource?.fileName ?? "No source selected"}
        </div>
        <div className="toolGroup">
          <IconButton label="Previous crop" onClick={() => selectCropOffset(-1)} disabled={!activeSource?.crops.length}>
            <ChevronLeft size={18} />
          </IconButton>
          <div className="cropCounter">{selectedCrop ? `${cropIndex}/${activeSource?.crops.length}` : "0/0"}</div>
          <IconButton label="Next crop" onClick={() => selectCropOffset(1)} disabled={!activeSource?.crops.length}>
            <ChevronRight size={18} />
          </IconButton>
        </div>
        <div className="toolGroup">
          <IconButton label="Zoom out" onClick={() => setZoomAroundPoint(zoom / 1.15)}>
            <ZoomOut size={18} />
          </IconButton>
          <div className="cropCounter">{Math.round(zoom * 100)}%</div>
          <IconButton label="Zoom in" onClick={() => setZoomAroundPoint(zoom * 1.15)}>
            <ZoomIn size={18} />
          </IconButton>
          <IconButton label="Fit image" onClick={resetViewport}>
            <Focus size={18} />
          </IconButton>
        </div>
        <div className="toolGroup push">
          <IconButton label="Download active source" onClick={() => activeSource && downloadSources([activeSource], "active-source")} disabled={!activeSource || activeSource.status === "processing"}>
            <Download size={18} />
          </IconButton>
          <button className="textButton" type="button" onClick={() => downloadSources(selectedSources, "selected-sources")} disabled={selectedSources.length === 0}>
            Download selected
          </button>
          <button className="textButton" type="button" onClick={() => downloadSources(sources, "all-crops")} disabled={sources.length === 0}>
            Download all
          </button>
          <IconButton label="Settings" onClick={() => setSettingsOpen((current) => !current)} active={settingsOpen}>
            <Settings size={18} />
          </IconButton>
          <IconButton label="Keyboard help" onClick={() => setHelpOpen(true)} active={helpOpen}>
            <HelpCircle size={18} />
          </IconButton>
          <IconButton label={previewCollapsed ? "Show preview" : "Hide preview"} onClick={() => setPreviewCollapsed((current) => !current)}>
            {previewCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
          </IconButton>
        </div>
        {settingsOpen && (
          <div className="settingsMenu">
            <label>
              Min crop area
              <input type="range" min="1" max="12" value={settings.minCropAreaPercent} onChange={(event) => setSettings((current) => ({ ...current, minCropAreaPercent: Number(event.target.value) }))} />
              <span>{settings.minCropAreaPercent}%</span>
            </label>
            <label>
              JPEG quality
              <input type="range" min="60" max="100" value={settings.jpegQuality} onChange={(event) => setSettings((current) => ({ ...current, jpegQuality: Number(event.target.value) }))} />
              <span>{settings.jpegQuality}</span>
            </label>
          </div>
        )}
      </header>

      <section className="workspace">
        <div
          ref={stageRef}
          className="stage"
          data-pannable={activeSource ? "true" : undefined}
          data-empty={!activeSource ? "true" : undefined}
          onClick={(event) => {
            if (activeSource || event.target !== event.currentTarget) return;
            fileInputRef.current?.click();
          }}
          onWheel={(event) => {
            if (!activeSource) return;
            event.preventDefault();
            setZoomAroundPoint(zoomRef.current * (event.deltaY > 0 ? 0.92 : 1.08), { x: event.clientX, y: event.clientY });
          }}
          onPointerDown={(event) => {
            if (!activeSource || event.button !== 0) return;
            panStartRef.current = { x: event.clientX, y: event.clientY, panX: panRef.current.x, panY: panRef.current.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={onStagePointerMove}
          onPointerUp={() => {
            panStartRef.current = undefined;
          }}
          onPointerCancel={() => {
            panStartRef.current = undefined;
          }}
        >
          {!activeSource && (
            <button className="dropZone" type="button" onClick={() => fileInputRef.current?.click()}>
              <FileImage size={34} />
              <span>Upload or drop scanner-bed images</span>
              <small>JPG, PNG, and WebP stay local in this browser.</small>
            </button>
          )}
          {activeSource && imageMetrics && (
            <div
              className="imageLayer"
              style={{ width: imageMetrics.width, height: imageMetrics.height, transform: `translate(${imageMetrics.left}px, ${imageMetrics.top}px) scale(${zoom})` }}
              onDragStart={(event) => event.preventDefault()}
              onPointerMove={onOverlayPointerMove}
              onPointerUp={() => {
                setDragHandle(undefined);
                setViewfinder(undefined);
              }}
              onPointerCancel={() => {
                setDragHandle(undefined);
                setViewfinder(undefined);
              }}
            >
              <img draggable={false} src={activeSource.objectUrl} alt={activeSource.fileName} onDragStart={(event) => event.preventDefault()} />
              <svg viewBox={`0 0 ${activeSource.originalWidth} ${activeSource.originalHeight}`} className="overlay" onDragStart={(event) => event.preventDefault()}>
                {activeSource.crops.map((crop) => {
                  const selected = crop.id === activeSource.selectedCropId;
                  const points = crop.points.map((point) => `${point.x},${point.y}`).join(" ");
                  return (
                    <g
                      key={crop.id}
                      className={selected ? "cropShape selected" : "cropShape"}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        updateSource(activeSource.id, (source) => ({ ...source, selectedCropId: crop.id }));
                      }}
                    >
                      <polygon points={points} />
                      {crop.points.map((point, index) => (
                        <circle
                          key={index}
                          cx={point.x}
                          cy={point.y}
                          r={Math.max(6 / (imageMetrics.fit * zoom), 2)}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setSelectedHandle(index);
                            setDragHandle(index);
                            updateSource(activeSource.id, (source) => ({ ...source, selectedCropId: crop.id }));
                          }}
                          className={selectedHandle === index && selected ? "handle active" : "handle"}
                        />
                      ))}
                    </g>
                  );
                })}
              </svg>
              {activeSource.status === "processing" && <div className="processingVeil"><Loader2 size={22} />Processing</div>}
              {activeSource.status === "no-crops" && <div className="processingVeil">No crops</div>}
              {activeSource.status === "error" && <div className="processingVeil error">{activeSource.error}</div>}
            </div>
          )}
          {activeSource && imageMetrics && viewfinder && dragHandle !== undefined && (
            <div
              className="cropViewfinder"
              aria-hidden="true"
              style={{
                width: viewfinderSize,
                height: viewfinderSize,
                left: Math.max(18, Math.min(stageSize.width - viewfinderSize - 18, viewfinder.stageX + 24)),
                top: Math.max(18, Math.min(stageSize.height - viewfinderSize - 18, viewfinder.stageY - viewfinderSize - 24)),
                backgroundImage: `url(${activeSource.objectUrl})`,
                backgroundSize: `${activeSource.originalWidth * imageMetrics.fit * zoom * viewfinderMagnification}px ${activeSource.originalHeight * imageMetrics.fit * zoom * viewfinderMagnification}px`,
                backgroundPosition: `${viewfinderSize / 2 - viewfinder.sourceX * imageMetrics.fit * zoom * viewfinderMagnification}px ${viewfinderSize / 2 - viewfinder.sourceY * imageMetrics.fit * zoom * viewfinderMagnification}px`,
              }}
            >
              <span className="cropViewfinderCrosshair" />
              <span className="cropViewfinderReadout">{`${Math.round(viewfinder.sourceX)}, ${Math.round(viewfinder.sourceY)}`}</span>
            </div>
          )}
        </div>

        {activeSource && !previewCollapsed && (
          <aside className="previewPanel" style={{ width: previewWidth }}>
            <button
              className="previewResizeHandle"
              type="button"
              aria-label="Resize preview"
              title="Resize preview"
              onPointerDown={(event) => {
                previewResizeRef.current = { x: event.clientX, width: previewWidth };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={onPreviewResizeMove}
              onPointerUp={() => {
                previewResizeRef.current = undefined;
              }}
              onPointerCancel={() => {
                previewResizeRef.current = undefined;
              }}
            >
              <GripVertical size={16} />
            </button>
            <div className="panelHeader">
              <span>Preview</span>
              {previewBusy && <Loader2 className="spin" size={16} />}
            </div>
            <div className="previewCanvas">
              {previewUrl ? <img src={previewUrl} alt="Selected crop preview" /> : <span>No crop selected</span>}
            </div>
            <div className="settingsStack">
              <div className="metaGrid">
                <span>Status</span><strong>{selectedCrop?.edited ? "Edited" : selectedCrop ? "Detected" : "None"}</strong>
                <span>Output</span><strong>{selectedCrop ? `${cropOutputSize(selectedCrop.points).width} x ${cropOutputSize(selectedCrop.points).height}` : "-"}</strong>
              </div>
            </div>
          </aside>
        )}
      </section>

      <footer className="sourceStrip">
        {sources.map((source) => (
          <div key={source.id} className="sourceTile" data-active={source.id === activeSourceId}>
            <button className="thumbButton" type="button" onClick={() => setActiveSourceId(source.id)}>
              <img src={source.objectUrl} alt={source.fileName} />
            </button>
            <button className="checkButton" type="button" aria-label={`Batch select ${source.fileName}`} onClick={() => updateSource(source.id, (item) => ({ ...item, batchSelected: !item.batchSelected }))}>
              {source.batchSelected ? <Check size={14} /> : null}
            </button>
            <button className="removeButton" type="button" aria-label={`Remove ${source.fileName}`} onClick={() => deleteSource(source.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
        {sources.length > 0 && (
          <button className="addMoreTile" type="button" onClick={() => fileInputRef.current?.click()}>
            <Plus size={20} />
          </button>
        )}
      </footer>

      {notice && (
        <button className="toast" type="button" onClick={() => setNotice(undefined)}>
          {notice}
        </button>
      )}

      {helpOpen && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setHelpOpen(false)}>
          <section className="helpModal" role="dialog" aria-modal="true" aria-labelledby="keyboard-help-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <h2 id="keyboard-help-title">Keyboard help</h2>
              <IconButton label="Close keyboard help" onClick={() => setHelpOpen(false)}>
                <X size={16} />
              </IconButton>
            </div>
            <dl className="shortcutList">
              {keyboardHelp.map((item) => (
                <div key={item.keys.join("|")} className="shortcutRow">
                  <dt>
                    {item.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{item.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </main>
  );
}
