import type { DecodedRawImage } from './rawDecoder'

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const textEncoder = new TextEncoder()

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')

function writeUint32(target: Uint8Array, offset: number, value: number) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength)
  view.setUint32(offset, value >>> 0, false)
}

function crc32(type: Uint8Array, data: Uint8Array) {
  let crc = 0xffffffff
  for (const bytes of [type, data]) {
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function uint32Bytes(value: number) {
  const output = new Uint8Array(4)
  writeUint32(output, 0, value)
  return output
}

function chunkParts(name: string, data = new Uint8Array()) {
  const type = textEncoder.encode(name)
  return [
    uint32Bytes(data.length),
    type,
    data,
    uint32Bytes(crc32(type, data)),
  ]
}

function paeth(left: number, above: number, upperLeft: number) {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  return aboveDistance <= upperLeftDistance ? above : upperLeft
}

async function deflateRows(
  image: DecodedRawImage,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser cannot create a lossless 16-bit PNG.')
  }

  const compression = new CompressionStream('deflate')
  const writer = compression.writable.getWriter()
  const compressedParts: Uint8Array[] = []
  const readCompressed = (async () => {
    const reader = compression.readable.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      compressedParts.push(value)
    }
  })()

  const bytesPerPixel = 6
  const rowLength = image.width * bytesPerPixel
  let previous = new Uint8Array(rowLength)

  try {
    for (let y = 0; y < image.height; y += 1) {
      if (signal?.aborted) throw abortError()
      const current = new Uint8Array(rowLength)
      const sourceRow = y * image.width * image.colors

      for (let x = 0; x < image.width; x += 1) {
        const source = sourceRow + x * image.colors
        const target = x * bytesPerPixel
        for (let channel = 0; channel < 3; channel += 1) {
          const sample = image.data[source + Math.min(channel, image.colors - 1)]
          current[target + channel * 2] = sample >>> 8
          current[target + channel * 2 + 1] = sample & 0xff
        }
      }

      // Paeth filtering changes only compression efficiency, never pixel values.
      const filtered = new Uint8Array(rowLength + 1)
      filtered[0] = 4
      for (let index = 0; index < rowLength; index += 1) {
        const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0
        const above = previous[index]
        const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0
        filtered[index + 1] = current[index] - paeth(left, above, upperLeft)
      }
      await writer.write(filtered)
      previous = current
      if ((y & 31) === 0) onProgress?.(y / image.height)
    }
    await writer.close()
    await readCompressed
    return compressedParts
  } catch (error) {
    await writer.abort(error).catch(() => undefined)
    throw error
  }
}

export async function encodeRawPng16(
  image: DecodedRawImage,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
) {
  if (signal?.aborted) throw abortError()
  if (image.bits !== 16 || !(image.data instanceof Uint16Array)) {
    throw new Error(`Expected 16-bit RAW pixels, but the decoder returned ${image.bits}-bit data.`)
  }
  if (image.colors < 3 || image.data.length < image.width * image.height * image.colors) {
    throw new Error('The RAW decoder returned incomplete RGB pixel data.')
  }

  const header = new Uint8Array(13)
  writeUint32(header, 0, image.width)
  writeUint32(header, 4, image.height)
  header[8] = 16 // bit depth
  header[9] = 2 // truecolour RGB
  header[10] = 0 // DEFLATE compression
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  const compressedParts = await deflateRows(image, signal, onProgress)
  const pngParts = [
    PNG_SIGNATURE,
    ...chunkParts('IHDR', header),
    ...compressedParts.flatMap(part => chunkParts('IDAT', part)),
    ...chunkParts('IEND'),
  ]
  const blob = new Blob(
    pngParts,
    { type:'image/png' },
  )
  onProgress?.(1)
  return blob
}
