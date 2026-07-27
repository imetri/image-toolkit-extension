import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import JSZip from "jszip";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  Check,
  ChevronDown,
  CircleMinus,
  Download,
  ImagePlus,
  Maximize2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import { Button, Toggle } from "./components/ui";
import { useImageQueue } from "./hooks/useImageQueue";
import { processImage } from "./lib/imageProcessor";
import { IMAGE_FILE_ACCEPT } from "./lib/imageFormats";
import { formatBytes } from "./lib/utils";
import type { Operation, OutputFormat, ProcessedItem } from "./types";

const operations: Array<{
  value: Operation;
  title: string;
  description: string;
  icon: typeof ArrowLeftRight;
}> = [
  {
    value: "convert",
    title: "Convert",
    description: "Change file format",
    icon: ArrowLeftRight,
  },
  {
    value: "resize",
    title: "Resize",
    description: "Change dimensions",
    icon: Maximize2,
  },
  {
    value: "compress",
    title: "Compress",
    description: "Reduce file size",
    icon: CircleMinus,
  },
];

const formatOptions: Array<{
  value: OutputFormat;
  title: string;
  description: string;
}> = [
  { value: "webp", title: "WebP", description: "Best for the web" },
  { value: "jpeg", title: "JPG", description: "Works everywhere" },
  { value: "png", title: "PNG", description: "Lossless quality" },
  { value: "avif", title: "AVIF", description: "Smallest files" },
];

const resizePresets = [
  { title: "Instagram", description: "1080 × 1080", width: 1080, height: 1080 },
  { title: "Full HD", description: "1920 × 1080", width: 1920, height: 1080 },
  { title: "Half size", description: "50% scale", percentage: 50 },
];

const compressionPresets = [
  { title: "Best quality", description: "Light compression", quality: 90 },
  { title: "Balanced", description: "Recommended", quality: 72 },
  { title: "Smallest", description: "Maximum savings", quality: 45 },
];

