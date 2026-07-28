import type { ProcessProgress } from '../types'

type BackgroundResult = {
  blob: Blob
  width: number
  height: number
}

type WorkerMessage =
  | ({ type:'progress'; id:string } & ProcessProgress)
  | ({ type:'result'; id:string } & BackgroundResult)
  | { type:'error'; id:string; error:string }

type PendingRequest = {
  resolve: (result: BackgroundResult) => void
  reject: (error: Error) => void
  onProgress?: (update: ProcessProgress) => void
  cleanup: () => void
}

let worker: Worker | undefined
const pending = new Map<string, PendingRequest>()

const abortError = () =>
  new DOMException('Image processing was cancelled', 'AbortError')

function stopWorker(error: Error) {
  worker?.terminate()
  worker = undefined
  for (const request of pending.values()) {
    request.cleanup()
    request.reject(error)
  }
  pending.clear()
}

function getWorker() {
  if (worker) return worker

  worker = new Worker(
    new URL('../workers/background.worker.ts', import.meta.url),
    { type:'module' },
  )
  worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
    const request = pending.get(data.id)
    if (!request) return
    if (data.type === 'progress') {
      request.onProgress?.({ progress:data.progress, stage:data.stage })
      return
    }

    pending.delete(data.id)
    request.cleanup()
    if (data.type === 'error') {
      request.reject(new Error(data.error))
    } else {
      request.resolve({
        blob:data.blob,
        width:data.width,
        height:data.height,
      })
    }
  }
  worker.onerror = event => {
    stopWorker(new Error(event.message || 'The background-removal engine stopped.'))
  }
  return worker
}

export function removeImageBackground(
  image: Blob,
  signal?: AbortSignal,
  onProgress?: (update: ProcessProgress) => void,
) {
  if (signal?.aborted) return Promise.reject(abortError())
  const id = crypto.randomUUID()

  return new Promise<BackgroundResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      if (!pending.has(id)) return
      stopWorker(new Error('Background removal took too long to complete.'))
    }, 180_000)
    const cancel = () => {
      if (!pending.has(id)) return
      stopWorker(abortError())
    }
    const cleanup = () => {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
    }

    pending.set(id, { resolve, reject, onProgress, cleanup })
    signal?.addEventListener('abort', cancel, { once:true })
    getWorker().postMessage({ type:'remove-background', id, image })
  })
}

export function resetBackgroundRemoval() {
  if (pending.size) return
  worker?.terminate()
  worker = undefined
}
