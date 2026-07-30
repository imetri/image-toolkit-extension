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
const MODEL_FILE_NAME = 'model_fp16.onnx'
const MODEL_FILE_SIZE = 98_484_532
const MODEL_FILE_PARTS = [
  'model_fp16.onnx.part-0',
  'model_fp16.onnx.part-1',
  'model_fp16.onnx.part-2',
  'model_fp16.onnx.part-3',
] as const
const MAX_INFERENCE_EDGE = 512
const COMPONENT_THRESHOLD = 24
const REFINEMENT_PADDING = 0.14
const MAX_REFINEMENT_PASSES = 4
const MAX_PERSON_REFINEMENT_PASSES = 8
const MAX_EDGE_REFINEMENT_PASSES = 4
const MAX_TOTAL_REFINEMENT_PASSES = 12
const MIN_COMPONENT_FRACTION = 0.001
const HEAD_THRESHOLD = 100
const HEAD_ZONE_FRACTIONS = [0.1, 0.15, 0.2, 0.26] as const
const MIN_HEAD_AREA_FRACTION = 0.0009
const MIN_HEAD_WIDTH_FRACTION = 0.015
const MAX_HEAD_WIDTH_FRACTION = 0.34
const MIN_HEAD_HEIGHT_RATIO = 0.38
const MAX_HEAD_HEIGHT_RATIO = 1.2
const PERSON_CROP_CONTEXT = 0.8
const PERSON_CROP_MIN_ASPECT = 0.75
const PERSON_OWNERSHIP_FEATHER = 0.12
const HEAD_CROP_WIDTH_SCALE = 2.8
const HEAD_CROP_HEIGHT_SCALE = 3.8
const HEAD_CROP_TOP_PADDING = 0.55
const HAIR_DETAIL_ZONE_FRACTION = 0.72
const HAIR_ALPHA_CURVE_POWER = 2.2
const STANDARD_ALPHA_CURVE_POWER = 4
const EDGE_TILE_SCALE = 0.3
const EDGE_TILE_MIN_EDGE = 72
const EDGE_TILE_MAX_FRAME_FRACTION = 0.42
const EDGE_TILE_STRIDE_FRACTION = 0.22
const EDGE_TILE_PADDING = 0.12
const EDGE_TILE_MIN_DETAIL_DENSITY = 0.006
const EDGE_TILE_TRIGGER_DENSITY = 0.012
const EDGE_TILE_MEDIUM_DETAIL_DENSITY = 0.015
const EDGE_TILE_HIGH_DETAIL_DENSITY = 0.02
const EDGE_TILE_MIN_FOREGROUND_COVERAGE = 0.04
const EDGE_TILE_MAX_FOREGROUND_COVERAGE = 0.9
const EDGE_TILE_MAX_OVERLAP = 0.3
const EDGE_BACKGROUND_THRESHOLD = 72
const EDGE_FOREGROUND_THRESHOLD = 183
const REFINEMENT_DUPLICATE_OVERLAP = 0.58
const REFINEMENT_DUPLICATE_AREA_RATIO = 0.55
const CONSENSUS_CROP_MARGIN = 0.04
const CONSENSUS_BACKGROUND_THRESHOLD = 56
const CONSENSUS_FOREGROUND_THRESHOLD = 210
const CONSENSUS_BACKGROUND_VOTES = 2
const CONSENSUS_FOREGROUND_FLAG = 0x80
const CONSENSUS_BACKGROUND_MASK = 0x7f
const POCKET_BACKGROUND_THRESHOLD = 32
const POCKET_MIN_AREA = 48
const POCKET_MAX_AREA_FRACTION = 0.015
const POCKET_EXPANSION_RADIUS = 6
const POCKET_FEATHER_RADIUS = 3
const COLOR_BUCKET_BITS = 4
const COLOR_BUCKET_COUNT = 1 << (COLOR_BUCKET_BITS * 3)
const COLOR_ISLAND_BACKGROUND_ALPHA = 24
const COLOR_ISLAND_FOREGROUND_ALPHA = 232
const COLOR_ISLAND_SEED_ALPHA = 224
const COLOR_ISLAND_REFINEMENT_BACKGROUND_VOTES = 1
const COLOR_ISLAND_BACKGROUND_RATIO = 0.97
const COLOR_ISLAND_GROWTH_RATIO = 0.5
const COLOR_ISLAND_MIN_AREA_FRACTION = 0.00004
const COLOR_ISLAND_MIN_FILL_RATIO = 0.38
const COLOR_ISLAND_MAX_AREA_FRACTION = 0.004
const COLOR_ISLAND_CLEARANCE_SCALE = 1.2
const COLOR_ISLAND_MAX_CLEARANCE_FRACTION = 0.08
const COLOR_ISLAND_GROWTH_PADDING = 12
const COLOR_ISLAND_EXPANSION_RADIUS = 0
const COLOR_ISLAND_FEATHER_RADIUS = 2
const ALPHA_FILTER_RADIUS = 2
const ALPHA_FILTER_PASSES = 2
const MAX_COLOR_EDGE_RADIUS = 24
const DECONTAMINATION_BACKGROUND_ALPHA = 5
const DECONTAMINATION_FOREGROUND_ALPHA = 250
const DECONTAMINATION_MIN_SOLVE_ALPHA = 0.08
const DECONTAMINATION_BACKGROUND_COLOR_TOLERANCE = 72
const MAX_DECONTAMINATION_RADIUS = 16
const DETACHED_ARTIFACT_THRESHOLD = 128
const DETACHED_ARTIFACT_MAX_PRIMARY_FRACTION = 0.012
const DETACHED_ARTIFACT_LOWER_FRACTION = 0.48
const DETACHED_ARTIFACT_MAP_EDGE = 512
const DETACHED_ARTIFACT_PADDING = 1
const COLOR_EDGE_DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const

type SourceRect = {
  left: number
  top: number
  width: number
  height: number
}

type MaskLayer = {
  mask: RawImage
  source: SourceRect
  detail?: 'person' | 'hair' | 'edge'
  ownership?: {
    left: number
    right: number
  }
}

type MaskComponent = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  area: number
}

env.allowRemoteModels = false
env.allowLocalModels = true
env.useBrowserCache = false
env.localModelPath = new URL('/models/', workerScope.location.href).href
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1

// Keep the local model in repository-friendly chunks while presenting the
// single ONNX response expected by Transformers.js. The parts are streamed in
// order, so loading does not require a second full-size in-memory copy.
const nativeFetch = workerScope.fetch.bind(workerScope)
workerScope.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const requestedUrl = new URL(
    input instanceof Request ? input.url : input.toString(),
    workerScope.location.href,
  )
  if (!requestedUrl.pathname.endsWith(`/${MODEL_FILE_NAME}`)) {
    return nativeFetch(input, init)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const part of MODEL_FILE_PARTS) {
          const partUrl = new URL(part, requestedUrl)
          const response = await nativeFetch(partUrl)
          if (!response.ok || !response.body) {
            throw new Error(
              `Unable to load background-removal model part ${part}.`,
            )
          }
          const reader = response.body.getReader()
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Length':String(MODEL_FILE_SIZE),
      'Content-Type':'application/octet-stream',
    },
  })
}) as typeof fetch

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
  return RawImage.fromTensor(output[0].sigmoid().mul(255).to('uint8'))
}

