import type { ImageItem, ProcessOptions, ProcessedItem } from '../types'
import { extensionFor, newId, outputMime } from './utils'

const decode = (file: File) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = URL.createObjectURL(file) })

const processInWorker = (item: ImageItem, options: ProcessOptions) => new Promise<ProcessedItem>((resolve, reject) => {
  const worker = new Worker(new URL('../workers/image.worker.ts', import.meta.url), { type:'module' })
  worker.onmessage = ({ data }) => { worker.terminate(); data.error ? reject(new Error(data.error)) : resolve({ ...data, preview:URL.createObjectURL(data.blob) }) }
  worker.onerror = error => { worker.terminate(); reject(error) }
  worker.postMessage({ item:{ id:item.id, file:item.file }, options })
})

export async function processImage(item: ImageItem, options: ProcessOptions): Promise<ProcessedItem> {
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
    try { return await processInWorker(item, options) } catch { /* Some browsers cannot encode every requested format off-thread. */ }
  }
  const image = await decode(item.file)
  const scale = options.operation === 'resize' ? (options.percentage ? options.percentage / 100 : Math.min(options.width ? options.width / image.width : 1, options.height ? options.height / image.height : 1)) : 1
  const width = Math.max(1, Math.round(options.keepAspect ? image.width * scale : (options.width || image.width * scale)))
  const height = Math.max(1, Math.round(options.keepAspect ? image.height * scale : (options.height || image.height * scale)))
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height)
  const mime = outputMime(options.format, item.file.type)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to encode image')), mime, options.quality / 100))
  URL.revokeObjectURL(image.src)
  const base = item.file.name.replace(/\.[^/.]+$/, '')
  const name = `${base}.${extensionFor(mime)}`
  return { id:newId(), sourceName:item.file.name, name, blob, preview:URL.createObjectURL(blob), originalSize:item.file.size, outputSize:blob.size, status:'done' }
}
