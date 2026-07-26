export type OutputFormat = 'original' | 'png' | 'jpeg' | 'webp' | 'avif'
export type Operation = 'convert' | 'resize' | 'compress'
export type ImageItem = { id: string; file: File; preview: string; width?: number; height?: number }
export type ProcessedItem = { id: string; sourceName: string; name: string; blob: Blob; preview: string; originalSize: number; outputSize: number; width?: number; height?: number; bitDepth?: number; warning?: string; status: 'done' | 'processing' | 'error' }
export type ProcessOptions = { operation: Operation; format: OutputFormat; width?: number; height?: number; percentage?: number; keepAspect: boolean; quality: number }