function findMaskComponents(
  mask: RawImage,
  threshold: number,
  maximumY = mask.height - 1,
): MaskComponent[] {
  const pixelCount = mask.width * mask.height
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const components: MaskComponent[] = []

  for (let start = 0; start < pixelCount; start += 1) {
    const startY = Math.floor(start / mask.width)
    if (
      startY > maximumY
      || visited[start]
      || mask.data[start] < threshold
    ) continue

    let read = 0
    let write = 0
    let area = 0
    let minX = mask.width
    let minY = mask.height
    let maxX = -1
    let maxY = -1
    queue[write++] = start
    visited[start] = 1

    while (read < write) {
      const index = queue[read++]
      const x = index % mask.width
      const y = Math.floor(index / mask.width)
      area += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)

      const xStart = Math.max(0, x - 1)
      const xEnd = Math.min(mask.width - 1, x + 1)
      const yStart = Math.max(0, y - 1)
      const yEnd = Math.min(maximumY, y + 1)
      for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
        const row = neighborY * mask.width
        for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1) {
          const neighbor = row + neighborX
          if (
            visited[neighbor]
            || mask.data[neighbor] < threshold
          ) continue
          visited[neighbor] = 1
          queue[write++] = neighbor
        }
      }
    }

    components.push({ minX, minY, maxX, maxY, area })
  }

  return components
}

function removeDetachedFullResolutionArtifacts(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const scale = Math.min(
    1,
    DETACHED_ARTIFACT_MAP_EDGE / Math.max(width, height),
  )
  const mapWidth = Math.max(1, Math.round(width * scale))
  const mapHeight = Math.max(1, Math.round(height * scale))
  const mappedAlpha = new Uint8ClampedArray(mapWidth * mapHeight)
  const xMap = new Int32Array(width)
  for (let x = 0; x < width; x += 1) {
    xMap[x] = Math.min(
      mapWidth - 1,
      Math.floor(x / width * mapWidth),
    )
  }
  for (let y = 0; y < height; y += 1) {
    const mappedY = Math.min(
      mapHeight - 1,
      Math.floor(y / height * mapHeight),
    )
    const sourceRow = y * width
    const targetRow = mappedY * mapWidth
    for (let x = 0; x < width; x += 1) {
      const target = targetRow + xMap[x]
      mappedAlpha[target] = Math.max(
        mappedAlpha[target],
        alpha[sourceRow + x],
      )
    }
  }

  const mask = new RawImage(
    mappedAlpha,
    mapWidth,
    mapHeight,
    1,
  )
  const components = findMaskComponents(
    mask,
    DETACHED_ARTIFACT_THRESHOLD,
  ).sort((a, b) => b.area - a.area)
  const primary = components[0]
  if (!primary) return

  const primaryHeight = primary.maxY - primary.minY + 1
  const lowerBoundary = (
    primary.minY + primaryHeight * DETACHED_ARTIFACT_LOWER_FRACTION
  )
  const maximumArea = Math.max(
    8,
    Math.round(
      primary.area * DETACHED_ARTIFACT_MAX_PRIMARY_FRACTION,
    ),
  )

  for (const component of components.slice(1)) {
    const isLowerArtifact = component.minY >= lowerBoundary
    const isOutsidePrimary = (
      component.maxX < primary.minX
      || component.minX > primary.maxX
    )
    if (
      !isLowerArtifact
      || !isOutsidePrimary
      || component.area > maximumArea
    ) continue

    const mappedLeft = Math.max(
      0,
      component.minX - DETACHED_ARTIFACT_PADDING,
    )
    const mappedTop = Math.max(
      0,
      component.minY - DETACHED_ARTIFACT_PADDING,
    )
    const mappedRight = Math.min(
      mask.width - 1,
      component.maxX + DETACHED_ARTIFACT_PADDING,
    )
    const mappedBottom = Math.min(
      mask.height - 1,
      component.maxY + DETACHED_ARTIFACT_PADDING,
    )
    const left = Math.floor(mappedLeft / mapWidth * width)
    const top = Math.floor(mappedTop / mapHeight * height)
    const right = Math.min(
      width - 1,
      Math.ceil((mappedRight + 1) / mapWidth * width),
    )
    const bottom = Math.min(
      height - 1,
      Math.ceil((mappedBottom + 1) / mapHeight * height),
    )
    for (let y = top; y <= bottom; y += 1) {
      const row = y * width
      for (let x = left; x <= right; x += 1) {
        alpha[row + x] = 0
      }
    }
  }
}

function expandEnclosedBackgroundPockets(mask: RawImage) {
  const pixelCount = mask.width * mask.height
  const maximumArea = Math.round(
    pixelCount * POCKET_MAX_AREA_FRACTION,
  )
  const visited = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  const expanded = mask.clone()
  const outerRadius = (
    POCKET_EXPANSION_RADIUS + POCKET_FEATHER_RADIUS
  )

  for (let start = 0; start < pixelCount; start += 1) {
    if (
      visited[start]
      || mask.data[start] > POCKET_BACKGROUND_THRESHOLD
    ) continue

    let read = 0
    let write = 0
    let touchesBorder = false
    queue[write++] = start
    visited[start] = 1

    while (read < write) {
      const index = queue[read++]
      const x = index % mask.width
      const y = Math.floor(index / mask.width)
      if (
        x === 0
        || y === 0
        || x === mask.width - 1
        || y === mask.height - 1
      ) touchesBorder = true

      const xStart = Math.max(0, x - 1)
      const xEnd = Math.min(mask.width - 1, x + 1)
      const yStart = Math.max(0, y - 1)
      const yEnd = Math.min(mask.height - 1, y + 1)
      for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
        const row = neighborY * mask.width
        for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1) {
          const neighbor = row + neighborX
          if (
            visited[neighbor]
            || mask.data[neighbor] > POCKET_BACKGROUND_THRESHOLD
          ) continue
          visited[neighbor] = 1
          queue[write++] = neighbor
        }
      }
    }

    if (
      touchesBorder
      || write < POCKET_MIN_AREA
      || write > maximumArea
    ) continue

    // The model has found a small, fully enclosed background opening, but
    // interpolation can restore its uncertain rim as opaque foreground.
    // Expand only this confirmed pocket; large/exterior background regions
    // and tiny facial details are deliberately excluded.
    for (let componentIndex = 0; componentIndex < write; componentIndex += 1) {
      const seed = queue[componentIndex]
      const seedX = seed % mask.width
      const seedY = Math.floor(seed / mask.width)
      for (let dy = -outerRadius; dy <= outerRadius; dy += 1) {
        const targetY = seedY + dy
        if (targetY < 0 || targetY >= mask.height) continue
        for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
          const targetX = seedX + dx
          if (targetX < 0 || targetX >= mask.width) continue
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance > outerRadius) continue
          const alphaCap = distance <= POCKET_EXPANSION_RADIUS
            ? 0
            : Math.round(
                (distance - POCKET_EXPANSION_RADIUS)
                / POCKET_FEATHER_RADIUS
                * 255,
              )
          const target = targetY * mask.width + targetX
          expanded.data[target] = Math.min(
            expanded.data[target],
            alphaCap,
          )
        }
      }
    }
  }

  return expanded
}

function findRefinementRects(
  mask: RawImage,
  imageWidth: number,
  imageHeight: number,
): SourceRect[] {
  const pixelCount = mask.width * mask.height
  const components = findMaskComponents(mask, COMPONENT_THRESHOLD)
  const minimumArea = Math.max(32, Math.round(pixelCount * MIN_COMPONENT_FRACTION))
  return components
    .filter(component => component.area >= minimumArea)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_REFINEMENT_PASSES)
    .map(component => {
      let left = Math.floor(component.minX / mask.width * imageWidth)
      let top = Math.floor(component.minY / mask.height * imageHeight)
      let right = Math.ceil((component.maxX + 1) / mask.width * imageWidth)
      let bottom = Math.ceil((component.maxY + 1) / mask.height * imageHeight)
      const padding = Math.round(
        Math.max(right - left, bottom - top) * REFINEMENT_PADDING,
      )
      left = Math.max(0, left - padding)
      top = Math.max(0, top - padding)
      right = Math.min(imageWidth, right + padding)
      bottom = Math.min(imageHeight, bottom + padding)
      return {
        left,
        top,
        width:right - left,
        height:bottom - top,
      }
    })
    .filter(rect => {
      const resolutionGain = Math.max(imageWidth, imageHeight)
        / Math.max(rect.width, rect.height)
      return rect.width >= 2 && rect.height >= 2 && resolutionGain >= 1.15
    })
}

