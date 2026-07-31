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
  label?: 0 | 1;
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
      options: {
        input_points:number[][][];
        input_labels:number[][];
      },
    ) => Promise<{
      pixel_values: unknown;
      original_sizes: [number, number][];
      reshaped_input_sizes: [number, number][];
      input_points: unknown;
      input_labels: unknown;
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
const MAX_POSITIVE_POINTS = 14;
const MAX_NEGATIVE_POINTS = 6;

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

function sampleSeeds(
  seeds: MagicMaskSeed[],
  maximum: number,
) {
  if (seeds.length <= maximum) return seeds;
  const sampled: MagicMaskSeed[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(
      index * (seeds.length - 1) / (maximum - 1),
    );
    sampled.push(seeds[sourceIndex]);
  }
  return sampled;
}

function createPrompt(seeds: MagicMaskSeed[]) {
  const positiveSeeds = sampleSeeds(
    seeds.filter(seed => seed.label !== 0),
    MAX_POSITIVE_POINTS,
  );
  const negativeSeeds = sampleSeeds(
    seeds.filter(seed => seed.label === 0),
    MAX_NEGATIVE_POINTS,
  );
  const promptSeeds = [...positiveSeeds, ...negativeSeeds];
  return {
    positiveSeeds,
    negativeSeeds,
    points:promptSeeds.map(seed => [seed.x, seed.y]),
    labels:promptSeeds.map(seed => seed.label === 0 ? 0 : 1),
  };
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

  const prompt = createPrompt(seeds);
  const inputs = await engine.processor._call(
    RawImage.fromCanvas(canvas),
    {
      input_points:[prompt.points],
      input_labels:[prompt.labels],
    },
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

  let focusLeft = bitmap.width;
  let focusTop = bitmap.height;
  let focusRight = 0;
  let focusBottom = 0;
  for (const seed of prompt.positiveSeeds) {
    const radius = Math.max(2, seed.radius * 1.35);
    focusLeft = Math.min(focusLeft, seed.x - radius);
    focusTop = Math.min(focusTop, seed.y - radius);
    focusRight = Math.max(focusRight, seed.x + radius);
    focusBottom = Math.max(focusBottom, seed.y + radius);
  }
  focusLeft = Math.max(0, Math.floor(focusLeft));
  focusTop = Math.max(0, Math.floor(focusTop));
  focusRight = Math.min(bitmap.width - 1, Math.ceil(focusRight));
  focusBottom = Math.min(bitmap.height - 1, Math.ceil(focusBottom));

  let bestMaskIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let maskIndex = 0; maskIndex < maskCount; maskIndex += 1) {
    const maskOffset = maskIndex * pixelCount;
    let selectedArea = 0;
    let focusedArea = 0;
    let positiveHits = 0;
    let negativeHits = 0;
    for (let index = 0; index < pixelCount; index += 1) {
      if (!masks.data[maskOffset + index]) continue;
      selectedArea += 1;
      const x = index % bitmap.width;
      const y = Math.floor(index / bitmap.width);
      if (
        x >= focusLeft
        && x <= focusRight
        && y >= focusTop
        && y <= focusBottom
      ) focusedArea += 1;
    }
    for (const seed of prompt.positiveSeeds) {
      const x = Math.max(0, Math.min(
        bitmap.width - 1,
        Math.round(seed.x),
      ));
      const y = Math.max(0, Math.min(
        bitmap.height - 1,
        Math.round(seed.y),
      ));
      if (masks.data[maskOffset + y * bitmap.width + x]) {
        positiveHits += 1;
      }
    }
    for (const seed of prompt.negativeSeeds) {
      const x = Math.max(0, Math.min(
        bitmap.width - 1,
        Math.round(seed.x),
      ));
      const y = Math.max(0, Math.min(
        bitmap.height - 1,
        Math.round(seed.y),
      ));
      if (masks.data[maskOffset + y * bitmap.width + x]) {
        negativeHits += 1;
      }
    }
    const positiveCoverage = positiveHits / Math.max(
      1,
      prompt.positiveSeeds.length,
    );
    const negativeLeakage = negativeHits / Math.max(
      1,
      prompt.negativeSeeds.length,
    );
    const spatialLeakage = selectedArea > 0
      ? 1 - focusedArea / selectedArea
      : 1;
    const predictedQuality = Number(
      outputs.iou_scores.data[maskIndex] ?? 0,
    );
    const score = (
      predictedQuality
      + positiveCoverage * 2.5
      - negativeLeakage * 3.5
      - spatialLeakage * 2.25
    );
    if (score > bestScore) {
      bestScore = score;
      bestMaskIndex = maskIndex;
    }
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
