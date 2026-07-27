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
  type: 'ready' | 'decoded' | 'error'
  id?: string
  width?: number
  height?: number
  colors?: number
  bits?: number
  buffer?: ArrayBuffer
  error?: string
}

let sandboxFrame: HTMLIFrameElement | undefined
let sandboxReady: Promise<HTMLIFrameElement> | undefined

const abortError = () => new DOMException('Image processing was cancelled', 'AbortError')

function ensureSandbox() {
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

export async function decodeRawImage(file: File, signal?: AbortSignal): Promise<DecodedRawImage> {
  if (signal?.aborted) throw abortError()
  const frame = await ensureSandbox()
  if (signal?.aborted) throw abortError()
  const input = await file.arrayBuffer()
  if (signal?.aborted) throw abortError()
  const id = crypto.randomUUID()

  return new Promise<DecodedRawImage>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      frame.contentWindow?.postMessage({ channel:CHANNEL, type:'cancel', id }, '*')
      cleanup()
      resetRawDecoder()
      reject(new Error(`${file.name} took too long to decode at full resolution.`))
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
      cleanup()
      if (message.type === 'error') {
        reject(new Error(message.error || 'Unable to decode the RAW file.'))
        return
      }
      if (
        message.type !== 'decoded' ||
        !message.buffer ||
        !message.width ||
        !message.height ||
        !message.colors ||
        !message.bits
      ) {
        reject(new Error('The RAW decoder returned an invalid image.'))
        return
      }
      const decoded = {
        width:message.width,
        height:message.height,
        colors:message.colors,
        bits:message.bits,
        data:message.bits > 8 ? new Uint16Array(message.buffer) : new Uint8Array(message.buffer),
      }
      resetRawDecoder()
      resolve(decoded)
    }

    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once:true })
    window.addEventListener('message', onMessage)
    frame.contentWindow?.postMessage({ channel:CHANNEL, type:'decode', id, buffer:input }, '*', [input])
  })
}

export function resetRawDecoder() {
  sandboxFrame?.remove()
  sandboxFrame = undefined
  sandboxReady = undefined
}