function rectOverlap(first: SourceRect, second: SourceRect) {
  const intersectionWidth = Math.max(
    0,
    Math.min(first.left + first.width, second.left + second.width)
      - Math.max(first.left, second.left),
  )
  const intersectionHeight = Math.max(
    0,
    Math.min(first.top + first.height, second.top + second.height)
      - Math.max(first.top, second.top),
  )
  const intersection = intersectionWidth * intersectionHeight
  if (intersection === 0) return 0
  const union = first.width * first.height
    + second.width * second.height
    - intersection
  return intersection / union
}

function summedArea(
  integral: Float64Array,
  stride: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return integral[bottom * stride + right]
    - integral[top * stride + right]
    - integral[bottom * stride + left]
    + integral[top * stride + left]
}

function scanPositions(maximum: number, stride: number) {
  const positions: number[] = []
  for (let position = 0; position <= maximum; position += stride) {
    positions.push(position)
  }
  if (positions[positions.length - 1] !== maximum) positions.push(maximum)
  return positions
}

function findEdgeRefinementLayers(
  mask: RawImage,
  imageWidth: number,
  imageHeight: number,
): Array<Pick<MaskLayer, 'source' | 'detail'>> {
  const foreground = findMaskComponents(mask, COMPONENT_THRESHOLD)
    .sort((a, b) => b.area - a.area)[0]
  if (!foreground) return []

  const foregroundWidth = foreground.maxX - foreground.minX + 1
  const foregroundHeight = foreground.maxY - foreground.minY + 1
  const maximumTileEdge = Math.max(
    2,
    Math.floor(
      Math.min(mask.width, mask.height)
      * EDGE_TILE_MAX_FRAME_FRACTION,
    ),
  )
  const tileEdge = Math.min(
    maximumTileEdge,
    Math.max(
      Math.min(EDGE_TILE_MIN_EDGE, maximumTileEdge),
      Math.round(
        Math.max(foregroundWidth, foregroundHeight) * EDGE_TILE_SCALE,
      ),
    ),
  )
  if (tileEdge < 2) return []

  const integralStride = mask.width + 1
  const detailIntegral = new Float64Array(
    integralStride * (mask.height + 1),
  )
  const foregroundIntegral = new Float64Array(
    integralStride * (mask.height + 1),
  )

  // Score only transitions that locally contain both foreground and
  // background. Internal uncertainty (reflections, eyes, texture) is excluded,
  // while soft, irregular hair and fur boundaries receive the strongest weight.
  for (let y = 0; y < mask.height; y += 1) {
    let detailRow = 0
    let foregroundRow = 0
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x
      const alpha = mask.data[index]
      let localMinimum = alpha
      let localMaximum = alpha
      for (
        let neighborY = Math.max(0, y - 1);
        neighborY <= Math.min(mask.height - 1, y + 1);
        neighborY += 1
      ) {
        const neighborRow = neighborY * mask.width
        for (
          let neighborX = Math.max(0, x - 1);
          neighborX <= Math.min(mask.width - 1, x + 1);
          neighborX += 1
        ) {
          const neighbor = mask.data[neighborRow + neighborX]
          localMinimum = Math.min(localMinimum, neighbor)
          localMaximum = Math.max(localMaximum, neighbor)
        }
      }

      let detail = 0
      if (
        localMinimum <= EDGE_BACKGROUND_THRESHOLD
        && localMaximum >= EDGE_FOREGROUND_THRESHOLD
      ) {
        const transition = Math.min(alpha, 255 - alpha) / 127.5
        const contrast = (localMaximum - localMinimum) / 255
        detail = contrast * (0.25 + transition * 0.75)
      }
      detailRow += detail
      foregroundRow += alpha >= COMPONENT_THRESHOLD ? 1 : 0
      const target = (y + 1) * integralStride + x + 1
      detailIntegral[target] = (
        detailIntegral[target - integralStride] + detailRow
      )
      foregroundIntegral[target] = (
        foregroundIntegral[target - integralStride] + foregroundRow
      )
    }
  }

  const maximumLeft = mask.width - tileEdge
  const maximumTop = mask.height - tileEdge
  const stride = Math.max(
    8,
    Math.round(tileEdge * EDGE_TILE_STRIDE_FRACTION),
  )
  const tileArea = tileEdge * tileEdge
  const candidates: Array<SourceRect & { score: number }> = []
  let maximumDetailDensity = 0
  for (const top of scanPositions(maximumTop, stride)) {
    for (const left of scanPositions(maximumLeft, stride)) {
      const right = left + tileEdge
      const bottom = top + tileEdge
      const foregroundCoverage = summedArea(
        foregroundIntegral,
        integralStride,
        left,
        top,
        right,
        bottom,
      ) / tileArea
      if (
        foregroundCoverage < EDGE_TILE_MIN_FOREGROUND_COVERAGE
        || foregroundCoverage > EDGE_TILE_MAX_FOREGROUND_COVERAGE
      ) continue

      const boundaryDetail = summedArea(
        detailIntegral,
        integralStride,
        left,
        top,
        right,
        bottom,
      )
      const detailDensity = boundaryDetail / tileArea
      maximumDetailDensity = Math.max(
        maximumDetailDensity,
        detailDensity,
      )
      if (detailDensity < EDGE_TILE_MIN_DETAIL_DENSITY) continue

      const centerY = top + tileEdge / 2
      const upperSubjectBias = 1.16 - 0.16 * centerY / mask.height
      candidates.push({
        left,
        top,
        width:tileEdge,
        height:tileEdge,
        score:boundaryDetail * upperSubjectBias,
      })
    }
  }
  if (maximumDetailDensity < EDGE_TILE_TRIGGER_DENSITY) return []
  const targetTileCount = maximumDetailDensity
      >= EDGE_TILE_HIGH_DETAIL_DENSITY
    ? 4
    : maximumDetailDensity >= EDGE_TILE_MEDIUM_DETAIL_DENSITY
      ? 3
      : 2

  const selected: SourceRect[] = []
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (
      selected.some(
        existing => rectOverlap(existing, candidate) > EDGE_TILE_MAX_OVERLAP,
      )
    ) continue
    selected.push(candidate)
    if (
      selected.length
      >= Math.min(MAX_EDGE_REFINEMENT_PASSES, targetTileCount)
    ) break
  }
  if (selected.length < 2) return []

  return selected
    .map(tile => {
      const padding = Math.round(tileEdge * EDGE_TILE_PADDING)
      const left = Math.max(0, tile.left - padding)
      const top = Math.max(0, tile.top - padding)
      const right = Math.min(mask.width, tile.left + tile.width + padding)
      const bottom = Math.min(mask.height, tile.top + tile.height + padding)
      const source = {
        left:Math.floor(left / mask.width * imageWidth),
        top:Math.floor(top / mask.height * imageHeight),
        width:Math.ceil(right / mask.width * imageWidth)
          - Math.floor(left / mask.width * imageWidth),
        height:Math.ceil(bottom / mask.height * imageHeight)
          - Math.floor(top / mask.height * imageHeight),
      }
      return { source, detail:'edge' as const }
    })
    .filter(layer => {
      const resolutionGain = Math.max(imageWidth, imageHeight)
        / Math.max(layer.source.width, layer.source.height)
      return (
        layer.source.width >= 2
        && layer.source.height >= 2
        && resolutionGain >= 1.5
      )
    })
}

function findPersonRefinementLayers(
  mask: RawImage,
  imageWidth: number,
  imageHeight: number,
): Array<Pick<
  MaskLayer,
  'source' | 'detail' | 'ownership'
