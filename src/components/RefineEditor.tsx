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
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProcessedItem } from "../types";
import { Button } from "./ui";

type RefineTool = "restore" | "erase" | "move";

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
    };

type LoadedImage = {
  image: HTMLImageElement;
  release: () => void;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const UNDO_LIMIT = 12;
const UNDO_TILE_SIZE = 128;

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
  const sourceImageRef = useRef<HTMLImageElement>();
  const baselineImageRef = useRef<HTMLImageElement>();
  const pointerActionRef = useRef<PointerAction>();
  const activeStrokeRef = useRef<ActiveStroke>();
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

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const tiles = undoRef.current.pop();
    if (!canvas || !context || !tiles) return;
    for (const tile of tiles) {
      context.putImageData(tile.pixels, tile.x, tile.y);
    }
    setUndoCount(undoRef.current.length);
    setHasChanges(true);
  }, []);

  const reset = useCallback(() => {
    const canvas = canvasRef.current;
    const baseline = baselineImageRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !baseline || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(baseline, 0, 0);
    undoRef.current = [];
    setUndoCount(0);
    setHasChanges(false);
  }, []);

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
        setTool("restore");
      } else if (event.key.toLowerCase() === "e") {
        setTool("erase");
      } else if (event.key === "Escape" && !isSaving) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isSaving, onClose, undo]);

  const setZoomLevel = (nextZoom: number) => {
    setZoom(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM));
    if (nextZoom <= MIN_ZOOM) setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isLoading || event.button > 1) return;
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
    paintLine(action.lastX, action.lastY, point.x, point.y, point.radius);
    action.lastX = point.x;
    action.lastY = point.y;
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const action = pointerActionRef.current;
    if (!action || action.pointerId !== event.pointerId) return;
    if (action.type === "paint") finishStroke();
    pointerActionRef.current = undefined;
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
            onClick={onClose}
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
              onClick={() => setTool("restore")}
              aria-pressed={tool === "restore"}
              title="Restore pixels (R)"
            >
              <Brush size={17} />
              <span>Restore</span>
            </button>
            <button
              type="button"
              className={tool === "erase" ? "selected erase" : ""}
              onClick={() => setTool("erase")}
              aria-pressed={tool === "erase"}
              title="Erase pixels (E)"
            >
              <Eraser size={17} />
              <span>Erase</span>
            </button>
            <button
              type="button"
              className={tool === "move" ? "selected" : ""}
              onClick={() => setTool("move")}
              aria-pressed={tool === "move"}
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
              disabled={tool === "move"}
            />
            <output>{brushSize}px</output>
          </label>

          <div className="refine-history">
            <button
              type="button"
              onClick={undo}
              disabled={!undoCount}
              title="Undo last stroke (Ctrl+Z)"
            >
              <Undo2 size={17} />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={!hasChanges}
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
              tool === "move"
                ? "Drag to move. Scroll to zoom."
                : "Paint over the image. Use [ and ] to resize the brush."
            )}
          </p>
          <div className="refine-actions">
            <Button variant="secondary" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!isReady || isSaving}>
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
