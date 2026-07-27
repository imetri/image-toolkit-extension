import LibRawModule from 'libraw-wasm/dist/libraw.js'
import { applyRawCaptureSharpening } from '../lib/rawEnhance'
import { encodeRawPng16 } from '../lib/pngEncoder'
import type { DecodedRawImage } from '../lib/rawDecoder'
import type { ProcessOptions } from '../types'

type InitMessage = {
  type: 'init'
  wasmDataUrl: string
}

type ProcessMessage = {
  type: 'process'
  id: string
  buffer: ArrayBuffer
  options: ProcessOptions
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

async function rawToRgba(image: DecodedRawImage, signal: AbortSignal) {
  const pixelCount = image.width * image.height
  if (image.colors < 1 || image.data.length < pixelCount * image.colors) {
    throw new Error('The RAW decoder returned incomplete pixel data.')
  }

  const rgba = new Uint8ClampedArray(pixelCount * 4)
  const max = image.bits > 8 ? 65535 : 255
  for (let y = 0; y < image.height; y += 1) {
    if ((y & 15) === 0) {
      if (signal.aborted) throw new DOMException('Image processing was cancelled', 'AbortError')
      if (y > 0) {
        await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0))
      }
    }
    const rowStart = y * image.width
    for (let x = 0; x < image.width; x += 1) {
      const pixel = rowStart + x
      const source = pixel * image.colors
      const target = pixel * 4
      rgba[target] = Math.round(image.data[source] * 255 / max)
      rgba[target + 1] = Math.round(
        image.data[source + Math.min(1, image.colors - 1)] * 255 / max,
      )
      rgba[target + 2] = Math.round(
        image.data[source + Math.min(2, image.colors - 1)] * 255 / max,
      )
      rgba[target + 3] = 255
    }
  }
  return rgba
}

function outputMime(format: ProcessOptions['format']) {
  if (format === 'original') return 'image/jpeg'
  return {
    png:'image/png',
    jpeg:'image/jpeg',
    webp:'image/webp',
    avif:'image/avif',
  }[format]
}

let runtime: Promise<LibRawRuntime> | undefined
const controllers = new Map<string, AbortController>()
const reportProgress = (id: string, progress: number, stage: string) => {
  self.postMessage({ type:'progress', id, progress, stage })
}

self.addEventListener('message', event => {
  const message = event.data as InitMessage | ProcessMessage | CancelMessage
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
    controllers.get(message.id)?.abort()
    return
  }

  void (async () => {
    let decoder: LibRawInstance | undefined
    const controller = new AbortController()
    controllers.set(message.id, controller)
    try {
      if (!runtime) throw new Error('The RAW decoder is not ready.')
      reportProgress(message.id, 0.04, 'Starting RAW decoder')
      const module = await runtime
      if (controller.signal.aborted) return

      decoder = new module.LibRaw()
      reportProgress(message.id, 0.08, 'Developing RAW image')
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
      if (controller.signal.aborted) return
      const source = decoder.imageData()
      if (!source?.data?.length || !source.width || !source.height) {
        throw new Error('The RAW file did not produce image pixels.')
      }

      const image: DecodedRawImage = {
        width:source.width,
        height:source.height,
        colors:source.colors,
        bits:source.bits,
        data:source.bits > 8
          ? new Uint16Array(source.data)
          : new Uint8Array(source.data),
      }
      decoder.delete()
      decoder = undefined

      reportProgress(message.id, 0.36, 'Restoring image detail')
      await applyRawCaptureSharpening(
        image,
        controller.signal,
        progress => reportProgress(
          message.id,
          0.36 + progress * 0.25,
          'Restoring image detail',
        ),
      )
      if (
        message.options.format === 'png' &&
        message.options.operation !== 'resize'
      ) {
        reportProgress(message.id, 0.62, 'Encoding lossless PNG')
        const blob = await encodeRawPng16(
          image,
          controller.signal,
          progress => reportProgress(
            message.id,
            0.62 + progress * 0.36,
            'Encoding lossless PNG',
          ),
        )
        self.postMessage({
          type:'processed',
          id:message.id,
          blob,
          width:image.width,
          height:image.height,
          bitDepth:16,
        })
        return
      }

      reportProgress(message.id, 0.62, 'Preparing image pixels')
      const rgba = await rawToRgba(image, controller.signal)
      reportProgress(message.id, 0.79, 'Encoding output image')
      const sourceCanvas = new OffscreenCanvas(image.width, image.height)
      const sourceContext = sourceCanvas.getContext('2d', { alpha:false })
      if (!sourceContext) throw new Error('Unable to prepare the RAW image.')
      sourceContext.putImageData(
        new ImageData(rgba, image.width, image.height),
        0,
        0,
      )

      const scale = message.options.operation === 'resize'
        ? (
            message.options.percentage
              ? message.options.percentage / 100
              : Math.min(
                  message.options.width
                    ? message.options.width / image.width
                    : 1,
                  message.options.height
                    ? message.options.height / image.height
                    : 1,
                )
          )
        : 1
      const width = Math.max(
        1,
        Math.round(
          message.options.keepAspect
            ? image.width * scale
            : (message.options.width || image.width * scale),
        ),
      )
      const height = Math.max(
        1,
        Math.round(
          message.options.keepAspect
            ? image.height * scale
            : (message.options.height || image.height * scale),
        ),
      )
      const mime = outputMime(message.options.format)
      const outputCanvas = new OffscreenCanvas(width, height)
      const outputContext = outputCanvas.getContext('2d', {
        alpha:mime !== 'image/jpeg',
      })
      if (!outputContext) throw new Error('Unable to render the RAW image.')
      outputContext.drawImage(sourceCanvas, 0, 0, width, height)
      const quality = mime === 'image/png'
        ? undefined
        : message.options.operation === 'compress'
          ? message.options.quality / 100
          : 1
      const blob = await outputCanvas.convertToBlob({ type:mime, quality })
      reportProgress(message.id, 0.98, 'Finishing output')
      self.postMessage({
        type:'processed',
        id:message.id,
        blob,
        width,
        height,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      self.postMessage({
        type:'error',
        id:message.id,
        error:error instanceof Error ? error.message : 'Unable to process the RAW file.',
      })
    } finally {
      controllers.delete(message.id)
      decoder?.delete()
    }
  })()
})