>> {
  const pixelCount = mask.width * mask.height
  const minimumArea = Math.max(
    32,
    Math.round(pixelCount * MIN_COMPONENT_FRACTION),
  )
  const foreground = findMaskComponents(mask, COMPONENT_THRESHOLD)
    .filter(component => component.area >= minimumArea)
    .sort((a, b) => b.area - a.area)[0]
  if (!foreground) return []

  const foregroundHeight = foreground.maxY - foreground.minY + 1
  const minimumHeadArea = Math.max(
    40,
    Math.round(pixelCount * MIN_HEAD_AREA_FRACTION),
  )
  const minimumSeparation = mask.width * 0.035
  let heads: MaskComponent[] = []
  for (const headZoneFraction of HEAD_ZONE_FRACTIONS) {
    const headZoneBottom = Math.min(
      mask.height - 1,
      Math.round(
        foreground.minY + foregroundHeight * headZoneFraction,
      ),
    )
    const candidates = findMaskComponents(
      mask,
      HEAD_THRESHOLD,
      headZoneBottom,
    )
      .filter(component => {
        const width = component.maxX - component.minX + 1
        const height = component.maxY - component.minY + 1
        const fill = component.area / (width * height)
        return (
          component.area >= minimumHeadArea
          && width >= mask.width * MIN_HEAD_WIDTH_FRACTION
          && width <= mask.width * MAX_HEAD_WIDTH_FRACTION
          && height >= width * MIN_HEAD_HEIGHT_RATIO
          && height <= width * MAX_HEAD_HEIGHT_RATIO
          && fill >= 0.32
        )
      })
      .sort((a, b) => b.area - a.area)
      .slice(0, MAX_PERSON_REFINEMENT_PASSES)
      .sort((a, b) => a.minX - b.minX)
      // Keep one component per head when a small detached detail sits beside it.
      .filter((head, index, components) => {
        if (index === 0) return true
        const center = (head.minX + head.maxX + 1) / 2
        const previous = components[index - 1]
        const previousCenter = (
          previous.minX + previous.maxX + 1
        ) / 2
        return center - previousCenter >= minimumSeparation
      })

    // A tight zone keeps adjacent heads separate; the wider fallback retains
    // enough height for photos where only the upper part of a head is visible.
    if (candidates.length >= heads.length) heads = candidates
  }
  if (heads.length === 0) return []

  const centers = heads.map(head => (head.minX + head.maxX + 1) / 2)
  const bandEdges = [
    foreground.minX,
    ...centers.slice(0, -1).map(
      (center, index) => (center + centers[index + 1]) / 2,
    ),
    foreground.maxX + 1,
  ]
  const sortedHeadWidths = heads
    .map(head => head.maxX - head.minX + 1)
    .sort((a, b) => a - b)
  const medianHeadWidth = sortedHeadWidths[
    Math.floor(sortedHeadWidths.length / 2)
  ]
  const headWidth = medianHeadWidth / mask.width * imageWidth
  const headTop = Math.min(...heads.map(head => head.minY))
  const cropTop = Math.max(
    0,
    Math.floor(
      (headTop - medianHeadWidth * 0.55) / mask.height * imageHeight,
    ),
  )
  const cropBottom = Math.min(
    imageHeight,
    Math.ceil((foreground.maxY + 1) / mask.height * imageHeight)
      + Math.round(medianHeadWidth * 0.18 / mask.height * imageHeight),
  )

  const personLayers = heads.map((_head, index) => {
    const bandLeft = bandEdges[index]
    const bandRight = bandEdges[index + 1]
    const bandWidth = bandRight - bandLeft
    const ownership = {
      left:Math.floor(bandLeft / mask.width * imageWidth),
      right:Math.ceil(bandRight / mask.width * imageWidth),
    }
    let left: number
    let right: number
    const context = bandWidth * PERSON_CROP_CONTEXT
    left = Math.max(
      0,
      Math.floor((bandLeft - context) / mask.width * imageWidth),
    )
    right = Math.min(
      imageWidth,
      Math.ceil((bandRight + context) / mask.width * imageWidth),
    )
    const minimumCropWidth = Math.min(
      imageWidth,
      Math.ceil(
        (cropBottom - cropTop) * PERSON_CROP_MIN_ASPECT,
      ),
    )
    const headCenter = (
      (heads[index].minX + heads[index].maxX + 1)
      / 2 / mask.width * imageWidth
    )
    if (right - left < minimumCropWidth) {
      left = Math.max(
        0,
        Math.min(
          imageWidth - minimumCropWidth,
          Math.floor(headCenter - minimumCropWidth / 2),
        ),
      )
      right = left + minimumCropWidth
    }
    return {
      source:{
        left,
        top:cropTop,
        width:right - left,
        height:cropBottom - cropTop,
      },
      detail:'person' as const,
      ownership,
    }
  }).filter(layer => layer.source.width >= 2 && layer.source.height >= 2)

  // A full-body crop still allocates only a small part of the model input to
  // the head and narrow gaps around bent arms. A tighter portrait/upper-body
  // pass gives both regions more pixels, while the ownership band protects
  // neighboring people.
  const headCropWidth = headWidth * HEAD_CROP_WIDTH_SCALE
  const headCropHeight = headWidth * HEAD_CROP_HEIGHT_SCALE
  const headLayers = heads.map((head, index) => {
    const centerX = (
      (head.minX + head.maxX + 1) / 2 / mask.width * imageWidth
    )
    const headTop = head.minY / mask.height * imageHeight
    const left = Math.max(0, Math.floor(centerX - headCropWidth / 2))
    const top = Math.max(
      0,
      Math.floor(headTop - headWidth * HEAD_CROP_TOP_PADDING),
    )
    const right = Math.min(
      imageWidth,
      Math.ceil(centerX + headCropWidth / 2),
    )
    const bottom = Math.min(
      imageHeight,
      Math.ceil(top + headCropHeight),
    )
    return {
      source:{
        left,
        top,
        width:right - left,
        height:bottom - top,
      },
      detail:'hair' as const,
      ownership:personLayers[index].ownership,
    }
  }).filter(layer => layer.source.width >= 2 && layer.source.height >= 2)

  return [...personLayers, ...headLayers]
}

function polishAlpha(value: number, preserveFineDetail = false) {
  const normalized = value / 255
  const transparentLimit = preserveFineDetail ? 0.003 : 0.015
  const opaqueLimit = preserveFineDetail ? 0.997 : 0.985
  if (normalized <= transparentLimit) return 0
  if (normalized >= opaqueLimit) return 255

  // A strong odds curve keeps ordinary contours crisp. Hair uses a gentler
  // curve so low-opacity strand predictions survive the final matte polish.
  const power = preserveFineDetail
    ? HAIR_ALPHA_CURVE_POWER
    : STANDARD_ALPHA_CURVE_POWER
  const foreground = normalized ** power
  const background = (1 - normalized) ** power
  return Math.round(foreground / (foreground + background) * 255)
}

