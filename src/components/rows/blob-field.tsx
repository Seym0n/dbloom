/**
 * BLOB and binary values in the form and the cell dialog (FR-ROW-012, UI-ISS-112, SCN-047).
 * Bytes never travel through the form as text: a file is staged on the server (`uploadFile`) and the write
 * refers to it by id; the stored value is shown by size, downloaded or previewed through one-time ids.
 */
import { useContext, useRef, useState } from 'react'
import { Download, Eye, FileUp, Undo2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { t } from '~/i18n'
import type { Cell, PreviewType, RowColumn, UploadResponse } from '~/server/rows/types'
import { RowFormContext, formatBytes, initialWire, wireEqual } from './form-core'
import { describeRowsRefusal, formsApi } from './server-api-forms'
import type { ValueEditorProps } from './registry'

const cellUrl = (id: string) => `/api/rows/cell/${encodeURIComponent(id)}`

/** Starts a download without leaving the page; the id is single use and short lived. */
function startDownload(id: string, fileName: string) {
  const a = document.createElement('a')
  a.href = cellUrl(id)
  a.download = fileName
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Download and preview of the stored value of one cell. Image types render in an `<img>` from the
 * one-time route; a PDF opens in a new tab; nothing else is ever rendered inline (FR-ROW-012).
 */
export function BlobActions({
  column,
  size,
  disabled,
}: {
  column: RowColumn
  /** Stored size in bytes when known. */
  size?: number
  disabled?: boolean
}) {
  const ctx = useContext(RowFormContext)
  const [busy, setBusy] = useState<'download' | 'preview' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [image, setImage] = useState<{ url: string; broken: boolean } | null>(null)
  const key = ctx.rowKey

  async function open(disposition: 'download' | 'preview') {
    if (!key) return
    setBusy(disposition)
    setError(null)
    try {
      const r = await formsApi().openCell({
        db: ctx.db,
        table: ctx.table,
        key,
        column: column.name,
        disposition,
      })
      if (!r.found) {
        setError(t('rows.blob.gone'))
        return
      }
      if (disposition === 'download') {
        startDownload(r.id, r.fileName)
      } else if (r.previewType === 'pdf') {
        window.open(cellUrl(r.id), '_blank', 'noopener,noreferrer')
      } else if (r.previewType) {
        setImage({ url: cellUrl(r.id), broken: false })
      } else {
        setError(t('rows.blob.noPreview'))
      }
    } catch (e) {
      setError(describeRowsRefusal(e).message)
    } finally {
      setBusy(null)
    }
  }

  const label = column.name
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || !key || busy !== null}
          aria-label={t('rows.blob.downloadNamed', { name: label })}
          onClick={() => void open('download')}
        >
          <Download size={14} aria-hidden />
          {busy === 'download' ? t('rows.blob.opening') : t('rows.blob.download')}
        </Button>
        <Button
          disabled={disabled || !key || busy !== null}
          aria-label={t('rows.blob.previewNamed', { name: label })}
          onClick={() => void open('preview')}
        >
          <Eye size={14} aria-hidden />
          {busy === 'preview' ? t('rows.blob.opening') : t('rows.blob.preview')}
        </Button>
        {size !== undefined && <span className="text-xs text-muted">{formatBytes(size)}</span>}
      </div>
      {image && !image.broken && (
        <img
          src={image.url}
          alt={t('rows.blob.previewAlt', { name: label })}
          className="max-h-64 max-w-full self-start rounded-[var(--radius-control)] bg-raised object-contain"
          onError={() => setImage({ ...image, broken: true })}
        />
      )}
      {image?.broken && (
        <p className="rounded-[var(--radius-control)] bg-raised px-3 py-2 text-sm text-muted">
          {t('rows.blob.notAnImage')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-negative">
          {error}
        </p>
      )}
    </div>
  )
}

type Staged = Pick<UploadResponse, 'size' | 'sha256' | 'fileName' | 'previewType'>

const TYPE_LABEL: Record<PreviewType, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  pdf: 'PDF',
}

