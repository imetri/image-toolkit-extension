import {
  AutoImageProcessor,
  AutoModel,
  env,
  RawImage,
  type ProgressInfo,
} from '@huggingface/transformers'

type WorkerRequest = {
  type: 'remove-background'
  id: string
  image: Blob
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope
const MODEL_ID = 'studioludens/birefnet-lite-512'
const MAX_INFERENCE_EDGE = 512
const MASK_THRESHOLD = 32
const REFINEMENT_PADDING = 0.1

type SourceRect = {
  left: number
  top: number
  width: number
  height: number
}

env.allowRemoteModels = false
env.allowLocalModels = true
env.useBrowserCache = false
env.localModelPath = new URL('/models/', workerScope.location.href).href
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1

function report(id: string, progress: number, stage: string) {
  workerScope.postMessage({
    type:'progress',
    id,
    progress:Math.max(0, Math.min(1, progress)),
    stage,
  })
}

function createEngine(id: string) {
  const options = {
      device:'wasm',
      dtype:'fp16',
      progress_callback: (update: ProgressInfo) => {
        const percent = (
          'progress' in update && typeof update.progress === 'number'
        ) ? update.progress / 100 : 0
        report(id, 0.04 + percent * 0.42, 'Loading background-removal model')
      },
  } as const

  return Promise.all([
    AutoImageProcessor.from_pretrained(MODEL_ID, options),
    AutoModel.from_pretrained(MODEL_ID, options),
  ]).then(([processor, model]) => ({ processor, model }))
}

let enginePromise: ReturnType<typeof createEngine> | undefined

function getEngine(id: string) {
  return enginePromise ??= createEngine(id)
}

function createInferenceCanvas(
  bitmap: ImageBitmap,
  source: SourceRect,
) {
  const scale = Math.min(
    1,
    MAX_INFERENCE_EDGE / Math.max(source.width, source.height),
  )
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { alpha:false })
  if (!context) {
    throw new Error('Unable to prepare the image for background removal.')
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    bitmap,
    source.left,
    source.top,
    source.width,
    source.height,
    0,
    0,
    width,
    height,
  )
  return canvas
}

async function inferMask(
  engine: Awaited<ReturnType<typeof createEngine>>,
  canvas: OffscreenCanvas,
) {
  const inferenceImage = RawImage.fromCanvas(canvas)
  const { pixel_values } = await engine.processor._call([inferenceImage])
  const inference = await engine.model._call({ input_image:pixel_values })
  const output = inference.output_image
  if (!output) {
    throw new Error('The background-removal model returned no mask.')
  }
  return RawImage
    .fromTensor(output[0].sigmoid().mul(255).to('uint8'))
    .resize(canvas.width, canvas.height)
}

function findRefinementRect(
  mask: RawImage,
  imageWidth: number,
  imageHeight: number,
): SourceRect | undefined {
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] < MASK_THRESHOLD) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxX < minX || maxY < minY) return

  let left = Math.floor(minX / mask.width * imageWidth)
  let top = Math.floor(minY / mask.height * imageHeight)
  let right = Math.ceil((maxX + 1) / mask.width * imageWidth)
  let bottom = Math.ceil((maxY + 1) / mask.height * imageHeight)
  const padding = Math.round(
    Math.max(right - left, bottom - top) * REFINEMENT_PADDING,
  )
  left = Math.max(0, left - padding)
  top = Math.max(0, top - padding)
  right = Math.min(imageWidth, right + padding)
  bottom = Math.min(imageHeight, bottom + padding)

  const width = right - left
  const height = bottom - top
  const resolutionGain = Math.max(imageWidth, imageHeight)
    / Math.max(width, height)
  if (width < 2 || height < 2 || resolutionGain < 1.2) return
  return { left, top, width, height }
}

function sharpenAlpha(value: number) {
  const normalized = value / 255
  const contrasted = Math.max(0, Math.min(1, (normalized - 0.18) / 0.66))
  return Math.round(
    contrasted * contrasted * (3 - 2 * contrasted) * 255,
  )
}