function rasterizeMask(
  alpha: Uint8ClampedArray,
  imageWidth: number,
  layer: MaskLayer,
  blendAtBorder: boolean,
  consensusEvidence?: Uint8Array,
  lowestBackground?: Uint8ClampedArray,
  refinementEvidence?: Uint8Array,
) {
  const { mask, source, ownership } = layer
  const consensusMargin = Math.max(
    2,
    Math.round(
      Math.min(source.width, source.height) * CONSENSUS_CROP_MARGIN,
    ),
  )
  const ownershipFeather = ownership
    ? Math.max(
        2,
        Math.round(
          (ownership.right - ownership.left) * PERSON_OWNERSHIP_FEATHER,
        ),
      )
    : 0
  const verticalFeather = Math.max(
    2,
    Math.round(source.height * 0.035),
  )
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
      const predicted = top * (1 - yWeight) + bottom * yWeight
      const outputIndex = outputRow + x
      const outputX = source.left + x
      const isOwnedPixel = (
        !ownership
        || (outputX >= ownership.left && outputX < ownership.right)
      )
      const isCropInterior = (
        x >= consensusMargin
        && y >= consensusMargin
        && x < source.width - consensusMargin
        && y < source.height - consensusMargin
      )
      if (refinementEvidence && isCropInterior && isOwnedPixel) {
        const evidence = refinementEvidence[outputIndex]
        if (predicted <= CONSENSUS_BACKGROUND_THRESHOLD) {
          const votes = evidence & CONSENSUS_BACKGROUND_MASK
          refinementEvidence[outputIndex] = (
            evidence & CONSENSUS_FOREGROUND_FLAG
          ) | Math.min(CONSENSUS_BACKGROUND_MASK, votes + 1)
        } else if (predicted >= CONSENSUS_FOREGROUND_THRESHOLD) {
          refinementEvidence[outputIndex] |= CONSENSUS_FOREGROUND_FLAG
        }
      }
      if (
        consensusEvidence
        && lowestBackground
        && isCropInterior
      ) {
        if (predicted <= CONSENSUS_BACKGROUND_THRESHOLD) {
          const evidence = consensusEvidence[outputIndex]
          const votes = evidence & CONSENSUS_BACKGROUND_MASK
          consensusEvidence[outputIndex] = (
            evidence & CONSENSUS_FOREGROUND_FLAG
          ) | Math.min(CONSENSUS_BACKGROUND_MASK, votes + 1)
          lowestBackground[outputIndex] = Math.min(
            lowestBackground[outputIndex],
            Math.round(predicted),
          )
        } else if (predicted >= CONSENSUS_FOREGROUND_THRESHOLD) {
          consensusEvidence[outputIndex] |= CONSENSUS_FOREGROUND_FLAG
        }
      }

      if (!isOwnedPixel) continue
      if (!blendAtBorder) {
        alpha[outputIndex] = predicted
        continue
      }

      // Tight refinement crops have more useful pixels but less scene context.
      // Restrict them to reshaping an uncertain preceding matte, so a crop can
      // resolve strands without inventing solid rectangular foreground.
      const prior = alpha[outputIndex]
      const priorUncertainty = (
        1 - Math.abs(prior - 127.5) / 127.5
      )
      const safePrediction = (
        prior + (predicted - prior) * priorUncertainty
      )
      const blend = ownership
        ? Math.max(0, Math.min(
            1,
            (outputX - ownership.left) / ownershipFeather,
            (ownership.right - 1 - outputX) / ownershipFeather,
            y / verticalFeather,
            (source.height - 1 - y) / verticalFeather,
          ))
        : Math.max(0, Math.min(
            1,
            Math.min(
              x,
              y,
              source.width - 1 - x,
              source.height - 1 - y,
            ) / Math.max(
              2,
              Math.round(Math.min(source.width, source.height) * 0.035),
            ),
          ))
      const smoothBlend = blend * blend * (3 - 2 * blend)
      alpha[outputIndex] = Math.round(
        prior * (1 - smoothBlend) + safePrediction * smoothBlend,
      )
    }
  }
}

function edgeAwareFilter(
  pixels: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
) {
  let input = alpha
  let output = new Uint8ClampedArray(alpha.length)
  const colorScale = 2 * 32 * 32
  const spatialScale = 2 * 1.35 * 1.35

  for (let pass = 0; pass < ALPHA_FILTER_PASSES; pass += 1) {
    output.set(input)
    for (let y = 0; y < height; y += 1) {
      const yStart = Math.max(0, y - ALPHA_FILTER_RADIUS)
      const yEnd = Math.min(height - 1, y + ALPHA_FILTER_RADIUS)
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x
        const centerAlpha = input[index]
        if (centerAlpha <= 2 || centerAlpha >= 253) continue

        const pixelOffset = index * 4
        const red = pixels[pixelOffset]
        const green = pixels[pixelOffset + 1]
        const blue = pixels[pixelOffset + 2]
        const xStart = Math.max(0, x - ALPHA_FILTER_RADIUS)
        const xEnd = Math.min(width - 1, x + ALPHA_FILTER_RADIUS)
        let weightedAlpha = 0
        let weightTotal = 0

        for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
          const dy = neighborY - y
          for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1) {
            const dx = neighborX - x
            const neighborIndex = neighborY * width + neighborX
            const neighborOffset = neighborIndex * 4
            const redDelta = red - pixels[neighborOffset]
            const greenDelta = green - pixels[neighborOffset + 1]
            const blueDelta = blue - pixels[neighborOffset + 2]
            const colorDistance = (
              redDelta * redDelta
              + greenDelta * greenDelta
              + blueDelta * blueDelta
            )
            const spatialDistance = dx * dx + dy * dy
            const weight = Math.exp(
              -colorDistance / colorScale - spatialDistance / spatialScale,
            )
            weightedAlpha += input[neighborIndex] * weight
            weightTotal += weight
          }
        }
        output[index] = weightedAlpha / weightTotal
      }
    }
    const swap = input
    input = output
    output = swap
  }

  if (input !== alpha) alpha.set(input)
}

function colorBucket(pixels: Uint8ClampedArray, offset: number) {
  const shift = 8 - COLOR_BUCKET_BITS
  return (
    (pixels[offset] >> shift)
    | ((pixels[offset + 1] >> shift) << COLOR_BUCKET_BITS)
    | (
      (pixels[offset + 2] >> shift)
      << (COLOR_BUCKET_BITS * 2)
    )
  )
}

