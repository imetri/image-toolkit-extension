import type { ProcessProgress } from "../types";

export type MagicMaskSeed = {
  x: number;
  y: number;
  radius: number;
  label?: 0 | 1;
};

type MagicMaskResult = {
  mask: Uint8ClampedArray;
  width: number;
  height: number;
};

type WorkerMessage =
  | ({ type:"progress"; id:string } & ProcessProgress)
  | {
      type:"mask-result";
      id:string;
      mask:ArrayBuffer;
      width:number;
      height:number;
    }
  | { type:"error"; id:string; error:string };

type PendingRequest = {
  resolve: (result: MagicMaskResult) => void;
  reject: (error: Error) => void;
  onProgress?: (update: ProcessProgress) => void;
  refreshTimeout: () => void;
  cleanup: () => void;
};

const pending = new Map<string, PendingRequest>();
const SELECTION_TIMEOUT = 180_000;
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
    new URL("../workers/selection.worker.ts", import.meta.url),
    { type:"module" },
  );
  worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "progress") {
      request.refreshTimeout();
      request.onProgress?.({
        progress:data.progress,
        stage:data.stage,
      });
      return;
    }

    pending.delete(data.id);
    request.cleanup();
    if (data.type === "error") {
      request.reject(new Error(data.error));
      return;
    }
    request.resolve({
      mask:new Uint8ClampedArray(data.mask),
      width:data.width,
      height:data.height,
    });
  };
  worker.onerror = event => {
    stopWorker(new Error(event.message || "The AI selector stopped."));
  };
  return worker;
}

export function createMagicSelectionMask(
  image: ImageBitmap,
  seeds: MagicMaskSeed[],
  signal?: AbortSignal,
  onProgress?: (update: ProcessProgress) => void,
) {
  if (signal?.aborted) return Promise.reject(abortError());
  const id = crypto.randomUUID();

  return new Promise<MagicMaskResult>((resolve, reject) => {
    let timeout: number | undefined;
    const refreshTimeout = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        if (!pending.has(id)) return;
        stopWorker(new Error(
          "The AI selector stopped responding before it could finish.",
        ));
      }, SELECTION_TIMEOUT);
    };
    const cancel = () => {
      if (!pending.has(id)) return;
      stopWorker(abortError());
    };
    const cleanup = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    };

    pending.set(id, {
      resolve,
      reject,
      onProgress,
      refreshTimeout,
      cleanup,
    });
    signal?.addEventListener("abort", cancel, { once:true });
    refreshTimeout();
    getWorker().postMessage(
      { type:"select-region", id, image, seeds },
      [image],
    );
  });
}
