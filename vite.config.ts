import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

export default defineConfig({
  plugins: [
    react(),
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