function removeEnclosedBackgroundColorIslands(
  pixels: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  refinementEvidence?: Uint8Array,
) {
  // Color similarity is never enough to punch a hole through a strong
  // foreground prediction. A separate refinement crop must classify each
  // affected pixel as background, and no refinement may strongly veto it.
  if (!refinementEvidence) return

  const pixelCount = width * height
  const backgroundCounts = new Uint32Array(COLOR_BUCKET_COUNT)
  const foregroundCounts = new Uint32Array(COLOR_BUCKET_COUNT)

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4
    // Fully transparent source pixels have undefined RGB values and must not
    // teach the color model that black is the removed photo background.
    if (pixels[offset + 3] < 128) continue
    const bucket = colorBucket(pixels, offset)
    if (alpha[index] <= COLOR_ISLAND_BACKGROUND_ALPHA) {
      backgroundCounts[bucket] += 1
    } else if (alpha[index] >= COLOR_ISLAND_FOREGROUND_ALPHA) {
      foregroundCounts[bucket] += 1
    }
  }

  const minimumBucketSamples = Math.max(
    24,
    Math.round(pixelCount * 0.00001),
  )
  const candidates = new Uint8Array(pixelCount)
  const growthCandidates = new Uint8Array(pixelCount)
  for (let index = 0; index < pixelCount; index += 1) {
    if (alpha[index] < COLOR_ISLAND_SEED_ALPHA) continue
    const evidence = refinementEvidence[index]
    if (
      (evidence & CONSENSUS_BACKGROUND_MASK)
        < COLOR_ISLAND_REFINEMENT_BACKGROUND_VOTES
      || (evidence & CONSENSUS_FOREGROUND_FLAG) !== 0
    ) continue
    const offset = index * 4
    if (pixels[offset + 3] < 128) continue
    const bucket = colorBucket(pixels, offset)
    const background = backgroundCounts[bucket]
    if (background < minimumBucketSamples) continue
    const foreground = foregroundCounts[bucket]
    const backgroundRatio = (
      background / Math.max(1, background + foreground)
    )
    if (backgroundRatio >= COLOR_ISLAND_GROWTH_RATIO) {
      growthCandidates[index] = 1
    }
    if (backgroundRatio >= COLOR_ISLAND_BACKGROUND_RATIO) {
      candidates[index] = 1
    }
  }

  const minimumArea = Math.max(
    64,
    Math.round(pixelCount * COLOR_ISLAND_MIN_AREA_FRACTION),
  )
  const maximumArea = Math.max(
    minimumArea,
    Math.round(pixelCount * COLOR_ISLAND_MAX_AREA_FRACTION),
  )
  const maximumClearance = Math.max(
    12,
    Math.round(
      Math.min(width, height) * COLOR_ISLAND_MAX_CLEARANCE_FRACTION,
    ),
  )
  const islands: number[][] = []

  for (let start = 0; start < pixelCount; start += 1) {
    if (!candidates[start]) continue

    const component = [start]
    candidates[start] = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1

    for (let read = 0; read < component.length; read += 1) {
      const index = component[read]
      const x = index % width
      const y = Math.floor(index / width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)

      const xStart = Math.max(0, x - 1)
      const xEnd = Math.min(width - 1, x + 1)
      const yStart = Math.max(0, y - 1)
      const yEnd = Math.min(height - 1, y + 1)
      for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
        const row = neighborY * width
        for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1) {
          const neighbor = row + neighborX
          if (!candidates[neighbor]) continue
          candidates[neighbor] = 0
          component.push(neighbor)
        }
      }
    }

    if (component.length < minimumArea) continue
    if (component.length > maximumArea) continue

    const componentWidth = maxX - minX + 1
    const componentHeight = maxY - minY + 1
    const componentFill = (
      component.length / (componentWidth * componentHeight)
    )
    // Genuine enclosed background openings have a coherent interior. Sparse
    // chains are much more likely to be whiskers, dark fur, eyelashes, or
    // other textured subject detail that happens to match the background.
    if (componentFill < COLOR_ISLAND_MIN_FILL_RATIO) continue

    const clearance = Math.max(
      12,
      Math.min(
        maximumClearance,
        Math.ceil(
          Math.max(componentWidth, componentHeight)
          * COLOR_ISLAND_CLEARANCE_SCALE,
        ),
      ),
    )
    const searchLeft = Math.max(0, minX - clearance)
    const searchTop = Math.max(0, minY - clearance)
    const searchRight = Math.min(width - 1, maxX + clearance)
    const searchBottom = Math.min(height - 1, maxY + clearance)
    let enclosed = (
      searchLeft > 0
      && searchTop > 0
      && searchRight < width - 1
      && searchBottom < height - 1
    )

    // A true missed gap is buried inside the current silhouette. Reject
    // background-colored clothing and highlights as soon as the existing
    // transparent exterior appears within a component-scaled safety margin.
    for (
      let y = searchTop;
      enclosed && y <= searchBottom;
      y += 1
    ) {
      const row = y * width
      for (let x = searchLeft; x <= searchRight; x += 1) {
        if (alpha[row + x] <= COLOR_ISLAND_BACKGROUND_ALPHA) {
          enclosed = false
          break
        }
      }
    }
    if (!enclosed) continue

    // The strict color component is only a trustworthy seed. Grow through
    // neighboring bins that are more likely background than foreground so
    // compression noise and screen scan lines are removed without blindly
    // dilating into arms or clothing.
    const growthLeft = Math.max(0, minX - COLOR_ISLAND_GROWTH_PADDING)
    const growthTop = Math.max(0, minY - COLOR_ISLAND_GROWTH_PADDING)
    const growthRight = Math.min(
      width - 1,
      maxX + COLOR_ISLAND_GROWTH_PADDING,
    )
    const growthBottom = Math.min(
      height - 1,
      maxY + COLOR_ISLAND_GROWTH_PADDING,
    )
    const grown = [...component]
    for (const index of grown) growthCandidates[index] = 0
    const maximumGrowthArea = Math.min(
      maximumArea,
      component.length * 3,
    )
    for (
      let read = 0;
      read < grown.length && grown.length <= maximumGrowthArea;
      read += 1
    ) {
      const index = grown[read]
      const x = index % width
      const y = Math.floor(index / width)
      const xStart = Math.max(growthLeft, x - 1)
      const xEnd = Math.min(growthRight, x + 1)
      const yStart = Math.max(growthTop, y - 1)
      const yEnd = Math.min(growthBottom, y + 1)
      for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
        const row = neighborY * width
        for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1) {
          const neighbor = row + neighborX
          if (!growthCandidates[neighbor]) continue
          growthCandidates[neighbor] = 0
          grown.push(neighbor)
        }
      }
    }
    islands.push(
      grown.length <= maximumGrowthArea ? grown : component,
    )
  }

  const outerRadius = (
    COLOR_ISLAND_EXPANSION_RADIUS + COLOR_ISLAND_FEATHER_RADIUS
  )
  for (const island of islands) {
    for (const seed of island) {
      const seedX = seed % width
      const seedY = Math.floor(seed / width)
      for (let dy = -outerRadius; dy <= outerRadius; dy += 1) {
        const targetY = seedY + dy
        if (targetY < 0 || targetY >= height) continue
        for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
          const targetX = seedX + dx
          if (targetX < 0 || targetX >= width) continue
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance > outerRadius) continue
          const alphaCap = distance <= COLOR_ISLAND_EXPANSION_RADIUS
            ? 0
            : Math.round(
                (distance - COLOR_ISLAND_EXPANSION_RADIUS)
                / COLOR_ISLAND_FEATHER_RADIUS
                * 255,
              )
          const target = targetY * width + targetX
          const evidence = refinementEvidence[target]
          if (
            (evidence & CONSENSUS_BACKGROUND_MASK)
              < COLOR_ISLAND_REFINEMENT_BACKGROUND_VOTES
            || (evidence & CONSENSUS_FOREGROUND_FLAG) !== 0
          ) continue
          alpha[target] = Math.min(alpha[target], alphaCap)
        }
      }
    }
  }
}

function snapAlphaToColorEdges(
  pixels: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
) {
  const backgroundThreshold = 12
  const foregroundThreshold = 243
  const snapped = new Uint8ClampedArray(alpha)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const currentAlpha = alpha[index]
      if (
        currentAlpha <= backgroundThreshold
        || currentAlpha >= foregroundThreshold
      ) continue

      let foregroundIndex = -1
      let backgroundIndex = -1
      let foregroundDistance = Number.POSITIVE_INFINITY
      let backgroundDistance = Number.POSITIVE_INFINITY

      for (const [directionX, directionY] of COLOR_EDGE_DIRECTIONS) {
        for (let step = 1; step <= radius; step += 1) {
          const sampleX = x + directionX * step
          const sampleY = y + directionY * step
          if (
            sampleX < 0
            || sampleX >= width
            || sampleY < 0
            || sampleY >= height
          ) break

          const sampleIndex = sampleY * width + sampleX
          const sampleAlpha = alpha[sampleIndex]
          if (
            sampleAlpha > backgroundThreshold
            && sampleAlpha < foregroundThreshold
          ) continue

          const distance = step * (
            directionX !== 0 && directionY !== 0 ? Math.SQRT2 : 1
          )
          if (
            sampleAlpha >= foregroundThreshold
            && distance < foregroundDistance
          ) {
            foregroundIndex = sampleIndex
            foregroundDistance = distance
          } else if (
            sampleAlpha <= backgroundThreshold
            && distance < backgroundDistance
          ) {
            backgroundIndex = sampleIndex
            backgroundDistance = distance
          }
          break
        }
      }

      if (foregroundIndex < 0 || backgroundIndex < 0) continue

      const offset = index * 4
      const foregroundOffset = foregroundIndex * 4
      const backgroundOffset = backgroundIndex * 4
      const redDelta = (
        pixels[foregroundOffset] - pixels[backgroundOffset]
      )
      const greenDelta = (
        pixels[foregroundOffset + 1] - pixels[backgroundOffset + 1]
      )
      const blueDelta = (
        pixels[foregroundOffset + 2] - pixels[backgroundOffset + 2]
      )
      const contrast = (
        redDelta * redDelta
        + greenDelta * greenDelta
        + blueDelta * blueDelta
      )
      if (contrast < 192) continue

      const colorAlpha = Math.max(0, Math.min(1, (
        (pixels[offset] - pixels[backgroundOffset]) * redDelta
        + (pixels[offset + 1] - pixels[backgroundOffset + 1]) * greenDelta
        + (pixels[offset + 2] - pixels[backgroundOffset + 2]) * blueDelta
      ) / contrast))
      const colorContrast = Math.sqrt(contrast / 3)
      const contrastConfidence = Math.max(
        0,
        Math.min(0.82, (colorContrast - 8) / 48),
      )
      const distanceConfidence = Math.max(
        0.35,
        1 - Math.max(foregroundDistance, backgroundDistance) / (radius * 2),
      )
      const confidence = contrastConfidence * distanceConfidence
      const priorAlpha = currentAlpha / 255
      snapped[index] = Math.round((
        priorAlpha * (1 - confidence) + colorAlpha * confidence
      ) * 255)
    }
  }

  alpha.set(snapped)
}

