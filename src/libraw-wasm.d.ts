declare module 'libraw-wasm/dist/libraw.js' {
  type ModuleOptions = {
    locateFile?: (path: string, prefix: string) => string
  }

  const createModule: (options?: ModuleOptions) => Promise<unknown>
  export default createModule
}
