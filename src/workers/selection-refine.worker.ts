type RefinePoint = {
  x: number;
  y: number;
  radius: number;
};

type RefineRequest = {
  type: "refine-selection";
  id: string;
  mask: ArrayBuffer;
  visiblePixels: ArrayBuffer;
  width: number;
  height: number;
  points: RefinePoint[];
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const MASK_THRESHOLD = 128;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function refineSelection({
  mask,
  visiblePixels,
  width,
  height,
  points,
}: RefineRequest) {
  const pixelCount = width * height;
  const maskValues = new Uint8ClampedArray(mask);
  const visible = new Uint8ClampedArray(visiblePixels);
  if (
    maskValues.length !== pixelCount
    || visible.length !== pixelCount * 4
  ) {
    throw new Error("The AI selection refinement received invalid pixels.");
  }

  const selected = new Uint8Array(pixelCount);
  const painted = new Uint8Array(pixelCount);
  const additions = new Uint8Array(pixelCount);
  const isVisible = (index: number) => visible[index * 4 + 3] > 4;

  for (let index = 0; index < pixelCount; index += 1) {
    if (maskValues[index] >= MASK_THRESHOLD && isVisible(index)) {
      selected[index] = 1;
    }
  }

  let maximumPaintRadius = 1;
  for (const point of points) {
    maximumPaintRadius = Math.max(maximumPaintRadius, point.radius);
    const coreRadius = Math.max(1.5, point.radius * 0.32);
    const radiusSquared = coreRadius * coreRadius;
    const left = Math.max(0, Math.floor(point.x - coreRadius));
    const top = Math.max(0, Math.floor(point.y - coreRadius));
    const right = Math.min(width - 1, Math.ceil(point.x + coreRadius));
    const bottom = Math.min(height - 1, Math.ceil(point.y + coreRadius));
    for (let y = top; y <= bottom; y += 1) {
      const dy = y + 0.5 - point.y;
      for (let x = left; x <= right; x += 1) {
        const dx = x + 0.5 - point.x;
        if (dx * dx + dy * dy > radiusSquared) continue;
        const index = y * width + x;
        if (isVisible(index)) painted[index] = 1;
      }
    }
  }

  // Repair short mask breaks only where recognized pixels exist on opposing
  // sides of the painted centerline.
  const bridgeDistance = clamp(
    Math.round(maximumPaintRadius * 0.72),
    2,
    8,
  );
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!painted[index] || selected[index] || !isVisible(index)) continue;
      let directions = 0;
      for (
        let offsetY = -bridgeDistance;
        offsetY <= bridgeDistance;
        offsetY += 1
      ) {
        const neighborY = y + offsetY;
        if (neighborY < 0 || neighborY >= height) continue;
        for (
          let offsetX = -bridgeDistance;
          offsetX <= bridgeDistance;
          offsetX += 1
        ) {
          if (!offsetX && !offsetY) continue;
          if (
            offsetX * offsetX + offsetY * offsetY
              > bridgeDistance * bridgeDistance
          ) continue;
          const neighborX = x + offsetX;
          if (neighborX < 0 || neighborX >= width) continue;
          if (!selected[neighborY * width + neighborX]) continue;
          const absoluteX = Math.abs(offsetX);
          const absoluteY = Math.abs(offsetY);
          let direction: number;
          if (absoluteY * 2 < absoluteX) {
            direction = offsetX > 0 ? 0 : 4;
          } else if (absoluteX * 2 < absoluteY) {
            direction = offsetY > 0 ? 2 : 6;
          } else if (offsetX > 0) {
            direction = offsetY > 0 ? 1 : 7;
          } else {
            direction = offsetY > 0 ? 3 : 5;
          }
          directions |= 1 << direction;
        }
      }
      if (
        ((directions & (1 << 0)) && (directions & (1 << 4)))
        || ((directions & (1 << 1)) && (directions & (1 << 5)))
        || ((directions & (1 << 2)) && (directions & (1 << 6)))
        || ((directions & (1 << 3)) && (directions & (1 << 7)))
      ) additions[index] = 1;
    }
  }
  for (let index = 0; index < pixelCount; index += 1) {
    if (additions[index]) selected[index] = 1;
  }

  // Close isolated one-pixel pinholes at analysis resolution.
  for (let pass = 0; pass < 2; pass += 1) {
    additions.fill(0);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (selected[index] || !isVisible(index)) continue;
        let neighbors = 0;
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (!offsetX && !offsetY) continue;
            if (selected[index + offsetY * width + offsetX]) neighbors += 1;
          }
        }
        if (neighbors >= 5) additions[index] = 1;
      }
    }
    for (let index = 0; index < pixelCount; index += 1) {
      if (additions[index]) selected[index] = 1;
    }
  }

  // Keep only connected mask islands reached by the painted prompt.
  const visited = new Uint8Array(pixelCount);
  const refined = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let retainedCount = 0;
  for (let start = 0; start < pixelCount; start += 1) {
    if (!selected[start] || visited[start]) continue;
    let read = 0;
    let write = 1;
    let containsPaint = Boolean(painted[start]);
    queue[0] = start;
    visited[start] = 1;
    while (read < write) {
      const index = queue[read];
      read += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const neighborY = y + offsetY;
        if (neighborY < 0 || neighborY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (!offsetX && !offsetY) continue;
          const neighborX = x + offsetX;
          if (neighborX < 0 || neighborX >= width) continue;
          const neighborIndex = neighborY * width + neighborX;
          if (!selected[neighborIndex] || visited[neighborIndex]) continue;
          visited[neighborIndex] = 1;
          if (painted[neighborIndex]) containsPaint = true;
          queue[write] = neighborIndex;
          write += 1;
        }
      }
    }
    if (!containsPaint) continue;
    for (let index = 0; index < write; index += 1) {
      refined[queue[index]] = 1;
    }
    retainedCount += write;
  }

  // If the prompt landed in a tiny model gap, preserve the model output
  // instead of returning an empty highlight.
  const outputSelection = retainedCount ? refined : selected;
  const output = new Uint8ClampedArray(pixelCount * 4);
  let selectedPixelCount = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (!outputSelection[index]) continue;
    const offset = index * 4;
    output[offset] = 83;
    output[offset + 1] = 218;
    output[offset + 2] = 190;
    output[offset + 3] = 255;
    selectedPixelCount += 1;
  }
  return { output, selectedPixelCount };
}

workerScope.onmessage = ({ data }: MessageEvent<RefineRequest>) => {
  try {
    const { output, selectedPixelCount } = refineSelection(data);
    const pixels = output.buffer as ArrayBuffer;
    workerScope.postMessage({
      type: "refined-selection",
      id: data.id,
      pixels,
      selectedPixelCount,
      width: data.width,
      height: data.height,
    }, [pixels]);
  } catch (reason) {
    workerScope.postMessage({
      type: "error",
      id: data.id,
      error: reason instanceof Error
        ? reason.message
        : "Unable to refine the AI highlight.",
    });
  }
};