function decontaminateEdgeColors(
  pixels: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
) {
  const backgroundIndices = new Int32Array(COLOR_EDGE_DIRECTIONS.length)
  const backgroundDistances = new Float32Array(
    COLOR_EDGE_DIRECTIONS.length,
  )
  const backgroundColor = new Float32Array(3)
  const unmixedColor = new Float32Array(3)
  const backgroundToleranceSquared = (
    DECONTAMINATION_BACKGROUND_COLOR_TOLERANCE ** 2 * 3
  )

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const currentAlpha = alpha[index]
      if (
        currentAlpha <= DECONTAMINATION_BACKGROUND_ALPHA
        || currentAlpha >= DECONTAMINATION_FOREGROUND_ALPHA
      ) continue

      backgroundIndices.fill(-1)
      let backgroundSampleCount = 0
      let nearestBackgroundIndex = -1
      let nearestBackgroundDistance = Number.POSITIVE_INFINITY
      let interiorIndex = -1
      let interiorAlpha = currentAlpha
      let interiorDistance = Number.POSITIVE_INFINITY
      for (
        let directionIndex = 0;
        directionIndex < COLOR_EDGE_DIRECTIONS.length;
        directionIndex += 1
      ) {
        const [directionX, directionY] = COLOR_EDGE_DIRECTIONS[
          directionIndex
        ]
        for (let step = 1; step <= radius; step += 1) {
          const neighborX = x + directionX * step
          const neighborY = y + directionY * step
          if (
            neighborX < 0
            || neighborX >= width
            || neighborY < 0
            || neighborY >= height
          ) break

          const neighborIndex = neighborY * width + neighborX
          const neighborAlpha = alpha[neighborIndex]
          const distance = step * (
            directionX !== 0 && directionY !== 0 ? Math.SQRT2 : 1
          )
          if (
            neighborAlpha > interiorAlpha
            || (
              neighborAlpha === interiorAlpha
              && distance < interiorDistance
            )
          ) {
            interiorAlpha = neighborAlpha
            interiorDistance = distance
            interiorIndex = neighborIndex
          }
          if (
            neighborAlpha <= DECONTAMINATION_BACKGROUND_ALPHA
          ) {
            backgroundIndices[directionIndex] = neighborIndex
            backgroundDistances[directionIndex] = distance
            backgroundSampleCount += 1
            if (distance < nearestBackgroundDistance) {
              nearestBackgroundDistance = distance
              nearestBackgroundIndex = neighborIndex
            }
            break
          }
          if (
            neighborAlpha >= DECONTAMINATION_FOREGROUND_ALPHA
          ) break
        }
      }
      if (
        interiorIndex < 0
        || interiorAlpha < currentAlpha + 12
      ) continue

      const offset = index * 4
      const interiorOffset = interiorIndex * 4
      const normalizedAlpha = currentAlpha / 255
      if (
        backgroundSampleCount === 0
        || nearestBackgroundIndex < 0
      ) {
        // No removed exterior was reachable. Keep the previous conservative
        // behavior as a fallback instead of guessing a background color.
        const fallbackStrength = Math.min(
          0.75,
          (interiorAlpha - currentAlpha) / 255
            + (1 - normalizedAlpha) * 0.25,
        )
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[offset + channel] = Math.round(
            pixels[offset + channel] * (1 - fallbackStrength)
            + pixels[interiorOffset + channel] * fallbackStrength,
          )
        }
        continue
      }

      // Average nearby exterior samples that agree with the closest one. This
      // smooths background noise without mixing colors from a different region.
      const nearestBackgroundOffset = nearestBackgroundIndex * 4
      let backgroundWeight = 0
      backgroundColor.fill(0)
      for (
        let directionIndex = 0;
        directionIndex < backgroundIndices.length;
        directionIndex += 1
      ) {
        const backgroundIndex = backgroundIndices[directionIndex]
        if (backgroundIndex < 0) continue
        const backgroundOffset = backgroundIndex * 4
        const redDelta = pixels[backgroundOffset]
          - pixels[nearestBackgroundOffset]
        const greenDelta = pixels[backgroundOffset + 1]
          - pixels[nearestBackgroundOffset + 1]
        const blueDelta = pixels[backgroundOffset + 2]
          - pixels[nearestBackgroundOffset + 2]
        if (
          redDelta * redDelta
            + greenDelta * greenDelta
            + blueDelta * blueDelta
          > backgroundToleranceSquared
        ) continue

        const weight = 1 / Math.max(
          1,
          backgroundDistances[directionIndex],
        )
        backgroundWeight += weight
        for (let channel = 0; channel < 3; channel += 1) {
          backgroundColor[channel] += (
            pixels[backgroundOffset + channel] * weight
          )
        }
      }
      if (backgroundWeight === 0) continue
      for (let channel = 0; channel < 3; channel += 1) {
        backgroundColor[channel] /= backgroundWeight
      }

      const redContrast = pixels[interiorOffset] - backgroundColor[0]
      const greenContrast = pixels[interiorOffset + 1] - backgroundColor[1]
      const blueContrast = pixels[interiorOffset + 2] - backgroundColor[2]
      const contrast = Math.sqrt((
        redContrast * redContrast
          + greenContrast * greenContrast
          + blueContrast * blueContrast
      ) / 3)
      const contrastConfidence = Math.max(
        0,
        Math.min(1, (contrast - 6) / 42),
      )
      if (contrastConfidence === 0) continue

      const solveAlpha = Math.max(
        DECONTAMINATION_MIN_SOLVE_ALPHA,
        normalizedAlpha,
      )
      let clipping = 0
      for (let channel = 0; channel < 3; channel += 1) {
        // Observed = alpha * foreground + (1 - alpha) * background.
        // Solve for the foreground color using the sampled removed exterior.
        const rawForeground = (
          pixels[offset + channel]
          - (1 - solveAlpha) * backgroundColor[channel]
        ) / solveAlpha
        const clampedForeground = Math.max(
          0,
          Math.min(255, rawForeground),
        )
        clipping += Math.abs(rawForeground - clampedForeground)
        unmixedColor[channel] = clampedForeground
      }

      const alphaReliability = Math.max(
        0,
        Math.min(
          1,
          (
            normalizedAlpha - DECONTAMINATION_MIN_SOLVE_ALPHA
          ) / 0.42,
        ),
      )
      const clippingReliability = Math.max(
        0,
        Math.min(1, 1 - clipping / (3 * 160)),
      )
      const distanceConfidence = Math.max(
        0.25,
        1 - nearestBackgroundDistance / (radius * 1.5),
      )
      const solutionWeight = (
        alphaReliability
        * clippingReliability
        * distanceConfidence
      )
      const correctionStrength = Math.min(
        0.92,
        (1 - normalizedAlpha) * 1.35,
      ) * contrastConfidence * distanceConfidence

      for (let channel = 0; channel < 3; channel += 1) {
        // When division by a small alpha or channel clipping makes the inverse
        // unstable, the existing nearest-interior color remains the fallback.
        const safeForeground = (
          unmixedColor[channel] * solutionWeight
          + pixels[interiorOffset + channel] * (1 - solutionWeight)
        )
        pixels[offset + channel] = Math.round(
          pixels[offset + channel] * (1 - correctionStrength)
          + safeForeground * correctionStrength,
        )
      }
    }
  }
}

