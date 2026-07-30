import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import JSZip from "jszip";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeftRight,
  Check,
  ChevronDown,
  CircleMinus,
  Download,
  Eraser,
  Maximize2,
  Play,
  Paintbrush,
  Plus,
  Trash2,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import { Button, Toggle } from "./components/ui";
import { RefineEditor } from "./components/RefineEditor";
import { useImageQueue } from "./hooks/useImageQueue";
import { processImage } from "./lib/imageProcessor";
import { IMAGE_FILE_ACCEPT, isRawImage } from "./lib/imageFormats";
import { rawProcessingConcurrency } from "./lib/rawDecoder";
import { formatBytes } from "./lib/utils";
import type { Operation, OutputFormat, ProcessedItem } from "./types";

const BUILD_VERSION = "0.1.1";

type BatchProgress = {
  current: number;
  total: number;
  filename: string;
  percent: number;
  stage: string;
  secondsRemaining?: number;
};

const operations: Array<{
  value: Operation;
  label: string;
  description: string;
  icon: typeof ArrowLeftRight;
}> = [
  {
    value: "convert",
    label: "Convert",
    description: "Change file format",
    icon: ArrowLeftRight,
  },
  {
    value: "resize",
    label: "Resize",
    description: "Set dimensions",
    icon: Maximize2,
  },
  {
    value: "compress",
    label: "Compress",
    description: "Reduce file size",
    icon: CircleMinus,
  },
  {
    value: "remove-background",
    label: "Remove background",
    description: "Full-resolution transparent PNG",
    icon: Eraser,
  },
];

