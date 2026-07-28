import { extensionFor, outputMime, newId } from '../lib/utils'
import type { ImageItem, ProcessOptions, ProcessedItem } from '../types'

type WorkerRequest = { item: Pick<ImageItem, 'id'|'file'>; options: ProcessOptions }
const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const { item, options } = data
    workerScope.postMessage({ type:'progress', progress:0.08, stage:'Reading image' })
    const bitmap = await createImageBitmap(item.file)
    workerScope.postMessage({ type:'progress', progress:0.35, stage:'Preparing image' })
    const scale = options.operation === 'resize' ? (options.percentage ? options.percentage / 100 : Math.min(options.width ? options.width / bitmap.width : 1, options.height ? options.height / bitmap.height : 1)) : 1
    const width = Math.max(1, Math.round(options.keepAspect ? bitmap.width * scale : (options.width || bitmap.width * scale)))
    const height = Math.max(1, Math.round(options.keepAspect ? bitmap.height * scale : (options.height || bitmap.height * scale)))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    workerScope.postMessage({ type:'progress', progress:0.65, stage:'Encoding output image' })
    const mime = outputMime(options.format, item.file.type)
    const quality = options.operation === 'compress' ? options.quality / 100 : 1
    const blob = await canvas.convertToBlob(mime === 'image/png' ? { type:mime } : { type:mime, quality })
    workerScope.postMessage({ type:'progress', progress:0.98, stage:'Finishing output' })
    const base = item.file.name.replace(/\.[^/.]+$/, '')
    const result: Omit<ProcessedItem, 'preview'> = { id:newId(), sourceName:item.file.name, name:`${base}.${extensionFor(blob.type || mime)}`, blob, originalSize:item.file.size, outputSize:blob.size, width, height, status:'done' }
    workerScope.postMessage(result)
    bitmap.close()
  } catch (error) { workerScope.postMessage({ error: error instanceof Error ? error.message : 'Unable to process image' }) }
}
