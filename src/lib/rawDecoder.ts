import type { ProcessOptions, ProcessProgress } from '../types'

const CHANNEL = 'imageflow-raw-decoder'

export type DecodedRawImage = {
  width: number
  height: number
  colors: number
  bits: number
  data: Uint8Array | Uint16Array
}

type SandboxResponse = {
  channel: typeof CHANNEL
  type: 'ready' | 'processed' | 'error' | 'progress'
  id?: string
  width?: number
  height?: number
  colors?: number
  bits?: number
  bitDepth?: number
  blob?: Blob
  error?: string
  progress?: number
  stage?: string
}

let sandboxFrame: HTMLIFrameElement | undefined
let sandboxReady: Promise<HTMLIFrameElement> | undefined
let idleTimer: number | undefined

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')

function ensureSandbox() {
  if (idleTimer) {
    window.clearTimeout(idleTimer)
    idleTimer = undefined
  }
  if (sandboxReady) return sandboxReady

  sandboxReady = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const frame = document.createElement('iframe')
    sandboxFrame = frame
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.src = new URL('raw-sandbox.html', window.location.href).href

    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onReady)
      sandboxReady = undefined
      sandboxFrame = undefined
      frame.remove()
      reject(new Error('The full-resolution RAW decoder did not start.'))
    }, 20_000)

    const onReady = (event: MessageEvent<SandboxResponse>) => {
      if (event.source !== frame.contentWindow || event.data?.channel !== CHANNEL || event.data.type !== 'ready') return
      window.clearTimeout(timeout)
      window.removeEventListener('message', onReady)
      resolve(frame)
    }

    window.addEventListener('message', onReady)
    document.body.appendChild(frame)
  })

  return sandboxReady
}

export type ProcessedRawImage = {
  blob: Blob
  width: number
  height: number
  bitDepth?: number
}

export async function processRawImage(
  file: File,
  options: ProcessOptions,
  signal?: AbortSignal,
  onProgress?: (update: ProcessProgress) => void,
): Promise<ProcessedRawImage> {
  if (signal?.aborted) throw abortError()
  const frame = await ensureSandbox()
  if (signal?.aborted) throw abortError()
  const input = await file.arrayBuffer()
  if (signal?.aborted) throw abortError()
  const id = crypto.randomUUID()

  return new Promise<ProcessedRawImage>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      frame.contentWindow?.postMessage({ channel:CHANNEL, type:'cancel', id }, '*')
      cleanup()
      resetRawDecoder()
      reject(new Error(`${file.name} took too long to process at full resolution.`))
    }, 90_000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      window.removeEventListener('message', onMessage)
    }
    const cancel = () => {
      frame.contentWindow?.postMessage({ channel:CHANNEL, type:'cancel', id }, '*')
      cleanup()
      reject(abortError())
    }
    const onMessage = (event: MessageEvent<SandboxResponse>) => {
      const message = event.data
      if (event.source !== frame.contentWindow || message?.channel !== CHANNEL || message.id !== id) return
      if (message.type === 'progress') {
        onProgress?.({
          progress:Math.max(0, Math.min(1, message.progress ?? 0)),
          stage:message.stage || 'Processing RAW image',
        })
        return
      }
      cleanup()
      if (message.type === 'error') {
        reject(new Error(message.error || 'Unable to decode the RAW file.'))
        return
      }
      if (
        message.type !== 'processed' ||
        !message.blob ||
        !message.width ||
        !message.height
      ) {
        reject(new Error('The RAW processor returned an invalid image.'))
        return
      }
      const processed = {
        blob:message.blob,
        width:message.width,
        height:message.height,
        bitDepth:message.bitDepth,
      }
      idleTimer = window.setTimeout(resetRawDecoder, 5_000)
      resolve(processed)
    }

    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once:true })
    window.addEventListener('message', onMessage)
    frame.contentWindow?.postMessage({
      channel:CHANNEL,
      type:'process',
      id,
      buffer:input,
      options,
    }, '*', [input])
  })
}

export function resetRawDecoder() {
  if (idleTimer) window.clearTimeout(idleTimer)
  idleTimer = undefined
  sandboxFrame?.remove()
  sandboxFrame = undefined
  sandboxReady = undefined
}