export default function App() {
  const { items, addFiles, remove, clear: clearQueue } = useImageQueue();
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<Operation>("convert");
  const [format, setFormat] = useState<OutputFormat>("webp");
  const [isDragging, setDragging] = useState(false);
  const [isProcessing, setProcessing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [results, setResults] = useState<ProcessedItem[]>([]);
  const [notice, setNotice] = useState("");
  const [keepAspect, setKeepAspect] = useState(true);
  const [width, setWidth] = useState<number | undefined>();
  const [height, setHeight] = useState<number | undefined>();
  const [percentage, setPercentage] = useState<number | undefined>(100);
  const [quality, setQuality] = useState(82);
  const [refiningItem, setRefiningItem] = useState<ProcessedItem | null>(null);

  const totalInputSize = useMemo(
    () => items.reduce((sum, item) => sum + item.file.size, 0),
    [items],
  );
  const savings = useMemo(
    () =>
      results.reduce(
        (sum, item) => sum + Math.max(0, item.originalSize - item.outputSize),
        0,
      ),
    [results],
  );

  const addSelectedFiles = (files: FileList | null) => {
    if (!files?.length) return;
    addFiles(files);
    setNotice(
      `${files.length} ${files.length === 1 ? "image" : "images"} added.`,
    );
  };

  const run = async () => {
    if (!items.length) {
      inputRef.current?.click();
      return;
    }
    if (isProcessing) return;

    const controller = new AbortController();
    processingRef.current?.abort();
    processingRef.current = controller;
    const pending = [...items];
    results.forEach((item) => {
      if (item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    });
    setResults([]);
    setProcessing(true);
    const startedAt = performance.now();
    setBatchProgress({
      current:1,
      total:pending.length,
      filename:pending[0].file.name,
      percent:0,
      stage:"Preparing image",
    });

    let completed = 0;
    let failed = 0;
    let nextIndex = 0;
    const failureMessages: string[] = [];
    const completedIds: string[] = [];
    const itemProgress = new Map(pending.map(item => [item.id, 0]));
    const updateProgress = (
      item: (typeof pending)[number],
      progress: number,
      stage: string,
    ) => {
      itemProgress.set(item.id, progress);
      const overallProgress = [...itemProgress.values()]
        .reduce((sum, value) => sum + value, 0) / pending.length;
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const secondsRemaining = overallProgress > 0.03
        ? Math.max(0, Math.round(
            elapsedSeconds / overallProgress - elapsedSeconds,
          ))
        : undefined;
      setBatchProgress({
        current:Math.min(completed + 1, pending.length),
        total:pending.length,
        filename:item.file.name,
        percent:Math.min(99, Math.round(overallProgress * 100)),
        stage,
        secondsRemaining,
      });
    };

    const processNext = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pending.length) return;
        const item = pending[index];
        try {
          const processed = await processImage(
            item,
            {
              operation,
              format:
                operation === "resize"
                  ? "original"
                  : operation === "remove-background"
                    ? "png"
                    : format,
              keepAspect,
              quality,
              width,
              height,
              percentage,
            },
            controller.signal,
            ({ progress, stage }) => updateProgress(item, progress, stage),
          );
          if (controller.signal.aborted) {
            URL.revokeObjectURL(processed.preview);
            return;
          }
          itemProgress.set(item.id, 1);
          setResults((current) => [...current, processed]);
          completedIds.push(item.id);
          completed += 1;
          updateProgress(
            item,
            1,
            completed === pending.length ? "Complete" : "Preparing next image",
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            itemProgress.set(item.id, 1);
            failed += 1;
            const message = error instanceof Error
              ? error.message
              : "Unknown processing error";
            failureMessages.push(`${item.file.name}: ${message}`);
            console.error(`Could not process ${item.file.name}`, error);
          }
        }
      }
    };

    const containsRaw = pending.some(item => isRawImage(item.file));
    const concurrency = operation === "remove-background"
      ? 1
      : containsRaw
      ? Math.min(rawProcessingConcurrency(), pending.length)
      : Math.min(3, pending.length);
    await Promise.all(
      Array.from({ length:concurrency }, () => processNext()),
    );

    if (processingRef.current === controller) {
      completedIds.forEach(remove);
      processingRef.current = null;
      setProcessing(false);
      setBatchProgress(null);
      if (!controller.signal.aborted) {
        setNotice(
          failed
            ? `${completed} ready, ${failed} could not be processed. ${
              failureMessages[0] || ""
            }`
            : `${completed} ${completed === 1 ? "image is" : "images are"} ready.`,
        );
      }
    }
  };

  const clear = () => {
    processingRef.current?.abort();
    processingRef.current = null;
    setProcessing(false);
    setBatchProgress(null);
    results.forEach((item) => {
      if (item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    });
    setResults([]);
    clearQueue();
  };

  const downloadFile = (item: ProcessedItem) => {
    const url = URL.createObjectURL(item.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const saveRefinement = (itemId: string, blob: Blob) => {
    setResults((current) => current.map((item) => {
      if (item.id !== itemId) return item;
      if (item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
      return {
        ...item,
        blob,
        preview:URL.createObjectURL(blob),
        outputSize:blob.size,
      };
    }));
    setRefiningItem(null);
    setNotice("Manual refinement applied.");
  };

  const downloadAllFiles = () => {
    results.forEach((item, index) => {
      setTimeout(() => downloadFile(item), index * 150);
    });
    setNotice(
      `${results.length} ${results.length === 1 ? "file is" : "files are"} downloading.`,
    );
  };

  const downloadZip = async () => {
    const zip = new JSZip();
    results.forEach((item) => zip.file(item.name, item.blob));
    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `imageflow-export-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addSelectedFiles(event.dataTransfer.files);
  };

  const operationAction = operation === "remove-background"
    ? "Remove background from"
    : `${operation[0].toUpperCase()}${operation.slice(1)}`;
  const actionLabel = items.length
    ? `${operationAction} ${items.length} ${
        items.length === 1 ? "image" : "images"
      }`
    : "Process images";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Zap size={19} fill="currentColor" />
          </span>
          <strong>imageflow</strong>
          <span>BETA · {BUILD_VERSION}</span>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p>Convert, resize, and compress your image library in one focused workspace.</p>
          </div>
          <Button
            className="hero-add"
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={isProcessing}
          >
            <Plus size={18} /> Add images
          </Button>
        </section>

        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_FILE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            addSelectedFiles(event.target.files);
            event.target.value = "";
          }}
        />

        <motion.button
          type="button"
          className={`dropzone ${isDragging ? "dragging" : ""} ${
            items.length ? "has-files" : ""
          }`}
          onClick={() => inputRef.current?.click()}
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          whileHover={{ y: -1 }}
          disabled={isProcessing}
        >
          {items.length ? (
            <>
              <div className="file-summary">
                <div className="thumbs" aria-hidden="true">
                  {items.slice(0, 4).map((item) => (
                    <img key={item.id} src={item.preview} alt="" />
                  ))}
                </div>
                <div>
                  <strong>
                    {items.length} {items.length === 1 ? "image" : "images"} ready
                  </strong>
                  <span>{formatBytes(totalInputSize)} total · Click to add more</span>
                </div>
              </div>
            </>
          ) : (
            <>
              <span className="upload-icon">
                <UploadCloud size={27} />
              </span>
              <strong>{isDragging ? "Drop images here" : "Drop images to get started"}</strong>
              <span>
                or <em>browse from your computer</em>
              </span>
              <small>All image formats · Camera RAW</small>
            </>
          )}
        </motion.button>

        <section className="workflow-card">
          <div className="workflow-heading">
            <h2>Workflow</h2>
            <p>Choose what you want to do with your images.</p>
          </div>

          <div className="operation-tabs">
            {operations.map(({ value, label, description, icon: Icon }) => (
              <button
                key={value}
                type="button"
                className={operation === value ? "selected" : ""}
                onClick={() => setOperation(value)}
                aria-pressed={operation === value}
                disabled={isProcessing}
              >
                <span className="operation-icon">
                  <Icon size={18} />
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                {operation === value && <Check className="selected-check" size={16} />}
              </button>
            ))}
          </div>

          <div className="settings-row">
            <div className="settings">
              {(operation === "convert" || operation === "compress") && (
                <label>
                  Output format
                  <span className="select-wrap">
                    <select
                      value={format}
                      onChange={(event) =>
                        setFormat(event.target.value as OutputFormat)
                      }
                      disabled={isProcessing}
                    >
                      <option value="webp">WebP · Recommended</option>
                      <option value="jpeg">JPG · Universal</option>
                      <option value="png">PNG · Lossless</option>
                      <option value="avif">AVIF · Smallest</option>
                    </select>
                    <ChevronDown size={16} />
                  </span>
                </label>
              )}

              {operation === "remove-background" && (
                <div className="background-output-note">
                  <strong>Lossless full-resolution PNG</strong>
                  <span>Refined edges · processed privately on this device</span>
                </div>
              )}

              {operation === "resize" && (
                <>
                  <label>
                    Width
                    <span className="input-wrap">
                      <input
                        type="number"
                        min="1"
                        placeholder="Auto"
                        value={width ?? ""}
                        onChange={(event) => {
                          setWidth(
                            event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          );
                          setPercentage(undefined);
                        }}
                        disabled={isProcessing}
                      />
                      <span>px</span>
                    </span>
                  </label>
                  <label>
                    Height
                    <span className="input-wrap">
                      <input
                        type="number"
                        min="1"
                        placeholder="Auto"
                        value={height ?? ""}
                        onChange={(event) => {
                          setHeight(
                            event.target.value
                              ? Number(event.target.value)
                              : undefined,
                          );
                          setPercentage(undefined);
                        }}
                        disabled={isProcessing}
                      />
                      <span>px</span>
                    </span>
                  </label>
                  <label>
                    Scale
                    <span className="select-wrap short">
                      <select
                        value={percentage ?? ""}
                        onChange={(event) => {
                          const value = event.target.value
                            ? Number(event.target.value)
                            : undefined;
                          setPercentage(value);
                          if (value) {
                            setWidth(undefined);
                            setHeight(undefined);
                          }
                        }}
                        disabled={isProcessing}
                      >
                        <option value="">Custom</option>
                        <option value="100">100%</option>
                        <option value="75">75%</option>
                        <option value="50">50%</option>
                        <option value="25">25%</option>
                      </select>
                      <ChevronDown size={16} />
                    </span>
                  </label>
                  <Toggle
                    checked={keepAspect}
                    onChange={setKeepAspect}
                    label="Keep aspect ratio"
                  />
                </>
              )}

              {operation === "compress" && format !== "png" && (
                <label className="quality-control">
                  <span>
                    Quality <strong>{quality}%</strong>
                  </span>
                  <input
                    type="range"
                    min="20"
                    max="100"
                    value={quality}
                    onChange={(event) => setQuality(Number(event.target.value))}
                    disabled={isProcessing}
                  />
                </label>
              )}
            </div>

            <Button
              className="process-button"
              onClick={run}
              disabled={isProcessing}
            >
              <Play size={17} fill="currentColor" />
              {isProcessing ? "Processing…" : actionLabel}
            </Button>
          </div>
        </section>

        <AnimatePresence>
          {items.length > 0 && (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="queue-card"
            >
              <div className="card-heading">
                <div>
                  <h2>
                    Image queue <span>{items.length}</span>
                  </h2>
                  <p>
                    {isProcessing
                      ? "Processing this queue."
                      : "Ready to be processed."}
                  </p>
                </div>
                {isProcessing && batchProgress && (
                  <div className="batch-progress" aria-live="polite">
                    <div className="progress-copy">
                      <div>
                        <strong>{batchProgress.stage}</strong>
                        <span title={batchProgress.filename}>
                          {batchProgress.filename}
                        </span>
                      </div>
                      <div>
                        <strong>{batchProgress.percent}%</strong>
                        <span>
                          {batchProgress.current} of {batchProgress.total}
                          {batchProgress.secondsRemaining !== undefined &&
                          batchProgress.secondsRemaining > 0
                            ? ` · about ${batchProgress.secondsRemaining < 60
                              ? `${batchProgress.secondsRemaining}s`
                              : `${Math.ceil(batchProgress.secondsRemaining / 60)} min`} left`
                            : ""}
                        </span>
                      </div>
                    </div>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label={`Processing ${batchProgress.filename}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={batchProgress.percent}
                    >
                      <span style={{ width:`${batchProgress.percent}%` }} />
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={clear}
                  className="text-button"
                  disabled={isProcessing}
                >
                  <Trash2 size={15} /> Clear all
                </button>
              </div>
              <div className="queue-list">
                {items.map((item) => (
                  <article key={item.id}>
                    <img src={item.preview} alt="" />
                    <div>
                      <strong>{item.file.name}</strong>
                      <small>{formatBytes(item.file.size)}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      aria-label={`Remove ${item.file.name}`}
                      disabled={isProcessing}
                    >
                      <X size={16} />
                    </button>
                  </article>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {results.length > 0 && !isProcessing && (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="results-card"
            >
              <div className="card-heading">
                <div>
                  <h2>
                    Images ready <span className="success">{results.length}</span>
                  </h2>
                  <p>
                    {savings
                      ? `${formatBytes(savings)} saved across this batch.`
                      : "Your processed files are ready."}
                  </p>
                </div>
                <div className="result-actions">
                  <Button variant="secondary" onClick={clear}>
                    Clear
                  </Button>
                  <Button variant="secondary" onClick={downloadAllFiles}>
                    <ArrowDownToLine size={17} /> Download all
                  </Button>
                  <Button onClick={downloadZip}>
                    <Archive size={17} /> Download as ZIP
                  </Button>
                </div>
              </div>
              <div className="result-list">
                {results.map((item) => (
                  <article key={item.id}>
                    <img src={item.preview} alt="" />
                    <div className="result-item-meta">
                      <strong>{item.name}</strong>
                      <small>
                        {item.width && item.height
                          ? `${item.width} × ${item.height} · `
                          : ""}
                        {formatBytes(item.outputSize)}
                      </small>
                    </div>
                    <div className="result-item-actions">
                      {item.refinable && (
                        <button
                          type="button"
                          className="refine-result-button"
                          onClick={() => setRefiningItem(item)}
                          aria-label={`Refine ${item.name}`}
                        >
                          <Paintbrush size={15} />
                          <span>Refine</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="download-result-button"
                        onClick={() => downloadFile(item)}
                        aria-label={`Download ${item.name}`}
                      >
                        <Download size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            className="toast"
            role="status"
          >
            <Check size={16} />
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice("")}
              aria-label="Dismiss message"
            >
              <X size={15} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {refiningItem && (
        <RefineEditor
          item={refiningItem}
          onClose={() => setRefiningItem(null)}
          onSave={blob => saveRefinement(refiningItem.id, blob)}
        />
      )}
    </div>
  );
}