/** Size of a stored value from its cell, when the grid knows it. */
export function storedSize(cell: Cell): number | undefined {
  if (cell !== null && typeof cell === 'object' && 'size' in cell) return cell.size
  return undefined
}

/**
 * Body of the editor for `binary` and `blob` kinds (shown in value mode): upload, current value, and for
 * `binary` kinds a hex field for short values. The mode bar (NULL, DEFAULT) belongs to the shell around it.
 */
export function BlobBody({
  column,
  value,
  onChange,
  disabled,
  error,
  labelId,
  describedById,
  mode,
}: ValueEditorProps) {
  const ctx = useContext(RowFormContext)
  const inputRef = useRef<HTMLInputElement>(null)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [uploading, setUploading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const original = value.original
  const stored = original !== null
  const initial = initialWire(column, original)
  const changed = !wireEqual(initial, value.current)
  const id = `${labelId}-in`

  async function pick(file: File | undefined) {
    if (!file) return
    setLocalError(null)
    if (file.size > ctx.uploadBytes) {
      setLocalError(
        t('rows.blob.tooLarge', {
          size: formatBytes(file.size),
          cap: formatBytes(ctx.uploadBytes),
        }),
      )
      if (inputRef.current) inputRef.current.value = ''
      return
    }
    setUploading(true)
    try {
      const r = await formsApi().uploadFile(file)
      setStaged({
        size: r.size,
        sha256: r.sha256,
        fileName: r.fileName ?? file.name,
        previewType: r.previewType,
      })
      onChange({ t: 'bin', upload: r.uploadId })
    } catch (e) {
      setLocalError(describeRowsRefusal(e).message)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const message = localError ?? error
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy={uploading}>
      <p className="text-sm" aria-live="polite">
        {value.current.t === 'bin' && staged
          ? t('rows.blob.staged', {
              name: staged.fileName ?? '',
              size: formatBytes(staged.size),
              type: staged.previewType ? TYPE_LABEL[staged.previewType] : t('rows.blob.typeBytes'),
            })
          : value.current.t === 'bin'
            ? t('rows.blob.stagedPlain')
            : stored
              ? t('rows.blob.stored', {
                  size:
                    storedSize(original) !== undefined
                      ? formatBytes(storedSize(original) ?? 0)
                      : '–',
                })
              : t('rows.blob.empty')}
        {value.dirty && <span className="ml-2 text-xs text-muted">{t('rows.form.changed')}</span>}
      </p>
      {value.current.t === 'bin' && staged && (
        <p className="font-mono text-xs break-all text-muted">SHA-256 {staged.sha256}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="file"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          aria-labelledby={labelId}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <Button
          disabled={disabled || uploading}
          aria-describedby={describedById}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp size={14} aria-hidden />
          {uploading ? t('rows.blob.uploading') : t('rows.blob.choose')}
        </Button>
        {changed && (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setStaged(null)
              setLocalError(null)
              onChange(initial)
            }}
          >
            <Undo2 size={14} aria-hidden />
            {t('rows.blob.keep')}
          </Button>
        )}
        <span className="text-xs text-muted">
          {t('rows.blob.cap', { cap: formatBytes(ctx.uploadBytes) })}
        </span>
      </div>
      {column.kind === 'binary' && value.current.t === 'v' && (
        <Input
          aria-labelledby={labelId}
          aria-describedby={describedById}
          aria-invalid={Boolean(message)}
          className="font-mono"
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={value.current.v}
          onChange={(e) => onChange({ t: 'v', v: e.target.value })}
        />
      )}
      {mode === 'edit' && stored && (
        <BlobActions column={column} size={storedSize(original)} disabled={disabled} />
      )}
      {message && (
        <p role="alert" className="text-xs text-negative">
          {message}
        </p>
      )}
    </div>
  )
}