function applyFullResolutionAlpha(
  context: OffscreenCanvasRenderingContext2D,
  imageWidth: number,
  imageHeight: number,
  mask: RawImage,
  source: SourceRect,
) {
  const pixels = context.getImageData(0, 0, imageWidth, imageHeight)
  const data = pixels.data
  for (let offset = 3; offset < data.length; offset += 4) {
    data[offset] = 0
  }

  const x0 = new Int32Array(source.width)
  const x1 = new Int32Array(source.width)
  const xWeight = new Float32Array(source.width)
  for (let x = 0; x < source.width; x += 1) {
    const maskX = (x + 0.5) * mask.width / source.width - 0.5
    const lower = Math.max(0, Math.min(mask.width - 1, Math.floor(maskX)))
    x0[x] = lower
    x1[x] = Math.min(mask.width - 1, lower + 1)
    xWeight[x] = Math.max(0, Math.min(1, maskX - lower))
  }

  for (let y = 0; y < source.height; y += 1) {
    const maskY = (y + 0.5) * mask.height / source.height - 0.5
    const lowerY = Math.max(0, Math.min(mask.height - 1, Math.floor(maskY)))
    const upperY = Math.min(mask.height - 1, lowerY + 1)
    const yWeight = Math.max(0, Math.min(1, maskY - lowerY))
    const lowerRow = lowerY * mask.width
    const upperRow = upperY * mask.width
    const outputRow = (source.top + y) * imageWidth + source.left

    for (let x = 0; x < source.width; x += 1) {
      const horizontalWeight = xWeight[x]
      const top = mask.data[lowerRow + x0[x]] * (1 - horizontalWeight)
        + mask.data[lowerRow + x1[x]] * horizontalWeight
      const bottom = mask.data[upperRow + x0[x]] * (1 - horizontalWeight)
        + mask.data[upperRow + x1[x]] * horizontalWeight
      const alpha = top * (1 - yWeight) + bottom * yWeight
      data[(outputRow + x) * 4 + 3] = sharpenAlpha(alpha)
    }
  }
  context.putImageData(pixels, 0, 0)
}

workerScope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type !== 'remove-background') return
  let bitmap: ImageBitmap | undefined
  try {
    report(data.id, 0.02, 'Starting background-removal engine')
    const engine = await getEngine(data.id)
    report(data.id, 0.47, 'Decoding source image')
    bitmap = await createImageBitmap(data.image)

    const wholeImage = {
      left:0,
      top:0,
      width:bitmap.width,
      height:bitmap.height,
    }
    report(data.id, 0.53, 'Finding the foreground')
    let mask = await inferMask(
      engine,
      createInferenceCanvas(bitmap, wholeImage),
    )
    let maskSource = wholeImage

    const refinementRect = findRefinementRect(
      mask,
      bitmap.width,
      bitmap.height,
    )
    if (refinementRect) {
      report(data.id, 0.72, 'Refining subject edges')
      mask = await inferMask(
        engine,
        createInferenceCanvas(bitmap, refinementRect),
      )
      maskSource = refinementRect
    }

    report(data.id, 0.88, 'Applying lossless full-resolution transparency')
    const outputCanvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const outputContext = outputCanvas.getContext('2d', { alpha:true })
    if (!outputContext) {
      throw new Error('Unable to create the transparent output image.')
    }
    outputContext.drawImage(bitmap, 0, 0)
    applyFullResolutionAlpha(
      outputContext,
      bitmap.width,
      bitmap.height,
      mask,
      maskSource,
    )

    const blob = await outputCanvas.convertToBlob({ type:'image/png' })
    report(data.id, 0.98, 'Finishing transparent PNG')
    workerScope.postMessage({
      type:'result',
      id:data.id,
      blob,
      width:bitmap.width,
      height:bitmap.height,
    })
  } catch (error) {
    workerScope.postMessage({
      type:'error',
      id:data.id,
      error:error instanceof Error
        ? error.message
        : 'Unable to remove the image background.',
    })
  } finally {
    bitmap?.close()
  }
}
