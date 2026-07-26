import LibRawModule from 'libraw-wasm/dist/libraw.js'
import librawWasmDataUrl from 'libraw-wasm/dist/libraw.wasm?raw-inline'

const CHANNEL = 'imageflow-raw-decoder'

type DecodeMessage = {
  channel: typeof CHANNEL
  type: 'decode'
  id: string
  buffer: ArrayBuffer
}

type CancelMessage = {
  channel: typeof CHANNEL
  type: 'cancel'
  id: string
}

type LibRawInstance = {
  open: (bytes: Uint8Array, settings: Record<string, unknown>) => void
  imageData: () => {
    width: number
    height: number
    colors: number
    bits: number
    data: Uint8Array | Uint16Array
  } | undefined
  delete: () => void
}

type LibRawRuntime = {
  LibRaw: new () => LibRawInstance
}

function decodeDataUrl(dataUrl: string) {
  const separator = dataUrl.indexOf(',')
  if (separator < 0 || !dataUrl.slice(0, separator).includes(';base64')) {
    throw new Error('The embedded RAW decoder is invalid.')
  }
  const binary = atob(dataUrl.slice(separator + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const runtime = LibRawModule({
  wasmBinary:decodeDataUrl(librawWasmDataUrl),
}) as Promise<LibRawRuntime>
const active = new Map<string, LibRawInstance>()

const reply = (message: object, transfer: Transferable[] = []) => {
  window.parent.postMessage({ channel:CHANNEL, ...message }, '*', transfer)
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.channel !== CHANNEL) return
  const message = event.data as DecodeMessage | CancelMessage

  if (message.type === 'cancel') {
    const decoder = active.get(message.id)
    active.delete(message.id)
    decoder?.delete()
    return
  }

  void (async () => {
    let decoder: LibRawInstance | undefined
    try {
      const module = await runtime
      decoder = new module.LibRaw()
      active.set(message.id, decoder)
      decoder.open(new Uint8Array(message.buffer), {
        useCameraWb:true,
        useCameraMatrix:1,
        outputColor:1,
        outputBps:16,
        userFlip:-1,
        userQual:4,
        highlight:2,
        greenMatching:true,
        dcbIterations:2,
        dcbEnhanceFl:true,
        fbddNoiserd:1,
        medPasses:1,
      })
      const image = decoder.imageData()
      if (active.get(message.id) !== decoder) return
      if (!image?.data?.length || !image.width || !image.height) {
        throw new Error('The RAW file did not produce image pixels.')
      }

      const pixels = image.bits > 8
        ? new Uint16Array(image.data).buffer
        : new Uint8Array(image.data).buffer
      reply({
        type:'decoded',
        id:message.id,
        width:image.width,
        height:image.height,
        colors:image.colors,
        bits:image.bits,
        buffer:pixels,
      }, [pixels])
    } catch (error) {
      if (decoder && active.get(message.id) !== decoder) return
      reply({
        type:'error',
        id:message.id,
        error:error instanceof Error ? error.message : 'Unable to decode the RAW file.',
      })
    } finally {
      if (decoder && active.get(message.id) === decoder) active.delete(message.id)
      decoder?.delete()
    }
  })()
})

reply({ type:'ready' })
