type RefinePoint = {
  x: number;
  y: number;
  radius: number;
};

type RefineResult = {
  pixels: Uint8ClampedArray;
  selectedPixelCount: number;
  width: number;
  height: number;
};

type WorkerMessage =
  | {
      type: "refined-selection";
      id: string;
      pixels: ArrayBuffer;
      selectedPixelCount: number;
      width: number;
      height: number;
    }
  | { type: "error"; id: string; error: string };

type PendingRequest = {
  resolve: (result: RefineResult) => void;
  reject: (reason: Error) => void;
  cleanup: () => void;
};

const pending = new Map<string, PendingRequest>();
let worker: Worker | undefined;

const abortError = () =>
  new DOMException("Image processing was cancelled", "AbortError");

function stopWorker(error: Error) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) {
    request.cleanup();
    request.reject(error);
  }
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL("../workers/selection-refine.worker.ts", import.meta.url),
    { type: "module" },
  );
  worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    request.cleanup();
    if (data.type === "error") {
      request.reject(new Error(data.error));
      return;
    }
    request.resolve({
      pixels: new Uint8ClampedArray(data.pixels),
      selectedPixelCount: data.selectedPixelCount,
      width: data.width,
      height: data.height,
    });
  };
  worker.onerror = event => {
    stopWorker(new Error(event.message || "The highlight refiner stopped."));
  };
  return worker;
}

export function refineMagicSelectionMask(
  mask: Uint8ClampedArray,
  visiblePixels: Uint8ClampedArray,
  width: number,
  height: number,
  points: RefinePoint[],
  signal?: AbortSignal,
) {
  if (signal?.aborted) return Promise.reject(abortError());
  const id = crypto.randomUUID();
  return new Promise<RefineResult>((resolve, reject) => {
    const cancel = () => {
      if (pending.has(id)) stopWorker(abortError());
    };
    const cleanup = () => signal?.removeEventListener("abort", cancel);
    pending.set(id, { resolve, reject, cleanup });
    signal?.addEventListener("abort", cancel, { once: true });
    const maskBuffer = mask.buffer as ArrayBuffer;
    const visibleBuffer = visiblePixels.buffer as ArrayBuffer;
    getWorker().postMessage({
      type: "refine-selection",
      id,
      mask: maskBuffer,
      visiblePixels: visibleBuffer,
      width,
      height,
      points,
    }, [maskBuffer, visibleBuffer]);
  });
}
