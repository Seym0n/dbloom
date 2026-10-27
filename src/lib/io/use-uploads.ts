/** Queue of file uploads with per-file progress and cancel (FR-IO-025). The reducer is pure; the hook adds the XHRs. */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { IoFormat } from '~/server/io/types'
import { checkFileName, uploadFile, UploadError, type UploadHandle } from './upload'

export type UploadItem = {
  id: string
  name: string
  bytes: number
  loaded: number
  state: 'uploading' | 'done' | 'error' | 'cancelled'
  format?: IoFormat
  uploadId?: string
  /** Error code (an IoErrorCode, `unsupported_type` or `network`) for the message. */
  error?: string
}

export type UploadAction =
  | { type: 'add'; item: UploadItem }
  | { type: 'progress'; id: string; loaded: number }
  | { type: 'done'; id: string; uploadId: string }
  | { type: 'fail'; id: string; error: string }
  | { type: 'cancel'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }

export function uploadReducer(items: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [...items, action.item]
    case 'progress':
      return items.map((i) =>
        i.id === action.id && i.state === 'uploading' ? { ...i, loaded: action.loaded } : i,
      )
    case 'done':
      return items.map((i) =>
        i.id === action.id && i.state === 'uploading'
          ? { ...i, state: 'done', loaded: i.bytes, uploadId: action.uploadId }
          : i,
      )
    case 'fail':
      return items.map((i) =>
        i.id === action.id && i.state === 'uploading'
          ? { ...i, state: 'error', error: action.error }
          : i,
      )
    case 'cancel':
      return items.map((i) =>
        i.id === action.id && i.state === 'uploading' ? { ...i, state: 'cancelled' } : i,
      )
    case 'remove':
      return items.filter((i) => i.id !== action.id)
    case 'clear':
      return items.filter((i) => i.state === 'uploading')
  }
}

/** Overall fraction 0..1 of the files still uploading plus the ones just finished. */
export const uploadFraction = (items: UploadItem[]): number => {
  const total = items.reduce((s, i) => s + i.bytes, 0)
  return total === 0 ? 0 : items.reduce((s, i) => s + i.loaded, 0) / total
}

export function useUploadQueue(options: {
  /** Effective upload limit in bytes; a larger file is refused without being sent. */
  limitBytes?: number
  onDone?: (item: UploadItem & { uploadId: string; format: IoFormat }) => void
}) {
  const [items, dispatch] = useReducer(uploadReducer, [])
  const handles = useRef(new Map<string, UploadHandle>())
  const seq = useRef(0)
  const onDone = useRef(options.onDone)
  onDone.current = options.onDone
  const limit = options.limitBytes

  const add = useCallback(
    (files: Iterable<File>, formatHint?: IoFormat) => {
      for (const file of files) {
        seq.current += 1
        const id = `u${seq.current}`
        const check = checkFileName(file.name)
        const format = check.ok ? check.format : formatHint
        const base: UploadItem = {
          id,
          name: file.name,
          bytes: file.size,
          loaded: 0,
          state: 'uploading',
          ...(format ? { format } : {}),
        }
        if (!check.ok && !formatHint) {
          dispatch({ type: 'add', item: { ...base, state: 'error', error: 'unsupported_type' } })
          continue
        }
        if (limit !== undefined && file.size > limit) {
          dispatch({ type: 'add', item: { ...base, state: 'error', error: 'upload_too_large' } })
          continue
        }
        if (file.size === 0) {
          dispatch({ type: 'add', item: { ...base, state: 'error', error: 'upload_empty' } })
          continue
        }
        dispatch({ type: 'add', item: base })
        const handle = uploadFile(file, {
          format: format ?? 'sql',
          onProgress: (loaded) => dispatch({ type: 'progress', id, loaded }),
        })
        handles.current.set(id, handle)
        handle.promise.then(
          ({ uploadId }) => {
            handles.current.delete(id)
            dispatch({ type: 'done', id, uploadId })
            onDone.current?.({
              ...base,
              state: 'done',
              loaded: base.bytes,
              uploadId,
              format: format ?? 'sql',
            })
          },
          (error: unknown) => {
            handles.current.delete(id)
            if (error instanceof UploadError && error.code === 'cancelled') return
            dispatch({
              type: 'fail',
              id,
              error: error instanceof UploadError ? error.code : 'upload_failed',
            })
          },
        )
      }
    },
    [limit],
  )

  const cancel = useCallback((id: string) => {
    dispatch({ type: 'cancel', id })
    handles.current.get(id)?.abort()
    handles.current.delete(id)
  }, [])

  // Leaving the screen aborts what is still in flight, so no staged file is left half written.
  useEffect(() => {
    const live = handles.current
    return () => {
      for (const h of live.values()) h.abort()
      live.clear()
    }
  }, [])

  return {
    items,
    add,
    cancel,
    remove: (id: string) => dispatch({ type: 'remove', id }),
    clear: () => dispatch({ type: 'clear' }),
  }
}
