import { useCallback, useState } from 'react'
import type { ImageItem } from '../types'
import { newId } from '../lib/utils'
import { isImageFile, isRawImage, rawPlaceholder } from '../lib/imageFormats'

export function useImageQueue() {
  const [items, setItems] = useState<ImageItem[]>([])
  const addFiles = useCallback((files: FileList | File[]) => {
    const accepted = Array.from(files)
      .filter(isImageFile)
      .map(file => ({ id:newId(), file, preview:isRawImage(file) ? rawPlaceholder(file.name) : URL.createObjectURL(file) }))
    setItems(current => [...current, ...accepted])
  }, [])
  const remove = useCallback((id: string) => setItems(current => {
    const removed = current.find(item => item.id === id)
    if (removed?.preview.startsWith('blob:')) URL.revokeObjectURL(removed.preview)
    return current.filter(item => item.id !== id)
  }), [])
  const clear = useCallback(() => { items.forEach(item => URL.revokeObjectURL(item.preview)); setItems([]) }, [items])
  return { items, addFiles, remove, clear }
}
