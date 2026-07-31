import {
  AutoProcessor,
  env,
  RawImage,
  SamModel,
  type ProgressInfo,
} from "@huggingface/transformers";

type MagicMaskSeed = {
  x: number;
  y: number;
  radius: number;
};

type WorkerRequest = {
  type:"select-region";
  id:string;
  image:ImageBitmap;
  seeds:MagicMaskSeed[];
};

type InferenceDevice = "webgpu" | "wasm";

type SelectionEngine = {
  processor: {
    _call: (
      image: RawImage,
      options: { input_points:number[][][] },
    ) => Promise<{
      pixel_values: unknown;
      original_sizes: [number, number][];
      reshaped_input_sizes: [number, number][];
      input_points: unknown;
    }>;
    post_process_masks: (
      masks: unknown,
      originalSizes: [number, number][],
      reshapedInputSizes: [number, number][],
    ) => Promise<Array<{
      data: Uint8Array;
      dims: number[];
    }>>;
  };
  model: {
    _call: (inputs: object) => Promise<{
      pred_masks: unknown;
      iou_scores: { data:Float32Array };
    }>;
  };
  device: InferenceDevice;
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const MODEL_ID = "Xenova/slimsam-77-uniform";
const MAX_PROMPT_POINTS = 16;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = new URL("/models/", workerScope.location.href).href;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 0;

function report(id: string, progress: number, stage: string) {
  workerScope.postMessage({
    type:"progress",
    id,
    progress:Math.max(0, Math.min(1, progress)),
    stage,
  });
}

function createEngine(
  id: string,
  device: InferenceDevice,
): Promise<SelectionEngine> {
  const options = {
    device,
    dtype:"q8",
    progress_callback: (update: ProgressInfo) => {
      const percent = (
        "progress" in update && typeof update.progress === "number"
      ) ? update.progress / 100 : 0;
      report(id, 0.04 + percent * 0.4, "Loading AI selection model");
    },
  } as const;

  return Promise.all([
    AutoProcessor.from_pretrained(MODEL_ID, options),
    SamModel.from_pretrained(MODEL_ID, options),
  ]).then(([processor, model]) => ({
    processor,
    model,
    device,
  }) as unknown as SelectionEngine);
}

let enginePromise: Promise<SelectionEngine> | undefined;

function getEngine(id: string) {
  if (enginePromise) return enginePromise;
  const canUseWebGpu = "gpu" in workerScope.navigator;
  enginePromise = canUseWebGpu
    ? createEngine(id, "webgpu").catch(() => {
        report(id, 0.08, "Using compatible CPU acceleration");
        return createEngine(id, "wasm");
      })
    : createEngine(id, "wasm");
  return enginePromise;
}

function switchToWasmEngine(id: string) {
  report(id, 0.08, "Using compatible CPU acceleration");
  enginePromise = createEngine(id, "wasm");
  return enginePromise;
}

function samplePromptPoints(seeds: MagicMaskSeed[]) {
  if (seeds.length <= MAX_PROMPT_POINTS) {
    return seeds.map(seed => [seed.x, seed.y]);
  }
  const points: number[][] = [];
  for (let index = 0; index < MAX_PROMPT_POINTS; index += 1) {
    const sourceIndex = Math.round(
      index * (seeds.length - 1) / (MAX_PROMPT_POINTS - 1),
    );
    points.push([seeds[sourceIndex].x, seeds[sourceIndex].y]);
  }
  return points;
}

async function inferSelection(
  engine: SelectionEngine,
  bitmap: ImageBitmap,
  seeds: MagicMaskSeed[],
) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { alpha:false });
  if (!context) throw new Error("Unable to prepare the AI selection.");
  context.drawImage(bitmap, 0, 0);

  const points = samplePromptPoints(seeds);
  const inputs = await engine.processor._call(
    RawImage.fromCanvas(canvas),
    { input_points:[points] },
  );
  const outputs = await engine.model._call(inputs);
  const processedMasks = await engine.processor.post_process_masks(
    outputs.pred_masks,
    inputs.original_sizes,
    inputs.reshaped_input_sizes,
  );
  const masks = processedMasks[0];
  if (!masks) throw new Error("The AI selector returned no mask.");

  const pixelCount = bitmap.width * bitmap.height;
  const maskCount = Math.floor(masks.data.length / pixelCount);
  if (!maskCount) throw new Error("The AI selector returned an invalid mask.");

  let bestMaskIndex = 0;
  for (let index = 1; index < maskCount; index += 1) {
    if (
      Number(outputs.iou_scores.data[index] ?? 0)
        > Number(outputs.iou_scores.data[bestMaskIndex] ?? 0)
    ) bestMaskIndex = index;
  }

  const selected = new Uint8ClampedArray(pixelCount);
  const maskOffset = bestMaskIndex * pixelCount;
  for (let index = 0; index < pixelCount; index += 1) {
    if (masks.data[maskOffset + index]) selected[index] = 255;
  }
  return selected;
}

async function runSelection(
  id: string,
  bitmap: ImageBitmap,
  seeds: MagicMaskSeed[],
) {
  if (!seeds.length) throw new Error("Paint over the object to select it.");
  let engine = await getEngine(id);
  report(id, 0.5, "Recognizing the painted object");
  try {
    return await inferSelection(engine, bitmap, seeds);
  } catch (error) {
    if (engine.device !== "webgpu") throw error;
    engine = await switchToWasmEngine(id);
    return inferSelection(engine, bitmap, seeds);
  }
}

workerScope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const bitmap = data.image;
  try {
    report(data.id, 0.02, "Preparing AI selection");
    const mask = await runSelection(data.id, bitmap, data.seeds);
    const maskBuffer = mask.buffer as ArrayBuffer;
    report(data.id, 0.98, "AI highlight ready");
    workerScope.postMessage({
      type:"mask-result",
      id:data.id,
      mask:maskBuffer,
      width:bitmap.width,
      height:bitmap.height,
    }, [maskBuffer]);
  } catch (error) {
    workerScope.postMessage({
      type:"error",
      id:data.id,
      error:error instanceof Error
        ? error.message
        : "Unable to create the AI selection.",
    });
  } finally {
    bitmap.close();
  }
};
