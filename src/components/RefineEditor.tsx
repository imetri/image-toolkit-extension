import {
  Brush,
  Check,
  Eraser,
  Hand,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { removeImageBackground } from "../lib/backgroundRemoval";
import type { ProcessedItem } from "../types";
import { Button } from "./ui";

type RefineTool = "restore" | "erase" | "magic" | "move";

type MagicPoint = {
  x: number;
  y: number;
  radius: number;
};

type MagicSelection = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type UndoTile = {
  x: number;
  y: number;
  pixels: ImageData;
};

type ActiveStroke = {
  tiles: UndoTile[];
  seenTiles: Set<number>;
};

type PointerAction =
  | {
      type: "paint";
      pointerId: number;
      lastX: number;
      lastY: number;
    }
  | {
      type: "pan";
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | {
      type: "magic";
      pointerId: number;
      lastX: number;
      lastY: number;
      points: MagicPoint[];
    };

type LoadedImage = {
  image: HTMLImageElement;
  release: () => void;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const UNDO_LIMIT = 12;
const UNDO_TILE_SIZE = 128;
const MAGIC_CANDIDATE_THRESHOLD = 64;

function loadImage(blob: Blob): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({
      image,
      release: () => URL.revokeObjectURL(url),
    });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to open this image for refinement."));
    };
    image.src = url;
  });
}

function canvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => blob
        ? resolve(blob)
        : reject(new Error("Unable to save the refined PNG.")),
      "image/png",
    );
  });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function RefineEditor({
  item,
  onClose,
  onSave,
}: {
  item: ProcessedItem;
  onClose: () => void;
  onSave: (blob: Blob) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const magicCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourceImageRef = useRef<HTMLImageElement>();
  const baselineImageRef = useRef<HTMLImageElement>();
  const pointerActionRef = useRef<PointerAction>();
  const activeStrokeRef = useRef<ActiveStroke>();
  const magicSelectionRef = useRef<MagicSelection>();
  const magicAbortRef = useRef<AbortController>();
  const undoRef = useRef<UndoTile[][]>([]);
  const [tool, setTool] = useState<RefineTool>("restore");
  const [brushSize, setBrushSize] = useState(64);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({
    width: item.width ?? 1,
    height: item.height ?? 1,
  });
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false });
  const [isLoading, setLoading] = useState(true);
  const [isReady, setReady] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [isAnalyzing, setAnalyzing] = useState(false);
  const [magicStatus, setMagicStatus] = useState("");
  const [hasMagicSelection, setHasMagicSelection] = useState(false);
  const [error, setError] = useState("");
  const [undoCount, setUndoCount] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);

  const fitScale = useMemo(() => {
    if (!viewportSize.width || !viewportSize.height) return 1;
    return Math.min(
      1,
      Math.max(
        0.01,
        Math.min(
          (viewportSize.width - 28) / imageSize.width,
          (viewportSize.height - 28) / imageSize.height,
        ),
      ),
    );
  }, [imageSize, viewportSize]);

  const displayWidth = imageSize.width * fitScale * zoom;
  const displayHeight = imageSize.height * fitScale * zoom;

  const clearMagicSelection = useCallback(() => {
    const magicCanvas = magicCanvasRef.current;
    magicCanvas?.getContext("2d")?.clearRect(
      0,
      0,
      magicCanvas.width,
      magicCanvas.height,
    );
    magicSelectionRef.current = undefined;
    setHasMagicSelection(false);
    setMagicStatus("");
  }, []);

  const drawMagicHint = useCallback((point: MagicPoint) => {
    const context = magicCanvasRef.current?.getContext("2d");
    if (!context) return;
    context.save();
    context.fillStyle = "rgba(83, 218, 190, 0.92)";
    context.beginPath();
    context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let processed: LoadedImage | undefined;
    let source: LoadedImage | undefined;

    void Promise.all([
      loadImage(item.blob),
      loadImage(item.restoreSource ?? item.blob),
    ]).then(([loadedProcessed, loadedSource]) => {
      processed = loadedProcessed;
      source = loadedSource;
      if (cancelled) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { willReadFrequently: true });
      if (!canvas || !context) {
        throw new Error("This browser cannot open the refinement canvas.");
      }
      canvas.width = loadedProcessed.image.naturalWidth;
      canvas.height = loadedProcessed.image.naturalHeight;
      const magicCanvas = magicCanvasRef.current;
      if (magicCanvas) {
        magicCanvas.width = canvas.width;
        magicCanvas.height = canvas.height;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(loadedProcessed.image, 0, 0);
      sourceImageRef.current = loadedSource.image;
      baselineImageRef.current = loadedProcessed.image;
      setImageSize({ width: canvas.width, height: canvas.height });
      setReady(true);
      setLoading(false);
    }).catch(reason => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : "Unable to refine this image.");
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      magicAbortRef.current?.abort();
      processed?.release();
      source?.release();
    };
  }, [item.blob, item.restoreSource]);

  const captureUndoTiles = useCallback((
    context: CanvasRenderingContext2D,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) => {
    const canvas = canvasRef.current;
    const stroke = activeStrokeRef.current;
    if (!canvas || !stroke) return;
    const tileColumns = Math.ceil(canvas.width / UNDO_TILE_SIZE);
    const firstTileX = Math.floor(left / UNDO_TILE_SIZE);
    const lastTileX = Math.floor((right - 1) / UNDO_TILE_SIZE);
    const firstTileY = Math.floor(top / UNDO_TILE_SIZE);
    const lastTileY = Math.floor((bottom - 1) / UNDO_TILE_SIZE);

    for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
      for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
        const key = tileY * tileColumns + tileX;
        if (stroke.seenTiles.has(key)) continue;
        stroke.seenTiles.add(key);
        const x = tileX * UNDO_TILE_SIZE;
        const y = tileY * UNDO_TILE_SIZE;
        const width = Math.min(UNDO_TILE_SIZE, canvas.width - x);
        const height = Math.min(UNDO_TILE_SIZE, canvas.height - y);
        stroke.tiles.push({
          x,
          y,
          pixels: context.getImageData(x, y, width, height),
        });
      }
    }
  }, []);

  const stamp = useCallback((x: number, y: number, radius: number) => {
    const canvas = canvasRef.current;
    const source = sourceImageRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !source || !context || radius <= 0) return;
    const left = Math.max(0, Math.floor(x - radius));
    const top = Math.max(0, Math.floor(y - radius));
    const right = Math.min(canvas.width, Math.ceil(x + radius));
    const bottom = Math.min(canvas.height, Math.ceil(y + radius));
    if (right <= left || bottom <= top) return;

    captureUndoTiles(context, left, top, right, bottom);
    const localX = x - left;
    const localY = y - top;
    const gradient = context.createRadialGradient(
      x,
      y,
      radius * 0.42,
      x,
      y,
      radius,
    );
    gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
    gradient.addColorStop(0.55, "rgba(0, 0, 0, 1)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

    if (tool === "erase") {
      context.save();
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = gradient;
      context.fillRect(left, top, right - left, bottom - top);
      context.restore();
      return;
    }

    const brushCanvas = document.createElement("canvas");
    brushCanvas.width = right - left;
    brushCanvas.height = bottom - top;
    const brushContext = brushCanvas.getContext("2d");
    if (!brushContext) return;
    const sourceScaleX = source.naturalWidth / canvas.width;
    const sourceScaleY = source.naturalHeight / canvas.height;
    brushContext.drawImage(
      source,
      left * sourceScaleX,
      top * sourceScaleY,
      (right - left) * sourceScaleX,
      (bottom - top) * sourceScaleY,
      0,
      0,
      right - left,
      bottom - top,
    );
    const brushGradient = brushContext.createRadialGradient(
      localX,
      localY,
      radius * 0.42,
      localX,
      localY,
      radius,
    );
    brushGradient.addColorStop(0, "rgba(0, 0, 0, 1)");
    brushGradient.addColorStop(0.55, "rgba(0, 0, 0, 1)");
    brushGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    brushContext.globalCompositeOperation = "destination-in";
    brushContext.fillStyle = brushGradient;
    brushContext.fillRect(0, 0, brushCanvas.width, brushCanvas.height);
    context.drawImage(brushCanvas, left, top);
  }, [captureUndoTiles, tool]);

  const analyzeMagicSelection = useCallback(async (points: MagicPoint[]) => {
    const canvas = canvasRef.current;
    const magicCanvas = magicCanvasRef.current;
    const source = sourceImageRef.current;
    const workContext = canvas?.getContext("2d", { willReadFrequently: true });
    const magicContext = magicCanvas?.getContext("2d");
    if (
      !canvas
      || !magicCanvas
      || !source
      || !workContext
      || !magicContext
      || !points.length
    ) return;

    let minimumX = canvas.width;
    let minimumY = canvas.height;
    let maximumX = 0;
    let maximumY = 0;
    let maximumRadius = 0;
    for (const point of points) {
      minimumX = Math.min(minimumX, point.x - point.radius);
      minimumY = Math.min(minimumY, point.y - point.radius);
      maximumX = Math.max(maximumX, point.x + point.radius);
      maximumY = Math.max(maximumY, point.y + point.radius);
      maximumRadius = Math.max(maximumRadius, point.radius);
    }
    const strokeWidth = Math.max(1, maximumX - minimumX);
    const strokeHeight = Math.max(1, maximumY - minimumY);
    const padding = Math.max(
      48,
      maximumRadius * 2.5,
      Math.max(strokeWidth, strokeHeight) * 0.72,
    );
    let left = clamp(Math.floor(minimumX - padding), 0, canvas.width - 1);
    let top = clamp(Math.floor(minimumY - padding), 0, canvas.height - 1);
    let right = clamp(Math.ceil(maximumX + padding), left + 1, canvas.width);
    let bottom = clamp(Math.ceil(maximumY + padding), top + 1, canvas.height);
    const minimumCropEdge = Math.max(192, Math.ceil(maximumRadius * 6));
    const expandAxis = (
      start: number,
      end: number,
      limit: number,
    ) => {
      const needed = Math.min(limit, minimumCropEdge) - (end - start);
      if (needed <= 0) return [start, end] as const;
      const before = Math.min(start, Math.ceil(needed / 2));
      const after = Math.min(limit - end, needed - before);
      const remaining = needed - before - after;
      return [
        Math.max(0, start - before - remaining),
        Math.min(limit, end + after),
      ] as const;
    };
    [left, right] = expandAxis(left, right, canvas.width);
    [top, bottom] = expandAxis(top, bottom, canvas.height);

    const cropWidth = right - left;
    const cropHeight = bottom - top;
    const analysisScale = Math.min(
      1,
      1536 / Math.max(cropWidth, cropHeight),
    );
    const analysisWidth = Math.max(2, Math.round(cropWidth * analysisScale));
    const analysisHeight = Math.max(2, Math.round(cropHeight * analysisScale));
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = analysisWidth;
    cropCanvas.height = analysisHeight;
    const cropContext = cropCanvas.getContext("2d");
    if (!cropContext) {
      setError("Unable to prepare the AI selection.");
      return;
    }
    const sourceScaleX = source.naturalWidth / canvas.width;
    const sourceScaleY = source.naturalHeight / canvas.height;
    cropContext.drawImage(
      source,
      left * sourceScaleX,
      top * sourceScaleY,
      cropWidth * sourceScaleX,
      cropHeight * sourceScaleY,
      0,
      0,
      analysisWidth,
      analysisHeight,
    );

    magicAbortRef.current?.abort();
    const controller = new AbortController();
    magicAbortRef.current = controller;
    setAnalyzing(true);
    setHasMagicSelection(false);
    setError("");
    setMagicStatus("Preparing AI selection");

    let analyzed: LoadedImage | undefined;
    try {
      const cropBlob = await canvasPng(cropCanvas);
      const result = await removeImageBackground(
        cropBlob,
        controller.signal,
        update => setMagicStatus(update.stage),
      );
      if (controller.signal.aborted) return;
      analyzed = await loadImage(result.blob);
      if (controller.signal.aborted) return;

      const resultCanvas = document.createElement("canvas");
      resultCanvas.width = analysisWidth;
      resultCanvas.height = analysisHeight;
      const resultContext = resultCanvas.getContext(
        "2d",
        { willReadFrequently:true },
      );
      if (!resultContext) throw new Error("Unable to read the AI selection.");
      resultContext.drawImage(
        analyzed.image,
        0,
        0,
        analysisWidth,
        analysisHeight,
      );
      const resultPixels = resultContext.getImageData(
        0,
        0,
        analysisWidth,
        analysisHeight,
      ).data;

      const visibleCanvas = document.createElement("canvas");
      visibleCanvas.width = analysisWidth;
      visibleCanvas.height = analysisHeight;
      const visibleContext = visibleCanvas.getContext(
        "2d",
        { willReadFrequently:true },
      );
      if (!visibleContext) throw new Error("Unable to inspect visible pixels.");
      visibleContext.drawImage(
        canvas,
        left,
        top,
        cropWidth,
        cropHeight,
        0,
        0,
        analysisWidth,
        analysisHeight,
      );
      const visiblePixels = visibleContext.getImageData(
        0,
        0,
        analysisWidth,
        analysisHeight,
      ).data;

      const seedCanvas = document.createElement("canvas");
      seedCanvas.width = analysisWidth;
      seedCanvas.height = analysisHeight;
      const seedContext = seedCanvas.getContext(
        "2d",
        { willReadFrequently:true },
      );
      if (!seedContext) throw new Error("Unable to read the painted hint.");
      seedContext.fillStyle = "#fff";
      for (const point of points) {
        seedContext.beginPath();
        seedContext.arc(
          (point.x - left) * analysisScale,
          (point.y - top) * analysisScale,
          Math.max(1, point.radius * analysisScale * 0.58),
          0,
          Math.PI * 2,
        );
        seedContext.fill();
      }
      const seedPixels = seedContext.getImageData(
        0,
        0,
        analysisWidth,
        analysisHeight,
      ).data;
      const pixelCount = analysisWidth * analysisHeight;
      let paintedAlpha = 0;
      let paintedCount = 0;
      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        if (
          seedPixels[offset + 3] > 24
          && visiblePixels[offset + 3] > 4
        ) {
          paintedAlpha += resultPixels[offset + 3];
          paintedCount += 1;
        }
      }
      if (!paintedCount) {
        throw new Error("Paint over a visible area to create an AI selection.");
      }
      const selectForeground = paintedAlpha / paintedCount >= 127.5;
      const strengths = new Uint8Array(pixelCount);
      const candidates = new Uint8Array(pixelCount);
      const selected = new Uint8Array(pixelCount);
      const queue = new Int32Array(pixelCount);
      let write = 0;

      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        const predicted = resultPixels[offset + 3];
        const sideStrength = selectForeground
          ? predicted
          : 255 - predicted;
        const strength = Math.round(
          sideStrength * visiblePixels[offset + 3] / 255,
        );
        strengths[index] = strength;
        if (strength >= MAGIC_CANDIDATE_THRESHOLD) {
          candidates[index] = 1;
          if (seedPixels[offset + 3] > 24) {
            selected[index] = 1;
            queue[write] = index;
            write += 1;
          }
        }
      }
      if (!write) {
        throw new Error(
          "The AI could not find a removable region under that hint.",
        );
      }

      for (let read = 0; read < write; read += 1) {
        const index = queue[read];
        const x = index % analysisWidth;
        const y = Math.floor(index / analysisWidth);
        if (x > 0) {
          const neighbor = index - 1;
          if (!selected[neighbor] && candidates[neighbor]) {
            selected[neighbor] = 1;
            queue[write] = neighbor;
            write += 1;
          }
        }
        if (x < analysisWidth - 1) {
          const neighbor = index + 1;
          if (!selected[neighbor] && candidates[neighbor]) {
            selected[neighbor] = 1;
            queue[write] = neighbor;
            write += 1;
          }
        }
        if (y > 0) {
          const neighbor = index - analysisWidth;
          if (!selected[neighbor] && candidates[neighbor]) {
            selected[neighbor] = 1;
            queue[write] = neighbor;
            write += 1;
          }
        }
        if (y < analysisHeight - 1) {
          const neighbor = index + analysisWidth;
          if (!selected[neighbor] && candidates[neighbor]) {
            selected[neighbor] = 1;
            queue[write] = neighbor;
            write += 1;
          }
        }
      }

      const preview = document.createElement("canvas");
      preview.width = analysisWidth;
      preview.height = analysisHeight;
      const previewContext = preview.getContext("2d");
      if (!previewContext) throw new Error("Unable to preview the AI selection.");
      const previewPixels = previewContext.createImageData(
        analysisWidth,
        analysisHeight,
      );
      for (let index = 0; index < pixelCount; index += 1) {
        if (!selected[index]) continue;
        const offset = index * 4;
        previewPixels.data[offset] = 83;
        previewPixels.data[offset + 1] = 218;
        previewPixels.data[offset + 2] = 190;
        previewPixels.data[offset + 3] = strengths[index];
      }
      previewContext.putImageData(previewPixels, 0, 0);
      magicContext.clearRect(0, 0, magicCanvas.width, magicCanvas.height);
      magicContext.imageSmoothingEnabled = true;
      magicContext.drawImage(
        preview,
        0,
        0,
        analysisWidth,
        analysisHeight,
        left,
        top,
        cropWidth,
        cropHeight,
      );
      magicSelectionRef.current = { left, top, right, bottom };
      setHasMagicSelection(true);
      setMagicStatus("AI selection ready");
    } catch (reason) {
      if (
        !(reason instanceof DOMException && reason.name === "AbortError")
        && !controller.signal.aborted
      ) {
        clearMagicSelection();
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to create the AI selection.",
        );
      }
    } finally {
      analyzed?.release();
      if (magicAbortRef.current === controller) {
        magicAbortRef.current = undefined;
        setAnalyzing(false);
      }
    }
  }, [clearMagicSelection]);

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (
      clientX < bounds.left
      || clientX > bounds.right
      || clientY < bounds.top
      || clientY > bounds.bottom
    ) return;
    return {
      x: (clientX - bounds.left) * canvas.width / bounds.width,
      y: (clientY - bounds.top) * canvas.height / bounds.height,
      radius: brushSize / 2 * canvas.width / bounds.width,
    };
  }, [brushSize]);

  const paintLine = useCallback((
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    radius: number,
  ) => {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const spacing = Math.max(1, radius * 0.28);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      stamp(
        fromX + (toX - fromX) * progress,
        fromY + (toY - fromY) * progress,
        radius,
      );
    }
  }, [stamp]);

  const finishStroke = useCallback(() => {
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = undefined;
    if (!stroke?.tiles.length) return;
    undoRef.current.push(stroke.tiles);
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
    setHasChanges(undoRef.current.length > 0);
  }, []);

  const applyMagicSelection = useCallback(() => {
    const canvas = canvasRef.current;
    const magicCanvas = magicCanvasRef.current;
    const selection = magicSelectionRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently:true });
    if (!canvas || !magicCanvas || !selection || !context) return;
    activeStrokeRef.current = { tiles: [], seenTiles:new Set() };
    captureUndoTiles(
      context,
      selection.left,
      selection.top,
      selection.right,
      selection.bottom,
    );
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.drawImage(magicCanvas, 0, 0);
    context.restore();
    finishStroke();
    clearMagicSelection();
  }, [captureUndoTiles, clearMagicSelection, finishStroke]);

  const undo = useCallback(() => {
    clearMagicSelection();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const tiles = undoRef.current.pop();
    if (!canvas || !context || !tiles) return;
    for (const tile of tiles) {
      context.putImageData(tile.pixels, tile.x, tile.y);
    }
    setUndoCount(undoRef.current.length);
    setHasChanges(undoRef.current.length > 0);
  }, [clearMagicSelection]);

  const reset = useCallback(() => {
    magicAbortRef.current?.abort();
    clearMagicSelection();
    const canvas = canvasRef.current;
    const baseline = baselineImageRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !baseline || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(baseline, 0, 0);
    undoRef.current = [];
    setUndoCount(0);
    setHasChanges(false);
  }, [clearMagicSelection]);

  const selectTool = useCallback((nextTool: RefineTool) => {
    if (isAnalyzing) return;
    clearMagicSelection();
    setError("");
    setTool(nextTool);
  }, [clearMagicSelection, isAnalyzing]);

  const closeEditor = useCallback(() => {
    magicAbortRef.current?.abort();
    onClose();
  }, [onClose]);

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas || isSaving) return;
    setSaving(true);
    setError("");
    try {
      const blob = await canvasPng(canvas);
      onSave(blob);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save the refined PNG.");
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (event.key === "[") {
        setBrushSize(current => clamp(current - 8, 12, 180));
      } else if (event.key === "]") {
        setBrushSize(current => clamp(current + 8, 12, 180));
      } else if (event.key.toLowerCase() === "r") {
        selectTool("restore");
      } else if (event.key.toLowerCase() === "e") {
        selectTool("erase");
      } else if (event.key.toLowerCase() === "w") {
        selectTool("magic");
      } else if (event.key === "Escape" && !isSaving) {
        if (isAnalyzing) {
          magicAbortRef.current?.abort();
          clearMagicSelection();
        } else if (hasMagicSelection) {
          clearMagicSelection();
        } else {
          closeEditor();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [
    clearMagicSelection,
    closeEditor,
    hasMagicSelection,
    isAnalyzing,
    isSaving,
    selectTool,
    undo,
  ]);

  const setZoomLevel = (nextZoom: number) => {
    setZoom(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM));
    if (nextZoom <= MIN_ZOOM) setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isLoading || isAnalyzing || event.button > 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "move" || event.button === 1 || event.altKey) {
      pointerActionRef.current = {
        type: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    if (tool === "magic") {
      clearMagicSelection();
      const magicPoint = {
        x:point.x,
        y:point.y,
        radius:point.radius,
      };
      drawMagicHint(magicPoint);
      pointerActionRef.current = {
        type:"magic",
        pointerId:event.pointerId,
        lastX:point.x,
        lastY:point.y,
        points:[magicPoint],
      };
      return;
    }
    activeStrokeRef.current = { tiles: [], seenTiles: new Set() };
    pointerActionRef.current = {
      type: "paint",
      pointerId: event.pointerId,
      lastX: point.x,
      lastY: point.y,
    };
    stamp(point.x, point.y, point.radius);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current?.getBoundingClientRect();
    if (viewport) {
      setCursor({
        x: event.clientX - viewport.left,
        y: event.clientY - viewport.top,
        visible: true,
      });
    }
    const action = pointerActionRef.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (action.type === "pan") {
      setPan({
        x: action.originX + event.clientX - action.startX,
        y: action.originY + event.clientY - action.startY,
      });
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    if (action.type === "magic") {
      const distance = Math.hypot(
        point.x - action.lastX,
        point.y - action.lastY,
      );
      const spacing = Math.max(1, point.radius * 0.28);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const magicPoint = {
          x:action.lastX + (point.x - action.lastX) * progress,
          y:action.lastY + (point.y - action.lastY) * progress,
          radius:point.radius,
        };
        action.points.push(magicPoint);
        drawMagicHint(magicPoint);
      }
      action.lastX = point.x;
      action.lastY = point.y;
      return;
    }
    paintLine(action.lastX, action.lastY, point.x, point.y, point.radius);
    action.lastX = point.x;
    action.lastY = point.y;
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const action = pointerActionRef.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (action.type === "paint") finishStroke();
    pointerActionRef.current = undefined;
    if (action.type === "magic") {
      if (event.type === "pointerup") {
        void analyzeMagicSelection(action.points);
      } else {
        clearMagicSelection();
      }
    }
  };

  return (
    <div className="refine-backdrop" role="presentation">
      <section
        className="refine-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="refine-title"
      >
        <header className="refine-header">
          <div>
            <h2 id="refine-title">Refine cutout</h2>
            <p title={item.name}>{item.name}</p>
          </div>
          <button
            type="button"
            className="refine-close"
            onClick={closeEditor}
            disabled={isSaving}
            aria-label="Close refine editor"
          >
            <X size={19} />
          </button>
        </header>

        <div className="refine-toolbar" aria-label="Refinement tools">
          <div className="refine-tool-group">
            <button
              type="button"
              className={tool === "restore" ? "selected restore" : ""}
              onClick={() => selectTool("restore")}
              aria-pressed={tool === "restore"}
              disabled={isAnalyzing}
              title="Restore pixels (R)"
            >
              <Brush size={17} />
              <span>Restore</span>
            </button>
            <button
              type="button"
              className={tool === "erase" ? "selected erase" : ""}
              onClick={() => selectTool("erase")}
              aria-pressed={tool === "erase"}
              disabled={isAnalyzing}
              title="Erase pixels (E)"
            >
              <Eraser size={17} />
              <span>Erase</span>
            </button>
            <button
              type="button"
              className={tool === "magic" ? "selected magic" : ""}
              onClick={() => selectTool("magic")}
              aria-pressed={tool === "magic"}
              disabled={isAnalyzing}
              title="Paint a hint for AI selection (W)"
            >
              <WandSparkles size={17} />
              <span>AI Select</span>
            </button>
            <button
              type="button"
              className={tool === "move" ? "selected" : ""}
              onClick={() => selectTool("move")}
              aria-pressed={tool === "move"}
              disabled={isAnalyzing}
              title="Move canvas"
            >
              <Hand size={17} />
              <span>Move</span>
            </button>
          </div>

          <label className="refine-size">
            <span>Brush</span>
            <input
              type="range"
              min="12"
              max="180"
              step="2"
              value={brushSize}
              onChange={event => setBrushSize(Number(event.target.value))}
              disabled={tool === "move" || isAnalyzing}
            />
            <output>{brushSize}px</output>
          </label>

          {(isAnalyzing || hasMagicSelection) && (
            <div className="magic-selection-actions" role="status">
              {isAnalyzing ? (
                <>
                  <LoaderCircle className="spin" size={16} />
                  <span>{magicStatus || "Finding region"}</span>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="apply-magic-selection"
                    onClick={applyMagicSelection}
                  >
                    <Eraser size={15} />
                    Erase highlight
                  </button>
                  <button
                    type="button"
                    className="clear-magic-selection"
                    onClick={clearMagicSelection}
                    aria-label="Clear AI selection"
                    title="Clear selection"
                  >
                    <X size={15} />
                  </button>
                </>
              )}
            </div>
          )}

          <div className="refine-history">
            <button
              type="button"
              onClick={undo}
              disabled={!undoCount || isAnalyzing}
              title="Undo last stroke (Ctrl+Z)"
            >
              <Undo2 size={17} />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={!hasChanges || isAnalyzing}
              title="Reset all refinements"
            >
              <RotateCcw size={17} />
              <span>Reset</span>
            </button>
          </div>
        </div>

        <div
          ref={viewportRef}
          className={`refine-viewport tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={() => setCursor(current => ({ ...current, visible: false }))}
          onPointerEnter={() => setCursor(current => ({ ...current, visible: true }))}
          onWheel={event => {
            event.preventDefault();
            setZoomLevel(zoom * (event.deltaY > 0 ? 0.88 : 1.14));
          }}
        >
          <canvas
            ref={canvasRef}
            className="refine-canvas"
            aria-label="Transparent image refinement canvas"
            style={{
              width: `${displayWidth}px`,
              height: `${displayHeight}px`,
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
            }}
          />
          <canvas
            ref={magicCanvasRef}
            className="refine-canvas magic-selection-canvas"
            aria-label="AI removal selection preview"
            style={{
              width: `${displayWidth}px`,
              height: `${displayHeight}px`,
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
            }}
          />
          {isLoading && (
            <div className="refine-loading" role="status">
              <LoaderCircle size={22} />
              <span>Opening full-resolution image…</span>
            </div>
          )}
          {!isLoading && tool !== "move" && cursor.visible && (
            <span
              className={`brush-cursor ${tool}`}
              aria-hidden="true"
              style={{
                width: `${brushSize}px`,
                height: `${brushSize}px`,
                left: `${cursor.x}px`,
                top: `${cursor.y}px`,
              }}
            />
          )}
        </div>

        <footer className="refine-footer">
          <div className="zoom-control">
            <button
              type="button"
              onClick={() => setZoomLevel(zoom / 1.25)}
              disabled={zoom <= MIN_ZOOM}
              aria-label="Zoom out"
            >
              <Minus size={16} />
            </button>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step="0.1"
              value={zoom}
              onChange={event => setZoomLevel(Number(event.target.value))}
              aria-label="Zoom level"
            />
            <button
              type="button"
              onClick={() => setZoomLevel(zoom * 1.25)}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Zoom in"
            >
              <Plus size={16} />
            </button>
            <button
              type="button"
              className="zoom-value"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              title="Fit image"
            >
              {Math.round(zoom * 100)}%
            </button>
          </div>
          <p className={error ? "refine-error" : "refine-help"} role={error ? "alert" : undefined}>
            {error || (
              isAnalyzing
                ? magicStatus || "Finding the exact region"
                : hasMagicSelection
                  ? "Review the highlight, then erase it or clear the selection."
                  : tool === "move"
                    ? "Drag to move. Scroll to zoom."
                    : tool === "magic"
                      ? "Paint loosely over one area. AI will highlight its exact region."
                      : "Paint over the image. Use [ and ] to resize the brush."
            )}
          </p>
          <div className="refine-actions">
            <Button variant="secondary" onClick={closeEditor} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={
                !isReady
                || isSaving
                || isAnalyzing
                || hasMagicSelection
              }
            >
              {isSaving
                ? <LoaderCircle className="spin" size={17} />
                : <Check size={17} />}
              {isSaving ? "Saving…" : "Apply refinement"}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
