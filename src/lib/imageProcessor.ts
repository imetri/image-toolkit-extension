import type { ImageItem, ProcessOptions, ProcessedItem } from '../types'
import { extensionFor, newId, outputMime } from './utils'
import { extractRawPreview, isRawImage } from './imageFormats'
import { decodeRawImage } from './rawDecoder'

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')

const decode = (file: Blob, signal?: AbortSignal) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  const url = URL.createObjectURL(file)
  const cleanup = () => signal?.removeEventListener('abort', cancel)
  const cancel = () => {
    image.src = ''
    URL.revokeObjectURL(url)
    cleanup()
    reject(abortError())
  }
  if (signal?.aborted) return cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  image.onload = () => { cleanup(); resolve(image) }
  image.onerror = error => { URL.revokeObjectURL(url); cleanup(); reject(error) }
  image.src = url
})

const processInWorker = (item: ImageItem, options: ProcessOptions, signal?: AbortSignal) => new Promise<ProcessedItem>((resolve, reject) => {
  const worker = new Worker(new URL('../workers/image.worker.ts', import.meta.url), { type:'module' })
  const cleanup = () => signal?.removeEventListener('abort', cancel)
  const cancel = () => { worker.terminate(); cleanup(); reject(abortError()) }
  if (signal?.aborted) return cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  worker.onmessage = ({ data }) => { worker.terminate(); cleanup(); data.error ? reject(new Error(data.error)) : resolve({ ...data, preview:URL.createObjectURL(data.blob) }) }
  worker.onerror = error => { worker.terminate(); cleanup(); reject(error) }
  worker.postMessage({ item:{ id:item.id, file:item.file }, options })
})

function encodingQuality(options: ProcessOptions, mime: string) {
  if (mime === 'image/png') return undefined
  return options.operation === 'compress' ? options.quality / 100 : 1
}

function rawPixelsToCanvas(
  image: Awaited<ReturnType<typeof decodeRawImage>>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw abortError()
  const pixelCount = image.width * image.height
  if (image.colors < 1 || image.data.length < pixelCount * image.colors) {
    throw new Error('The RAW decoder returned incomplete pixel data.')
  }

  const rgba = new Uint8ClampedArray(pixelCount * 4)
  const max = image.bits > 8 ? 65535 : 255
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if ((pixel & 0x3ffff) === 0 && signal?.aborted) throw abortError()
    const source = pixel * image.colors
    const target = pixel * 4
    const red = image.data[source]
    const green = image.data[source + Math.min(1, image.colors - 1)]
    const blue = image.data[source + Math.min(2, image.colors - 1)]
    rgba[target] = Math.round(red * 255 / max)
    rgba[target + 1] = Math.round(green * 255 / max)
    rgba[target + 2] = Math.round(blue * 255 / max)
    rgba[target + 3] = 255
  }

  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d', { alpha:false })!.putImageData(new ImageData(rgba, image.width, image.height), 0, 0)
  return canvas
}

async function decodeRawSource(file: File, signal?: AbortSignal) {
  try {
    const fullImage = await decodeRawImage(file, signal)
    return { image:rawPixelsToCanvas(fullImage, signal) }
  } catch (error) {
    if (signal?.aborted) throw error
    const preview = await extractRawPreview(file, signal)
    return {
      image:await decode(preview, signal),
      warning:'Embedded preview used; this RAW variant could not be fully decoded.',
    }
  }
}

export async function processImage(item: ImageItem, options: ProcessOptions, signal?: AbortSignal): Promise<ProcessedItem> {
  if (signal?.aborted) throw abortError()
  const raw = isRawImage(item.file)
  const requestedMime = raw && options.format === 'original'
    ? 'image/jpeg'
    : outputMime(options.format, item.file.type)
  const originalMime = item.file.type === 'image/jpg' ? 'image/jpeg' : item.file.type
  if (!raw && options.operation === 'convert' && originalMime === requestedMime) {
    const blob = item.file.slice(0, item.file.size, requestedMime)
    return {
      id:newId(),
      sourceName:item.file.name,
      name:item.file.name,
      blob,
      preview:URL.createObjectURL(blob),
      originalSize:item.file.size,
      outputSize:blob.size,
      status:'done',
    }
  }
  if (!raw && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
    try { return await processInWorker(item, options, signal) } catch (error) {
      if (signal?.aborted) throw error
      /* Some browsers cannot encode every requested format off-thread. */
    }
  }
  const rawSource = raw ? await decodeRawSource(item.file, signal) : undefined
  const image = rawSource?.image ?? await decode(item.file, signal)
  if (signal?.aborted) throw abortError()
  const scale = options.operation === 'resize' ? (options.percentage ? options.percentage / 100 : Math.min(options.width ? options.width / image.width : 1, options.height ? options.height / image.height : 1)) : 1
  const width = Math.max(1, Math.round(options.keepAspect ? image.width * scale : (options.width || image.width * scale)))
  const height = Math.max(1, Math.round(options.keepAspect ? image.height * scale : (options.height || image.height * scale)))
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  canvas.getContext('2d', { alpha:requestedMime !== 'image/jpeg' })!.drawImage(image, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to encode image')), requestedMime, encodingQuality(options, requestedMime)))
  if (image instanceof HTMLImageElement) URL.revokeObjectURL(image.src)
  const mime = blob.type || requestedMime
  const base = item.file.name.replace(/\.[^/.]+$/, '')
  const name = `${base}.${extensionFor(mime)}`
  return { id:newId(), sourceName:item.file.name, name, blob, preview:URL.createObjectURL(blob), originalSize:item.file.size, outputSize:blob.size, width, height, warning:rawSource?.warning, status:'done' }
}
