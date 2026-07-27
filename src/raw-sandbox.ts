import librawWasmDataUrl from 'libraw-wasm/dist/libraw.wasm?raw-inline'

const CHANNEL = 'imageflow-raw-decoder'

type DecoderMessage = {
  channel: typeof CHANNEL
  type: 'decode' | 'cancel'
  id: string
  buffer?: ArrayBuffer
}

type WorkerResponse = {
  type: 'ready' | 'decoded' | 'error'
  id?: string
  width?: number
  height?: number
  colors?: number
  bits?: number
  buffer?: ArrayBuffer
  error?: string
}

const worker = new Worker(
  new URL('./workers/raw.worker.ts', import.meta.url),
  { type:'module' },
)
const pending = new Set<string>()
worker.postMessage({ type:'init', wasmDataUrl:librawWasmDataUrl })

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data
  if (message.type === 'ready') {
    window.parent.postMessage({ channel:CHANNEL, type:'ready' }, '*')
    return
  }
  if (!message.id) return
  pending.delete(message.id)
  const response = { channel:CHANNEL, ...message }
  if (message.buffer) {
    window.parent.postMessage(response, '*', [message.buffer])
  } else {
    window.parent.postMessage(response, '*')
  }
}

worker.onerror = event => {
  for (const id of pending) {
    window.parent.postMessage({
      channel:CHANNEL,
      type:'error',
      id,
      error:event.message || 'The RAW decoder worker stopped unexpectedly.',
    }, '*')
  }
  pending.clear()
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.channel !== CHANNEL) return
  const message = event.data as DecoderMessage
  if (message.type === 'decode' && message.buffer) {
    pending.add(message.id)
    worker.postMessage(message, [message.buffer])
  } else {
    pending.delete(message.id)
    worker.postMessage(message)
  }
})
