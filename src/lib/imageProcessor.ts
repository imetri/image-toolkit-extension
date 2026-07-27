import type { ImageItem, ProcessOptions, ProcessedItem, ProcessProgress } from '../types'
import { extensionFor, newId, outputMime } from './utils'
import { isRawImage } from './imageFormats'
import { processRawImage } from './rawDecoder'

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

const processInWorker = (item: ImageItem, options: ProcessOptions, signal?: AbortSignal, onProgress?: (update: ProcessProgress) => void) => new Promise<ProcessedItem>((resolve, reject) => {
  const worker = new Worker(new URL('../workers/image.worker.ts', import.meta.url), { type:'module' })
  const cleanup = () => signal?.removeEventListener('abort', cancel)
  const cancel = () => { worker.terminate(); cleanup(); reject(abortError()) }
  if (signal?.aborted) return cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      onProgress?.({ progress:data.progress, stage:data.stage })
      return
    }
    worker.terminate()
    cleanup()
    data.error ? reject(new Error(data.error)) : resolve({ ...data, preview:URL.createObjectURL(data.blob) })
  }
  worker.onerror = error => { worker.terminate(); cleanup(); reject(error) }
  worker.postMessage({ item:{ id:item.id, file:item.file }, options })
})

function encodingQuality(options: ProcessOptions, mime: string) {
  if (mime === 'image/png') return undefined
  return options.operation === 'compress' ? options.quality / 100 : 1
}

export async function processImage(item: ImageItem, options: ProcessOptions, signal?: AbortSignal, onProgress?: (update: ProcessProgress) => void): Promise<ProcessedItem> {
  if (signal?.aborted) throw abortError()
  const raw = isRawImage(item.file)
  const requestedMime = raw && options.format === 'original'
    ? 'image/jpeg'
    : outputMime(options.format, item.file.type)
  const originalMime = item.file.type === 'image/jpg' ? 'image/jpeg' : item.file.type
  if (raw) {
    const processed = await processRawImage(item.file, options, signal, onProgress)
    const blob = processed.blob
    const base = item.file.name.replace(/\.[^/.]+$/, '')
    return {
      id:newId(),
      sourceName:item.file.name,
      name:`${base}.${extensionFor(blob.type || requestedMime)}`,
      blob,
      preview:URL.createObjectURL(blob),
      originalSize:item.file.size,
      outputSize:blob.size,
      width:processed.width,
      height:processed.height,
      bitDepth:processed.bitDepth,
      status:'done',
    }
  }
  if (!raw && options.operation === 'convert' && originalMime === requestedMime) {
    onProgress?.({ progress:1, stage:'Already in the requested format' })
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
    try { return await processInWorker(item, options, signal, onProgress) } catch (error) {
      if (signal?.aborted) throw error
      /* Some browsers cannot encode every requested format off-thread. */
    }
  }
  onProgress?.({ progress:0.08, stage:'Reading image' })
  const image = await decode(item.file, signal)
  onProgress?.({ progress:0.35, stage:'Preparing image' })
  if (signal?.aborted) throw abortError()
  const scale = options.operation === 'resize' ? (options.percentage ? options.percentage / 100 : Math.min(options.width ? options.width / image.width : 1, options.height ? options.height / image.height : 1)) : 1
  const width = Math.max(1, Math.round(options.keepAspect ? image.width * scale : (options.width || image.width * scale)))
  const height = Math.max(1, Math.round(options.keepAspect ? image.height * scale : (options.height || image.height * scale)))
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  canvas.getContext('2d', { alpha:requestedMime !== 'image/jpeg' })!.drawImage(image, 0, 0, width, height)
  onProgress?.({ progress:0.65, stage:'Encoding output image' })
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to encode image')), requestedMime, encodingQuality(options, requestedMime)))
  if (image instanceof HTMLImageElement) URL.revokeObjectURL(image.src)
  const mime = blob.type || requestedMime
  const base = item.file.name.replace(/\.[^/.]+$/, '')
  const name = `${base}.${extensionFor(mime)}`
  onProgress?.({ progress:1, stage:'Complete' })
  return { id:newId(), sourceName:item.file.name, name, blob, preview:URL.createObjectURL(blob), originalSize:item.file.size, outputSize:blob.size, width, height, status:'done' }
}
