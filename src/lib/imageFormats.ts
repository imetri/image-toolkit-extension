const RAW_EXTENSIONS = new Set([
  '3fr', 'ari', 'arw', 'bay', 'cap', 'cr2', 'cr3', 'crw', 'dcr', 'dcs',
  'dng', 'drf', 'eip', 'erf', 'fff', 'gpr', 'iiq', 'k25', 'kdc', 'mdc',
  'mef', 'mos', 'mrw', 'nef', 'nrw', 'obm', 'orf', 'pef', 'ptx', 'pxn',
  'r3d', 'raf', 'raw', 'rwl', 'rw2', 'rwz', 'sr2', 'srf', 'srw', 'x3f',
])

export const RAW_FILE_ACCEPT = [...RAW_EXTENSIONS].map(extension => `.${extension}`).join(',')
export const IMAGE_FILE_ACCEPT = `image/*,${RAW_FILE_ACCEPT}`

const extensionOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

export function isRawImage(file: Pick<File, 'name' | 'type'>) {
  return RAW_EXTENSIONS.has(extensionOf(file.name)) ||
    /(?:camera-raw|x-(?:adobe-dng|canon-cr2|canon-cr3|fuji-raf|nikon-nef|olympus-orf|panasonic-rw2|pentax-pef|sony-arw))/i.test(file.type)
}

export function isImageFile(file: Pick<File, 'name' | 'type'>) {
  return file.type.startsWith('image/') || isRawImage(file)
}

export const rawPlaceholder = (fileName: string) => {
  const extension = extensionOf(fileName).toUpperCase().slice(0, 4) || 'RAW'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="100%" height="100%" rx="12" fill="#292631"/><path d="M28 82l25-28 17 18 13-15 25 25" fill="none" stroke="#9f86ff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="93" cy="35" r="9" fill="#6ee7b7"/><text x="80" y="108" fill="#ddd5ff" font-family="system-ui,sans-serif" font-size="15" font-weight="700" text-anchor="middle">${extension}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')

type JpegCandidate = { start: number; end: number; width: number; height: number }

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function inspectJpeg(bytes: Uint8Array, start: number): JpegCandidate | undefined {
  let cursor = start + 2
  let width = 0
  let height = 0

  while (cursor + 9 < bytes.length) {
    if (bytes[cursor] !== 0xff) { cursor += 1; continue }
    while (bytes[cursor] === 0xff) cursor += 1
    const marker = bytes[cursor]
    if (marker === 0xd9) break
    if (marker === 0xda) {
      for (let end = cursor + 1; end + 1 < bytes.length; end += 1) {
        if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) {
          return width > 0 && height > 0 ? { start, end:end + 2, width, height } : undefined
        }
      }
      return undefined
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      cursor += 1
      continue
    }

    const lengthOffset = cursor + 1
    const segmentLength = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1]
    if (segmentLength < 2 || lengthOffset + segmentLength > bytes.length) return undefined
    if (SOF_MARKERS.has(marker)) {
      height = (bytes[lengthOffset + 3] << 8) | bytes[lengthOffset + 4]
      width = (bytes[lengthOffset + 5] << 8) | bytes[lengthOffset + 6]
    }
    cursor = lengthOffset + segmentLength
  }
  return undefined
}

export async function extractRawPreview(file: File, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw abortError()
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (signal?.aborted) throw abortError()
  let best: JpegCandidate | undefined

  for (let offset = 0; offset + 3 < bytes.length; offset += 1) {
    if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0xd8 || bytes[offset + 2] !== 0xff) continue
    const candidate = inspectJpeg(bytes, offset)
    if (!candidate) continue
    const candidateSize = candidate.end - candidate.start
    const bestSize = best ? best.end - best.start : 0
    const candidatePixels = candidate.width * candidate.height
    const bestPixels = best ? best.width * best.height : 0
    if (candidateSize > bestSize || (candidateSize === bestSize && candidatePixels > bestPixels)) {
      best = candidate
    }
    offset = Math.max(offset, candidate.end - 1)
  }

  if (signal?.aborted) throw abortError()
  if (!best) throw new Error(`${file.name} does not contain a JPEG rendition that this extension can convert.`)
  return file.slice(best.start, best.end, 'image/jpeg')
}
