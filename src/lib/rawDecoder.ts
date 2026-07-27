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

type SandboxSlot = {
  frame: HTMLIFrameElement
  ready: Promise<HTMLIFrameElement>
  busy: boolean
}

const sandboxSlots: SandboxSlot[] = []
const sandboxWaiters: Array<(slot: SandboxSlot) => void> = []
let idleTimer: number | undefined

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')

export function rawProcessingConcurrency() {
  const deviceMemory = (
    navigator as Navigator & { deviceMemory?: number }
  ).deviceMemory ?? 4
  return deviceMemory >= 8 && navigator.hardwareConcurrency >= 8 ? 2 : 1
}

function createSandbox() {
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.setAttribute('aria-hidden', 'true')
  frame.src = new URL('raw-sandbox.html', window.location.href).href

  const slot = {
    frame,
    busy:true,
    ready:Promise.resolve(frame),
  } as SandboxSlot

  slot.ready = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onReady)
      frame.remove()
      reject(new Error('The full-resolution RAW decoder did not start.'))
    }, 20_000)

    const onReady = (event: MessageEvent<SandboxResponse>) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.channel !== CHANNEL ||
        event.data.type !== 'ready'
      ) return
      window.clearTimeout(timeout)
      window.removeEventListener('message', onReady)
      resolve(frame)
    }

    window.addEventListener('message', onReady)
    document.body.appendChild(frame)
  })
  sandboxSlots.push(slot)
  return slot
}

function acquireSandbox() {
  if (idleTimer) {
    window.clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const available = sandboxSlots.find(slot => !slot.busy)
  if (available) {
    available.busy = true
    return Promise.resolve(available)
  }
  if (sandboxSlots.length < rawProcessingConcurrency()) {
    return Promise.resolve(createSandbox())
  }
  return new Promise<SandboxSlot>(resolve => sandboxWaiters.push(resolve))
}

function releaseSandbox(slot: SandboxSlot) {
  const waiter = sandboxWaiters.shift()
  if (waiter) {
    slot.busy = true
    waiter(slot)
    return
  }
  slot.busy = false
  if (sandboxSlots.every(candidate => !candidate.busy)) {
    idleTimer = window.setTimeout(resetRawDecoder, 5_000)
  }
}

function discardSandbox(slot: SandboxSlot) {
  const index = sandboxSlots.indexOf(slot)
  if (index >= 0) sandboxSlots.splice(index, 1)
  slot.frame.remove()
  const waiter = sandboxWaiters.shift()
  if (waiter) waiter(createSandbox())
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
  const slot = await acquireSandbox()
  let frame: HTMLIFrameElement
  try {
    frame = await slot.ready
  } catch (error) {
    discardSandbox(slot)
    throw error
  }
  if (signal?.aborted) {
    releaseSandbox(slot)
    throw abortError()
  }
  const input = await file.arrayBuffer()
  if (signal?.aborted) {
    releaseSandbox(slot)
    throw abortError()
  }
  const id = crypto.randomUUID()

  return new Promise<ProcessedRawImage>((resolve, reject) => {
    let released = false
    const timeout = window.setTimeout(() => {
      frame.contentWindow?.postMessage({ channel:CHANNEL, type:'cancel', id }, '*')
      cleanup(false)
      discardSandbox(slot)
      reject(new Error(`${file.name} took too long to process at full resolution.`))
    }, 90_000)
    const cleanup = (shouldRelease = true) => {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      window.removeEventListener('message', onMessage)
      if (!released) {
        released = true
        if (shouldRelease) releaseSandbox(slot)
      }
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
  if (sandboxSlots.some(slot => slot.busy)) return
  sandboxSlots.forEach(slot => slot.frame.remove())
  sandboxSlots.length = 0
}
