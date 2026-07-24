import { extensionFor, outputMime, newId } from '../lib/utils'
import type { ImageItem, ProcessOptions, ProcessedItem } from '../types'

type WorkerRequest = { item: Pick<ImageItem, 'id'|'file'>; options: ProcessOptions }
const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const { item, options } = data
    const bitmap = await createImageBitmap(item.file)
    const scale = options.operation === 'resize' ? (options.percentage ? options.percentage / 100 : Math.min(options.width ? options.width / bitmap.width : 1, options.height ? options.height / bitmap.height : 1)) : 1
    const width = Math.max(1, Math.round(options.keepAspect ? bitmap.width * scale : (options.width || bitmap.width * scale)))
    const height = Math.max(1, Math.round(options.keepAspect ? bitmap.height * scale : (options.height || bitmap.height * scale)))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    const mime = outputMime(options.format, item.file.type)
    const blob = await canvas.convertToBlob({ type:mime, quality:options.quality / 100 })
    const base = item.file.name.replace(/\.[^/.]+$/, '')
    const result: Omit<ProcessedItem, 'preview'> = { id:newId(), sourceName:item.file.name, name:`${base}.${extensionFor(mime)}`, blob, originalSize:item.file.size, outputSize:blob.size, status:'done' }
    workerScope.postMessage(result)
    bitmap.close()
  } catch (error) { workerScope.postMessage({ error: error instanceof Error ? error.message : 'Unable to process image' }) }
}
