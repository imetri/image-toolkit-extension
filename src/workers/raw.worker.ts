import LibRawModule from 'libraw-wasm/dist/libraw.js'

type InitMessage = {
  type: 'init'
  wasmDataUrl: string
}

type DecodeMessage = {
  type: 'decode'
  id: string
  buffer: ArrayBuffer
}

type CancelMessage = {
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
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

let runtime: Promise<LibRawRuntime> | undefined
const cancelled = new Set<string>()

self.addEventListener('message', event => {
  const message = event.data as InitMessage | DecodeMessage | CancelMessage
  if (message.type === 'init') {
    runtime = LibRawModule({
      wasmBinary:decodeDataUrl(message.wasmDataUrl),
    }) as Promise<LibRawRuntime>
    void runtime.then(
      () => self.postMessage({ type:'ready' }),
      error => self.postMessage({
        type:'error',
        error:error instanceof Error ? error.message : 'The RAW decoder did not start.',
      }),
    )
    return
  }
  if (message.type === 'cancel') {
    cancelled.add(message.id)
    return
  }

  void (async () => {
    let decoder: LibRawInstance | undefined
    try {
      if (!runtime) throw new Error('The RAW decoder is not ready.')
      const module = await runtime
      if (cancelled.delete(message.id)) return
      decoder = new module.LibRaw()
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
      if (cancelled.delete(message.id)) return
      const image = decoder.imageData()
      if (!image?.data?.length || !image.width || !image.height) {
        throw new Error('The RAW file did not produce image pixels.')
      }

      const pixels = image.bits > 8
        ? new Uint16Array(image.data).buffer
        : new Uint8Array(image.data).buffer
      self.postMessage({
        type:'decoded',
        id:message.id,
        width:image.width,
        height:image.height,
        colors:image.colors,
        bits:image.bits,
        buffer:pixels,
      }, { transfer:[pixels] })
    } catch (error) {
      if (cancelled.delete(message.id)) return
      self.postMessage({
        type:'error',
        id:message.id,
        error:error instanceof Error ? error.message : 'Unable to decode the RAW file.',
      })
    } finally {
      decoder?.delete()
    }
  })()
})
