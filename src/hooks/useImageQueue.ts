import { useCallback, useState } from 'react'
import type { ImageItem } from '../types'
import { newId } from '../lib/utils'

export function useImageQueue() {
  const [items, setItems] = useState<ImageItem[]>([])
  const addFiles = useCallback((files: FileList | File[]) => { const accepted = Array.from(files).filter(file => file.type.startsWith('image/')).map(file => ({ id:newId(), file, preview:URL.createObjectURL(file) })); setItems(current => [...current, ...accepted]) }, [])
  const remove = useCallback((id: string) => setItems(current => current.filter(item => item.id !== id)), [])
  const clear = useCallback(() => { items.forEach(item => URL.revokeObjectURL(item.preview)); setItems([]) }, [items])
  return { items, addFiles, remove, clear }
}