export default function App() {
  const { items, addFiles, remove, clear: clearQueue } = useImageQueue();
  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<Operation>("convert");
  const [format, setFormat] = useState<OutputFormat>("webp");
  const [isDragging, setDragging] = useState(false);
  const [isProcessing, setProcessing] = useState(false);
  const [results, setResults] = useState<ProcessedItem[]>([]);
  const [notice, setNotice] = useState("");
  const [keepAspect, setKeepAspect] = useState(true);
  const [width, setWidth] = useState<number | undefined>();
  const [height, setHeight] = useState<number | undefined>();
  const [percentage, setPercentage] = useState<number | undefined>();
  const [quality, setQuality] = useState(72);
  const [activeResizePreset, setActiveResizePreset] = useState("Custom");
  const [progress, setProgress] = useState({
    current: 0,
    total: 0,
    fileName: "",
  });

  const totalInputSize = useMemo(
    () => items.reduce((sum, item) => sum + item.file.size, 0),
    [items],
  );
  const estimatedOutputSize = useMemo(() => {
    if (!totalInputSize) return 0;
    if (operation === "compress") {
      return totalInputSize * Math.max(0.25, quality / 125);
    }
    if (operation === "resize") {
      return totalInputSize * Math.max(
        0.08,
        percentage ? Math.pow(percentage / 100, 2) : 0.65,
      );
    }
    const ratio = { webp: 0.7, jpeg: 0.82, png: 1.04, avif: 0.55, original: 1 }[
      format
    ];
    return totalInputSize * ratio;
  }, [format, operation, percentage, quality, totalInputSize]);
  const savings = useMemo(
    () =>
      results.reduce(
        (sum, item) => sum + Math.max(0, item.originalSize - item.outputSize),
        0,
      ),
    [results],
  );
  const progressPercent = progress.total
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const openFilePicker = () => inputRef.current?.click();

  const addSelectedFiles = (files: FileList | null) => {
    if (!files?.length) return;
    addFiles(files);
    setNotice(
      `${files.length} ${files.length === 1 ? "image" : "images"} added.`,
    );
  };

  const run = async () => {
    if (!items.length || isProcessing) return;
    processingRef.current?.abort();
    const controller = new AbortController();
    processingRef.current = controller;
    const pendingItems = [...items];
    setProcessing(true);
    setProgress({ current: 0, total: pendingItems.length, fileName: "" });
    let completed = 0;
    let failed = 0;
    let firstFailure = "";

    for (const [index, item] of pendingItems.entries()) {
      if (controller.signal.aborted) break;
      setProgress({
        current: index,
        total: pendingItems.length,
        fileName: item.file.name,
      });
      try {
        const processed = await processImage(
          item,
          {
            operation,
            format: operation === "resize" ? "original" : format,
            keepAspect,
            quality,
            width,
            height,
            percentage,
          },
          controller.signal,
        );
        if (controller.signal.aborted) {
          URL.revokeObjectURL(processed.preview);
          break;
        }
        setResults((current) => [...current, processed]);
        remove(item.id);
        completed += 1;
        setProgress({
          current: index + 1,
          total: pendingItems.length,
          fileName: item.file.name,
        });
      } catch (error) {
        if (controller.signal.aborted) break;
        failed += 1;
        if (!firstFailure) {
          firstFailure =
            error instanceof Error ? error.message : "Unknown processing error";
        }
        setProgress({
          current: index + 1,
          total: pendingItems.length,
          fileName: item.file.name,
        });
      }
    }

    if (processingRef.current === controller) {
      processingRef.current = null;
      setProcessing(false);
      if (!controller.signal.aborted) {
        const success = `${completed} ${completed === 1 ? "image" : "images"} ready`;
        setNotice(
          failed
            ? `${success}. ${failed} failed: ${firstFailure}`
            : `${success} to download.`,
        );
      }
    }
  };

  const clear = () => {
    processingRef.current?.abort();
    processingRef.current = null;
    setProcessing(false);
    results.forEach((item) => {
      if (item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
    });
    setResults([]);
    clearQueue();
    setProgress({ current: 0, total: 0, fileName: "" });
    setNotice("Workspace cleared.");
  };

  const downloadFile = (item: ProcessedItem) => {
    const url = URL.createObjectURL(item.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadFiles = () => {
    results.forEach((item, index) =>
      setTimeout(() => downloadFile(item), index * 150),
    );
    setNotice(`${results.length} files are downloading.`);
  };

  const downloadZip = async () => {
    if (!results.length) return;
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
    setNotice("ZIP downloaded successfully.");
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addSelectedFiles(event.dataTransfer.files);
  };

  const chooseResizePreset = (preset: (typeof resizePresets)[number]) => {
    setActiveResizePreset(preset.title);
    if (preset.percentage) {
      setWidth(undefined);
      setHeight(undefined);
      setPercentage(preset.percentage);
    } else {
      setWidth(preset.width);
      setHeight(preset.height);
      setPercentage(undefined);
    }
  };

  const processLabel = `${operation[0].toUpperCase()}${operation.slice(1)} ${items.length} ${
    items.length === 1 ? "image" : "images"
  }`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={18} fill="currentColor" />
          </div>
          <span className="brand-name">imageflow</span>
          <span className="version">BETA</span>
        </div>
        <div className="privacy-note">
          <ShieldCheck size={16} />
          <span>Private by design · Files stay on your device</span>
        </div>
      </header>

      <main className="main">
        <section className="intro">
          <div>
            <span className="eyebrow">LOCAL IMAGE WORKSPACE</span>
            <h1>Move faster with every image.</h1>
            <p>Convert, resize, and compress images in one focused workflow.</p>
          </div>
        </section>

        <ol className="stepper" aria-label="Image processing steps">
          {["Choose action", "Adjust settings", "Add images", "Process"].map(
            (step, index) => {
              const hasBatch = items.length > 0 || isProcessing;
              const complete =
                index < 2 ||
                (index === 2 && (hasBatch || results.length > 0)) ||
                (index === 3 && results.length > 0 && !items.length);
              const active =
                (index === 1 && !hasBatch && !results.length) ||
                (index === 2 && !hasBatch && !results.length) ||
                (index === 3 && (isProcessing || results.length > 0));
              return (
                <li
                  key={step}
                  className={`${complete ? "complete" : ""} ${active ? "active" : ""}`}
                >
                  <span>{complete ? <Check size={14} /> : index + 1}</span>
                  <strong>{step}</strong>
                </li>
              );
            },
          )}
        </ol>

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

        {!items.length && !results.length && (
          <motion.button
            type="button"
            className={`dropzone ${isDragging ? "dragging" : ""}`}
            onClick={openFilePicker}
            onDragEnter={() => setDragging(true)}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            whileHover={{ y: -2 }}
          >
            <span className="upload-icon">
              <UploadCloud size={28} />
            </span>
            <strong>{isDragging ? "Drop them here" : "Drop images here"}</strong>
            <span>
              or <em>choose images</em> from your computer
            </span>
            <small>JPG, PNG, WebP, AVIF and Camera RAW · Up to 500 images</small>
          </motion.button>
        )}

        {results.length === 0 && (
          <>
            {(items.length > 0 || isProcessing) && (
              <section className="queue-summary" aria-label="Selected images">
              <div className="summary-copy">
                <span className="summary-icon">
                  <ImagePlus size={20} />
                </span>
                <div>
                  <strong>
                    {items.length} {items.length === 1 ? "image" : "images"}{" "}
                    selected
                  </strong>
                  <small>{formatBytes(totalInputSize)} total</small>
                </div>
              </div>
              <div className="thumbnail-strip">
                {items.slice(0, 6).map((item) => (
                  <div className="thumbnail" key={item.id}>
                    <img src={item.preview} alt="" />
                    <button
                      type="button"
                      aria-label={`Remove ${item.file.name}`}
                      onClick={() => remove(item.id)}
                      disabled={isProcessing}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {items.length > 6 && (
                  <span className="more-count">+{items.length - 6}</span>
                )}
              </div>
              <Button
                variant="secondary"
                onClick={openFilePicker}
                disabled={isProcessing}
              >
                <Plus size={16} /> Add more
              </Button>
              <button
                type="button"
                className="icon-button"
                onClick={clear}
                aria-label="Clear all images"
                disabled={isProcessing}
              >
                <Trash2 size={17} />
              </button>
              </section>
            )}

            <section className="workspace-card">
              <div className="section-heading">
                <span className="section-number">1</span>
                <div>
                  <h2>What would you like to do?</h2>
                  <p>Choose one action for this batch.</p>
                </div>
              </div>

              <div className="operation-grid">
                {operations.map(({ value, title, description, icon: Icon }) => (
                  <button
                    type="button"
                    key={value}
                    className={operation === value ? "selected" : ""}
                    onClick={() => setOperation(value)}
                    aria-pressed={operation === value}
                    disabled={isProcessing}
                  >
                    <span className="mode-icon">
                      <Icon size={19} />
                    </span>
                    <span>
                      <strong>{title}</strong>
                      <small>{description}</small>
                    </span>
                    <span className="selection-indicator">
                      {operation === value ? <Check size={14} /> : null}
                    </span>
                  </button>
                ))}
              </div>

              <div className="settings-area">
                <div className="section-heading compact">
                  <span className="section-number">2</span>
                  <div>
                    <h2>
                      {operation === "convert"
                        ? "Choose an output format"
                        : operation === "resize"
                          ? "Choose a size"
                          : "Choose a compression level"}
                    </h2>
                    <p>
                      {operation === "convert"
                        ? "WebP gives most images a great balance of quality and size."
                        : operation === "resize"
                          ? "Use a familiar preset or enter custom dimensions."
                          : "Balanced works well for most images."}
                    </p>
                  </div>
                </div>

                {operation === "convert" && (
                  <div className="preset-grid format-presets">
                    {formatOptions.map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        className={format === option.value ? "selected" : ""}
                        onClick={() => setFormat(option.value)}
                        aria-pressed={format === option.value}
                        disabled={isProcessing}
                      >
                        <strong>{option.title}</strong>
                        <small>{option.description}</small>
                        {option.value === "webp" && <em>Recommended</em>}
                        <span className="radio-dot" />
                      </button>
                    ))}
                  </div>
                )}

                {operation === "resize" && (
                  <>
                    <div className="preset-grid">
                      {resizePresets.map((preset) => (
                        <button
                          type="button"
                          key={preset.title}
                          className={
                            activeResizePreset === preset.title ? "selected" : ""
                          }
                          onClick={() => chooseResizePreset(preset)}
                          aria-pressed={activeResizePreset === preset.title}
                          disabled={isProcessing}
                        >
                          <strong>{preset.title}</strong>
                          <small>{preset.description}</small>
                          <span className="radio-dot" />
                        </button>
                      ))}
                      <button
                        type="button"
                        className={
                          activeResizePreset === "Custom" ? "selected" : ""
                        }
                        onClick={() => {
                          setActiveResizePreset("Custom");
                          setPercentage(undefined);
                        }}
                        aria-pressed={activeResizePreset === "Custom"}
                        disabled={isProcessing}
                      >
                        <strong>Custom</strong>
                        <small>Enter dimensions</small>
                        <span className="radio-dot" />
                      </button>
                    </div>
                    {activeResizePreset === "Custom" && (
                      <div className="custom-controls">
                        <label>
                          Width
                          <div className="input-with-unit">
                            <input
                              type="number"
                              min="1"
                              value={width ?? ""}
                              placeholder="Auto"
                              onChange={(event) =>
                                setWidth(
                                  event.target.value
                                    ? Number(event.target.value)
                                    : undefined,
                                )
                              }
                              disabled={isProcessing}
                            />
                            <span>px</span>
                          </div>
                        </label>
                        <label>
                          Height
                          <div className="input-with-unit">
                            <input
                              type="number"
                              min="1"
                              value={height ?? ""}
                              placeholder="Auto"
                              onChange={(event) =>
                                setHeight(
                                  event.target.value
                                    ? Number(event.target.value)
                                    : undefined,
                                )
                              }
                              disabled={isProcessing}
                            />
                            <span>px</span>
                          </div>
                        </label>
                        <Toggle
                          checked={keepAspect}
                          onChange={setKeepAspect}
                          label="Keep aspect ratio"
                        />
                      </div>
                    )}
                  </>
                )}

                {operation === "compress" && (
                  <>
                    <div className="preset-grid compression-presets">
                      {compressionPresets.map((preset) => (
                        <button
                          type="button"
                          key={preset.quality}
                          className={quality === preset.quality ? "selected" : ""}
                          onClick={() => setQuality(preset.quality)}
                          aria-pressed={quality === preset.quality}
                          disabled={isProcessing}
                        >
                          <strong>{preset.title}</strong>
                          <small>{preset.description}</small>
                          {preset.quality === 72 && <em>Recommended</em>}
                          <span className="radio-dot" />
                        </button>
                      ))}
                    </div>
                    <div className="compress-details">
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
                            <option value="avif">AVIF · Smallest</option>
                            <option value="png">PNG · Lossless</option>
                          </select>
                          <ChevronDown size={16} />
                        </span>
                      </label>
                      <label className="quality-control">
                        <span>
                          Fine-tune quality <strong>{quality}%</strong>
                        </span>
                        <input
                          type="range"
                          min="20"
                          max="100"
                          value={quality}
                          onChange={(event) =>
                            setQuality(Number(event.target.value))
                          }
                          disabled={isProcessing}
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>

              <div className="action-bar">
                <div className="estimate">
                  <span>
                    {items.length ? "Estimated result" : "Your setup is ready"}
                  </span>
                  {items.length ? (
                    <strong>
                      {formatBytes(estimatedOutputSize)}{" "}
                      {estimatedOutputSize < totalInputSize && (
                        <em>
                          ~
                          {Math.round(
                            (1 - estimatedOutputSize / totalInputSize) * 100,
                          )}
                          % smaller
                        </em>
                      )}
                    </strong>
                  ) : (
                    <strong>Add images when you’re ready</strong>
                  )}
                </div>
                <Button
                  className="process-button"
                  onClick={items.length ? run : openFilePicker}
                  disabled={isProcessing}
                >
                  {items.length ? (
                    <Play size={17} fill="currentColor" />
                  ) : (
                    <UploadCloud size={17} />
                  )}
                  {isProcessing
                    ? "Processing…"
                    : items.length
                      ? processLabel
                      : `Add images to ${operation}`}
                </Button>
              </div>
            </section>
          </>
        )}

        <AnimatePresence>
          {isProcessing && (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="progress-card"
              aria-live="polite"
            >
              <div>
                <span>Processing batch</span>
                <strong>
                  {progress.current} of {progress.total}
                </strong>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
              >
                <motion.span animate={{ width: `${progressPercent}%` }} />
              </div>
              <small>{progress.fileName || "Preparing images…"}</small>
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {results.length > 0 && !isProcessing && (
            <motion.section
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="success-card"
            >
              <div className="success-hero">
                <span className="success-icon">
                  <Check size={22} />
                </span>
                <div>
                  <span className="eyebrow">BATCH COMPLETE</span>
                  <h2>
                    {results.length}{" "}
                    {results.length === 1 ? "image is" : "images are"} ready.
                  </h2>
                  <p>
                    {savings > 0
                      ? `You saved ${formatBytes(savings)} across this batch.`
                      : "Your processed images are ready to download."}
                  </p>
                </div>
                <div className="success-actions">
                  <Button variant="secondary" onClick={downloadFiles}>
                    <Download size={16} /> Download files
                  </Button>
                  <Button onClick={downloadZip}>
                    <ArrowDownToLine size={17} /> Download all
                  </Button>
                </div>
              </div>
              <div className="result-grid">
                {results.map((item) => (
                  <article className="result-card" key={item.id}>
                    <img src={item.preview} alt="" />
                    <div>
                      <strong>{item.name}</strong>
                      <small>
                        {item.width && item.height
                          ? `${item.width} × ${item.height} · `
                          : ""}
                        {formatBytes(item.outputSize)}
                      </small>
                    </div>
                    <button
                      type="button"
                      aria-label={`Download ${item.name}`}
                      onClick={() => downloadFile(item)}
                    >
                      <Download size={16} />
                    </button>
                  </article>
                ))}
              </div>
              <button type="button" className="start-over" onClick={clear}>
                <RotateCcw size={15} /> Start a new batch
              </button>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="toast"
            role="status"
          >
            <Check size={16} />
            {notice}
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
    </div>
  );
}
