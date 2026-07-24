import type { OutputFormat } from '../types'

export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
export const outputMime = (format: OutputFormat, original: string) => format === 'original' ? original : ({ png:'image/png', jpeg:'image/jpeg', webp:'image/webp', avif:'image/avif' } as const)[format]
export const extensionFor = (mime: string) => mime.split('/')[1].replace('jpeg','jpg')
export const newId = () => crypto.randomUUID()
