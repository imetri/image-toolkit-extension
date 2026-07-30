import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, readFileSync } from 'node:fs'

const BACKGROUND_MODEL_PATH =
  '/models/studioludens/birefnet-lite-512/onnx/model_fp16.onnx'
const BACKGROUND_MODEL_SIZE = 98_484_532
const BACKGROUND_MODEL_PARTS = Array.from(
  { length:13 },
  (_, index) => new URL(
    `./public${BACKGROUND_MODEL_PATH}.part-${index}`,
    import.meta.url,
  ),
)

export default defineConfig({
  plugins: [
    react(),
    {
      name:'serve-chunked-background-model',
      configureServer(server) {
        server.middlewares.use(BACKGROUND_MODEL_PATH, (request, response) => {
          response.statusCode = 200
          response.setHeader('Content-Length', String(BACKGROUND_MODEL_SIZE))
          response.setHeader('Content-Type', 'application/octet-stream')
          if (request.method === 'HEAD') {
            response.end()
            return
          }

          let partIndex = 0
          const pipeNextPart = () => {
            if (partIndex >= BACKGROUND_MODEL_PARTS.length) {
              response.end()
              return
            }
            const part = createReadStream(
              BACKGROUND_MODEL_PARTS[partIndex],
            )
            partIndex += 1
            part.once('error', error => response.destroy(error))
            part.once('end', pipeNextPart)
            part.pipe(response, { end:false })
          }
          pipeNextPart()
        })
      },
    },
    {
      name:'inline-libraw-wasm',
      enforce:'pre',
      load(id) {
        const suffix = '?raw-inline'
        if (!id.endsWith(`libraw.wasm${suffix}`)) return
        const filePath = id.slice(0, -suffix.length)
        const encoded = readFileSync(filePath).toString('base64')
        return `export default "data:application/wasm;base64,${encoded}"`
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:'index.html',
        rawSandbox:'raw-sandbox.html',
      },
    },
  }
})