function applyFullResolutionAlpha(
  context: OffscreenCanvasRenderingContext2D,
  imageWidth: number,
  imageHeight: number,
  layers: MaskLayer[],
) {
  const pixels = context.getImageData(0, 0, imageWidth, imageHeight)
  const data = pixels.data
  const alpha = new Uint8ClampedArray(imageWidth * imageHeight)
  const consensusLayerCount = layers.filter(
    layer => (
      layer.detail === 'person'
      && layer.ownership
    ),
  ).length
  // Pack the foreground veto flag and background vote count into one byte.
  // This saves one full-resolution allocation on large camera images.
  const consensusEvidence = consensusLayerCount >= 2
    ? new Uint8Array(alpha.length)
    : undefined
  const refinementEvidence = layers.length >= 2
    ? new Uint8Array(alpha.length)
    : undefined
  const lowestBackground = consensusLayerCount >= 2
    ? new Uint8ClampedArray(alpha.length)
    : undefined
  lowestBackground?.fill(255)

  layers.forEach((layer, index) => {
    const contributesConsensus = (
      layer.detail === 'person'
      && Boolean(layer.ownership)
    )
    rasterizeMask(
      alpha,
      imageWidth,
      layer,
      index > 0,
      contributesConsensus ? consensusEvidence : undefined,
      contributesConsensus ? lowestBackground : undefined,
      index > 0 ? refinementEvidence : undefined,
    )
  })
  if (consensusEvidence && lowestBackground) {
    for (let index = 0; index < alpha.length; index += 1) {
      const evidence = consensusEvidence[index]
      if (
        (evidence & CONSENSUS_BACKGROUND_MASK)
          >= CONSENSUS_BACKGROUND_VOTES
        && (evidence & CONSENSUS_FOREGROUND_FLAG) === 0
      ) {
        alpha[index] = Math.min(alpha[index], lowestBackground[index])
      }
    }
  }
  removeEnclosedBackgroundColorIslands(
    data,
    alpha,
    imageWidth,
    imageHeight,
    refinementEvidence,
  )
  removeDetachedFullResolutionArtifacts(
    alpha,
    imageWidth,
    imageHeight,
  )
  const maskScale = Math.max(...layers.map(layer => Math.max(
    layer.source.width / layer.mask.width,
    layer.source.height / layer.mask.height,
  )))
  edgeAwareFilter(data, alpha, imageWidth, imageHeight)
  const colorEdgeRadius = Math.max(
    4,
    Math.min(MAX_COLOR_EDGE_RADIUS, Math.ceil(maskScale * 1.75)),
  )
  snapAlphaToColorEdges(
    data,
    alpha,
    imageWidth,
    imageHeight,
    colorEdgeRadius,
  )
  const decontaminationRadius = Math.max(
    6,
    Math.min(
      MAX_DECONTAMINATION_RADIUS,
      Math.ceil(maskScale),
    ),
  )
  // Clean color spill while the edge is still a soft matte. Once polishAlpha
  // hardens that transition, contaminated pixels may become fully opaque and
  // are no longer distinguishable from true subject color.
  decontaminateEdgeColors(
    data,
    alpha,
    imageWidth,
    imageHeight,
    decontaminationRadius,
  )

  // Tight head and boundary crops carry substantially more strand information
  // than the broad subject pass. Keep their partial alpha instead of applying
  // the aggressive curve used for ordinary object contours.
  const fineDetailZones = layers
    .filter(
      layer => layer.detail === 'hair' || layer.detail === 'edge',
    )
    .map(layer => ({
      left:layer.source.left,
      top:layer.source.top,
      right:layer.source.left + layer.source.width,
      bottom:Math.min(
        imageHeight,
        Math.ceil(
          layer.source.top
          + layer.source.height * (
            layer.detail === 'hair'
              ? HAIR_DETAIL_ZONE_FRACTION
              : 1
          ),
        ),
      ),
    }))

  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * 4
    const currentAlpha = alpha[index]
    let preserveFineDetail = false
    if (
      currentAlpha > 0
      && currentAlpha < 255
      && fineDetailZones.length > 0
    ) {
      const x = index % imageWidth
      const y = Math.floor(index / imageWidth)
      preserveFineDetail = fineDetailZones.some(
        zone => (
          x >= zone.left
          && x < zone.right
          && y >= zone.top
          && y < zone.bottom
        ),
      )
    }
    alpha[index] = polishAlpha(currentAlpha, preserveFineDetail)
    alpha[index] = Math.round(alpha[index] * data[offset + 3] / 255)
  }

  for (let index = 0; index < alpha.length; index += 1) {
    data[index * 4 + 3] = alpha[index]
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
    const baseMask = await inferMask(
      engine,
      createInferenceCanvas(bitmap, wholeImage),
    )
    const layers: MaskLayer[] = [{ mask:baseMask, source:wholeImage }]
    const personLayers = findPersonRefinementLayers(
      baseMask,
      bitmap.width,
      bitmap.height,
    )
    const structuralLayers = personLayers.length >= 2
      ? personLayers
      : findRefinementRects(
          baseMask,
          bitmap.width,
          bitmap.height,
        ).map(source => ({ source, detail:'person' as const }))
    const edgeLayers = findEdgeRefinementLayers(
      baseMask,
      bitmap.width,
      bitmap.height,
    ).filter(candidate => !structuralLayers.some(existing => {
      const existingArea = existing.source.width * existing.source.height
      const candidateArea = candidate.source.width * candidate.source.height
      const areaRatio = Math.min(existingArea, candidateArea)
        / Math.max(existingArea, candidateArea)
      return (
        areaRatio >= REFINEMENT_DUPLICATE_AREA_RATIO
        && rectOverlap(existing.source, candidate.source)
          >= REFINEMENT_DUPLICATE_OVERLAP
      )
    }))
    const structuralBudget = Math.max(
      0,
      MAX_TOTAL_REFINEMENT_PASSES - edgeLayers.length,
    )
    const refinementLayers = [
      ...structuralLayers.slice(0, structuralBudget),
      ...edgeLayers,
    ]
    for (let index = 0; index < refinementLayers.length; index += 1) {
      const refinementLayer = refinementLayers[index]
      const stage = refinementLayer.detail === 'hair'
        ? 'Refining hair and upper-body gaps'
        : refinementLayer.detail === 'edge'
          ? 'Refining high-quality hair and fur edges'
          : `Refining subject ${index + 1} of ${refinementLayers.length}`
      report(
        data.id,
        0.68 + (index / refinementLayers.length) * 0.16,
        stage,
      )
      const inferredMask = await inferMask(
        engine,
        createInferenceCanvas(bitmap, refinementLayer.source),
      )
      const refinedMask = refinementLayer.detail === 'hair'
        ? expandEnclosedBackgroundPockets(inferredMask)
        : inferredMask
      layers.push({ mask:refinedMask, ...refinementLayer })
    }

    report(data.id, 0.86, 'Snapping the matte to full-resolution edges')
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
      layers,
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
