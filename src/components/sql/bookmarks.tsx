import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Play, SquarePen, Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { setSessionEnded } from '~/lib/session-state'
import type { Bookmark } from '~/server/sql/types'
import { t } from '~/i18n'
import { describeSqlError } from './errors'
import { SqlView, type Product } from './editor'
import { isSessionOnly, pickList } from './helpers'
import { Notice } from './parts'
import { deleteBookmark, listBookmarks, renameBookmark, saveBookmark } from './server-api'

export const bookmarkKeys = { all: ['sql', 'bookmarks'] as const }

function report(error: unknown): string {
  const d = describeSqlError(error)
  if (d.sessionEnded) setSessionEnded(true)
  return d.message
}

/** Name prompt for "save as bookmark" (Ctrl+S, toolbar, history entry). Text is redacted on the server. */
export function SaveBookmarkDialog({
  request,
  onClose,
  onSaved,
}: {
  request: { sql: string; db: string | null; name?: string } | null
  onClose: () => void
  onSaved: (b: Bookmark) => void
}) {
  const titleId = useId()
  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      labelledBy={titleId}
      className="w-[min(420px,calc(100vw-32px))]"
    >
      {request && (
        <SaveBody request={request} titleId={titleId} onClose={onClose} onSaved={onSaved} />
      )}
    </Dialog>
  )
}

function SaveBody({
  request,
  titleId,
  onClose,
  onSaved,
}: {
  request: { sql: string; db: string | null; name?: string }
  titleId: string
  onClose: () => void
  onSaved: (b: Bookmark) => void
}) {
  const [name, setName] = useState(request.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const inputId = useId()
  const save = useMutation({
    mutationFn: () =>
      saveBookmark({
        data: { name: name.trim(), sql: request.sql, ...(request.db ? { db: request.db } : {}) },
      }),
    onSuccess: (b) => {
      void queryClient.invalidateQueries({ queryKey: bookmarkKeys.all })
      onSaved(b)
      onClose()
    },
    onError: (e) => setError(report(e)),
  })
  return (
    <form
      className="flex flex-col gap-4 p-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() !== '' && !save.isPending) save.mutate()
      }}
    >
      <h2 id={titleId} className="text-base font-semibold">
        {t('sql.bookmark.saveTitle')}
      </h2>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>{t('sql.bookmark.name')}</Label>
        <Input
          id={inputId}
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : undefined}
        />
        {error && (
          <p id={`${inputId}-err`} role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </div>
      <p className="text-xs text-muted">{t('sql.bookmark.redactNote')}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('sql.bookmark.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={name.trim() === '' || save.isPending}>
          {t('sql.bookmark.save')}
        </Button>
      </div>
    </form>
  )
}

function Row({
  bookmark,
  product,
  onRun,
  onEdit,
}: {
  bookmark: Bookmark
  product?: Product
  onRun: (sql: string, db: string | null) => void
  onEdit: (sql: string, db: string | null) => void
}) {
  const queryClient = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(bookmark.name)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const rename = useMutation({
    mutationFn: () => renameBookmark({ data: { id: bookmark.id, name: name.trim() } }),
    onSuccess: () => {
      setRenaming(false)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: bookmarkKeys.all })
    },
    onError: (e) => setError(report(e)),
  })
  const remove = useMutation({
    mutationFn: () => deleteBookmark({ data: { id: bookmark.id } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: bookmarkKeys.all }),
    onError: (e) => setError(report(e)),
  })

  return (
    <li className="flex flex-col gap-2 border-b border-rule px-4 py-3">
      {renaming ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() !== '') rename.mutate()
          }}
        >
          <Input
            autoFocus
            aria-label={t('sql.bookmark.name')}
            className="h-8"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setRenaming(false)
                setName(bookmark.name)
              }
            }}
          />
          <Button type="submit" variant="primary" disabled={rename.isPending}>
            {t('sql.bookmark.save')}
          </Button>
        </form>
      ) : (
        <p className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-medium" title={bookmark.name}>
            {bookmark.name}
          </span>
          {bookmark.db && <span className="shrink-0 text-xs text-muted">{bookmark.db}</span>}
        </p>
      )}
      <div className="max-h-20 overflow-hidden">
        <SqlView text={bookmark.sql} product={product} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button className="h-7 px-2 text-xs" onClick={() => onRun(bookmark.sql, bookmark.db)}>
          <Play size={12} aria-hidden />
          {t('sql.history.run')}
        </Button>
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => onEdit(bookmark.sql, bookmark.db)}
        >
          <SquarePen size={12} aria-hidden />
          {t('sql.history.edit')}
        </Button>
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setRenaming((v) => !v)}>
          <Pencil size={12} aria-hidden />
          {t('sql.bookmark.rename')}
        </Button>
        {confirmDelete ? (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs text-negative"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            onBlur={() => setConfirmDelete(false)}
            autoFocus
          >
            <Trash2 size={12} aria-hidden />
            {t('sql.history.deleteConfirm')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={12} aria-hidden />
            {t('sql.history.delete')}
          </Button>
        )}
      </div>
    </li>
  )
}

/** Bookmarks of this target. Fetched only while the drawer shows it (lazy), never at page load. */
export function BookmarksPanel({
  product,
  onRun,
  onEdit,
}: {
  product?: Product
  onRun: (sql: string, db: string | null) => void
  onEdit: (sql: string, db: string | null) => void
}) {
  const q = useQuery({
    queryKey: bookmarkKeys.all,
    queryFn: () => listBookmarks(),
    staleTime: 0,
  })
  const items = pickList<Bookmark>(q.data, 'bookmarks')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isSessionOnly(q.data) && (
        <div className="px-4 pb-2">
          <Notice tone="neutral">{t('sql.sessionOnly')}</Notice>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={q.isPending}>
        {q.isPending ? (
          <div className="flex flex-col gap-3 px-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 rounded bg-active" />
            ))}
          </div>
        ) : q.isError ? (
          <p className="px-4 text-sm text-muted">
            {t('sql.bookmark.error')}{' '}
            <button type="button" className="text-ink underline" onClick={() => void q.refetch()}>
              {t('table.retry')}
            </button>
          </p>
        ) : items.length === 0 ? (
          <p className="px-4 text-sm text-muted">{t('sql.bookmark.empty')}</p>
        ) : (
          <ul>
            {items.map((b) => (
              <Row key={b.id} bookmark={b} product={product} onRun={onRun} onEdit={onEdit} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
