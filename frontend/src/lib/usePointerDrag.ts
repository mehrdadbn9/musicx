import { useCallback, useRef, useState } from 'react'

/**
 * Pointer-based list reordering that does NOT use the HTML5 drag-and-drop
 * API (which is unreliable inside rows that also contain buttons/links, and
 * fails entirely in some browsers without setData). Instead it tracks
 * pointer movement: pointerdown on the handle starts a drag; we watch
 * pointermove to find which row the pointer is over and reorder when it
 * crosses that row's midpoint. Works with mouse and touch.
 */
export interface PointerDrag {
  dragIndex: number | null
  overIndex: number | null
  setRowRef: (i: number) => (el: HTMLElement | null) => void
  handleProps: (index: number) => { onPointerDown: (e: React.PointerEvent) => void }
  rowProps: (index: number) => {
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
  }
}

export function usePointerDrag(
  count: number,
  onReorder: (from: number, to: number) => void,
): PointerDrag {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const rowRefs = useRef<(HTMLElement | null)[]>([])
  const dragRef = useRef<number | null>(null)
  dragRef.current = dragIndex

  const setRowRef = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      rowRefs.current[i] = el
    },
    [],
  )

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        setDragIndex(index)
        setOverIndex(index)
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      },
    }),
    [],
  )

  const rowProps = useCallback(
    (index: number) => ({
      onPointerMove: (e: React.PointerEvent) => {
        const from = dragRef.current
        if (from === null) return
        const row = rowRefs.current[index]
        if (!row) return
        const rect = row.getBoundingClientRect()
        const pastMid = e.clientY > rect.top + rect.height / 2
        const target = pastMid ? index + 1 : index
        if (target >= count) return
        if (target !== from) {
          onReorder(from, target)
          setDragIndex(target)
          setOverIndex(target)
        } else {
          setOverIndex(target)
        }
      },
      onPointerUp: () => {
        setDragIndex(null)
        setOverIndex(null)
      },
    }),
    [count, onReorder],
  )

  return { dragIndex, overIndex, setRowRef, handleProps, rowProps }
}
