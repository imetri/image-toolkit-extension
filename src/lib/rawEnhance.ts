import type { DecodedRawImage } from './rawDecoder'

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')
const yieldToBrowser = () => new Promise<void>(resolve => globalThis.setTimeout(resolve, 0))

/**
 * Applies restrained capture sharpening to developed 16-bit RAW pixels.
 * A threshold keeps fine sensor noise from being sharpened along with edges.
 * Processing is row-buffered so a full-resolution image does not need another
 * frame-sized working allocation.
 */
export async function applyRawCaptureSharpening(
  image: DecodedRawImage,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
) {
  if (!(image.data instanceof Uint16Array) || image.bits !== 16 || image.colors < 3) return image
  if (image.width < 3 || image.height < 3) return image

  const { width, height, colors, data } = image
  const rowLength = width * colors
  let above = data.slice(0, rowLength)
  let center = data.slice(0, rowLength)
  let below = data.slice(rowLength, rowLength * 2)

  for (let y = 0; y < height; y += 1) {
    if ((y & 31) === 0 && signal?.aborted) throw abortError()
    if (y > 0 && (y & 63) === 0) {
      onProgress?.(y / height)
      await yieldToBrowser()
    }
    const outputRow = y * rowLength

    for (let x = 0; x < width; x += 1) {
      const pixel = x * colors
      const leftPixel = Math.max(0, x - 1) * colors
      const rightPixel = Math.min(width - 1, x + 1) * colors

      for (let channel = 0; channel < 3; channel += 1) {
        const value = center[pixel + channel]
        const blurred = (
          value * 4 +
          center[leftPixel + channel] +
          center[rightPixel + channel] +
          above[pixel + channel] +
          below[pixel + channel]
        ) / 8
        const detail = value - blurred

        // Roughly 0.4% of the 16-bit range: enough to avoid emphasizing
        // low-level grain while restoring edge acuity lost during demosaicing.
        const sharpened = Math.abs(detail) < 256 ? value : value + detail * 0.42
        data[outputRow + pixel + channel] = Math.max(0, Math.min(65535, Math.round(sharpened)))
      }

      // Preserve any additional channels untouched.
      for (let channel = 3; channel < colors; channel += 1) {
        data[outputRow + pixel + channel] = center[pixel + channel]
      }
    }

    const reusableRow = above
    above = center
    center = below
    const nextRow = Math.min(height - 1, y + 2)
    below = reusableRow
    below.set(data.subarray(nextRow * rowLength, (nextRow + 1) * rowLength))
  }

  onProgress?.(1)
  return image
}
