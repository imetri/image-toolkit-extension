declare module 'libraw-wasm/dist/libraw.js' {
  type ModuleOptions = {
    locateFile?: (path: string, prefix: string) => string
    wasmBinary?: Uint8Array
  }

  const createModule: (options?: ModuleOptions) => Promise<unknown>
  export default createModule
}

declare module 'libraw-wasm/dist/libraw.wasm?raw-inline' {
  const dataUrl: string
  export default dataUrl
}
