import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Ban, Check, FileUp, Loader, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { codeMessage, formatBytes } from './job-model'
import { ProgressBar } from './job-progress'
import { uploadFraction, type UploadItem } from '~/lib/io/use-uploads'

/** Only drags that carry files; text and link drags pass through untouched. */
export const hasFiles = (types: readonly string[] | undefined): boolean =>
  Boolean(types && Array.from(types).includes('Files'))

/**
 * Wraps the navigation panel: while files are dragged over it, a "Drop files here" overlay covers it
 * (FR-IO-025). The overlay is visual; the keyboard path is the file picker of the import tab.
 */
export function DropTarget({
  enabled,
  onFiles,
  className,
  children,
}: {
  enabled: boolean
  onFiles: (files: File[]) => void
  className?: string
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  // Enter and leave fire for every child; the counter says whether the pointer is still inside.
  const depth = useRef(0)

  const enter = (e: DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer?.types)) return
    e.preventDefault()
    depth.current += 1
    setOver(true)
  }
  const leave = (e: DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer?.types)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }
  const dragOver = (e: DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer?.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const drop = (e: DragEvent) => {
    if (!enabled || !hasFiles(e.dataTransfer?.types)) return
    e.preventDefault()
    depth.current = 0
    setOver(false)
    onFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={enter}
      onDragLeave={leave}
      onDragOver={dragOver}
      onDrop={drop}
    >
      {children}
      {over && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-surface/90"
        >
          <p className="flex items-center gap-2 text-base font-semibold text-ink">
            <FileUp size={18} aria-hidden />
            {t('io.drop.here')}
          </p>
        </div>
      )}
    </div>
  )
}

function UploadRow({
  item,
  limitText,
  onCancel,
  onRemove,
}: {
  item: UploadItem
  limitText?: string
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}) {
  const f = item.bytes === 0 ? 0 : item.loaded / item.bytes
  const Icon = item.state === 'done' ? Check : item.state === 'uploading' ? Loader : Ban
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <Icon
          size={14}
          aria-hidden
          className={cn(
            'shrink-0',
            item.state === 'error' ? 'text-negative' : 'text-muted',
            item.state === 'uploading' && 'motion-safe:animate-spin',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.name}>
          {item.name}
        </span>
        <span className="shrink-0 text-xs text-muted">{formatBytes(item.bytes)}</span>
        {item.state === 'uploading' ? (
          <Button
            variant="ghost"
            size="icon"
            className="pointer-coarse:h-11 pointer-coarse:w-11"
            aria-label={t('io.upload.cancel', { name: item.name })}
            onClick={() => onCancel(item.id)}
          >
            <X size={14} aria-hidden />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="pointer-coarse:h-11 pointer-coarse:w-11"
            aria-label={t('io.upload.dismiss', { name: item.name })}
            onClick={() => onRemove(item.id)}
          >
            <X size={14} aria-hidden />
          </Button>
        )}
      </div>
      {item.state === 'uploading' && (
        <ProgressBar value={f} label={t('io.upload.progress', { name: item.name })} thin />
      )}
      {item.state === 'done' && <p className="text-xs text-muted">{t('io.upload.done')}</p>}
      {item.state === 'cancelled' && (
        <p className="text-xs text-muted">{t('io.upload.cancelled')}</p>
      )}
      {item.state === 'error' && (
        <p role="alert" className="text-xs text-negative">
          {codeMessage(item.error ?? 'upload_failed', limitText)}
        </p>
      )}
    </li>
  )
}

/** Files being uploaded, each with its own progress and a cancel button. */
export function UploadList({
  items,
  limitText,
  onCancel,
  onRemove,
}: {
  items: UploadItem[]
  limitText?: string
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <ul className="flex flex-col divide-y divide-border">
      {items.map((item) => (
        <UploadRow
          key={item.id}
          item={item}
          limitText={limitText}
          onCancel={onCancel}
          onRemove={onRemove}
        />
      ))}
    </ul>
  )
}

/** Floating status panel of the shell: file count, minimise, close (FR-IO-025). */
export function UploadStatusPanel({
  items,
  limitText,
  onCancel,
  onRemove,
  onClose,
}: {
  items: UploadItem[]
  limitText?: string
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onClose: () => void
}) {
  const [minimised, setMinimised] = useState(false)
  const titleId = useId()
  if (items.length === 0) return null
  const busy = items.filter((i) => i.state === 'uploading').length
  return (
    <section
      aria-labelledby={titleId}
      className="fixed right-3 bottom-3 z-40 flex w-[min(360px,calc(100vw-24px))] flex-col rounded-lg border border-border bg-surface shadow-lg"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {busy > 0
            ? t('io.upload.panelBusy', { n: busy })
            : t('io.upload.panelDone', { n: items.length })}
        </h2>
        <Button
          variant="ghost"
          aria-expanded={!minimised}
          className="pointer-coarse:h-11"
          onClick={() => setMinimised((v) => !v)}
        >
          {minimised ? t('io.upload.expand') : t('io.upload.minimise')}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="pointer-coarse:h-11 pointer-coarse:w-11"
          aria-label={t('io.upload.close')}
          disabled={busy > 0}
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
      {busy > 0 && (
        <div className="px-3 pb-2">
          <ProgressBar value={uploadFraction(items)} label={t('io.upload.overall')} thin />
        </div>
      )}
      {!minimised && (
        <div className="max-h-64 overflow-y-auto px-3 pb-2">
          <UploadList items={items} limitText={limitText} onCancel={onCancel} onRemove={onRemove} />
        </div>
      )}
    </section>
  )
}
