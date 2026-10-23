import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BookmarkPlus, Play, SquarePen, Trash2, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { setSessionEnded } from '~/lib/session-state'
import type { HistoryEntry } from '~/server/sql/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { BookmarksPanel } from './bookmarks'
import { describeSqlError } from './errors'
import { SqlView, type Product } from './editor'
import { formatDuration, isSessionOnly } from './helpers'
import { Notice, Pill } from './parts'
import { deleteHistory, listHistory } from './server-api'

export type DrawerTab = 'history' | 'bookmarks'

const historyKey = (generated: boolean, query: string) =>
  ['sql', 'history', generated, query] as const
const time = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium' })

function Outcome({ value }: { value: HistoryEntry['outcome'] }) {
  const tone = value === 'ok' ? 'neutral' : value === 'failed' ? 'negative' : 'warning'
  return <Pill tone={tone}>{t(`sql.history.outcome.${value}`)}</Pill>
}

function Entry({
  entry,
  product,
  onRun,
  onEdit,
  onBookmark,
  onDeleted,
}: {
  entry: HistoryEntry
  product?: Product
  onRun: (sql: string, db: string | null) => void
  onEdit: (sql: string, db: string | null) => void
  onBookmark: (sql: string, db: string | null) => void
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteHistory({ data: { ids: [entry.id] } }),
    onSuccess: onDeleted,
    onError: (e) => {
      if (describeSqlError(e).sessionEnded) setSessionEnded(true)
    },
  })
  const sql = entry.sql
  const first = sql?.split('\n').find((l) => l.trim() !== '') ?? ''
  const summary =
    entry.failedIndex !== null
      ? t('sql.history.failedAt', { n: entry.failedIndex + 1, done: entry.executed })
      : t('sql.history.statements', { count: entry.statements })

  return (
    <li className="flex flex-col gap-2 border-b border-rule px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <time className="text-xs text-muted" dateTime={new Date(entry.createdAt).toISOString()}>
          {time.format(entry.createdAt)}
        </time>
        <Outcome value={entry.outcome} />
        {entry.db && <span className="text-xs text-muted">{entry.db}</span>}
        <span className="ml-auto text-xs text-muted">{formatDuration(entry.durationMs)}</span>
      </div>
      {sql === null ? (
        <p className="text-sm text-muted">{t('sql.history.omitted')}</p>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="press min-w-0 rounded text-left"
        >
          {open ? (
            <div className="max-h-48 overflow-auto">
              <SqlView text={sql} product={product} />
            </div>
          ) : (
            <span className="block truncate font-mono text-xs text-ink">{first}</span>
          )}
        </button>
      )}
      <p className="text-xs text-muted">{summary}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          className="h-7 px-2 text-xs"
          disabled={sql === null}
          onClick={() => sql && onRun(sql, entry.db)}
        >
          <Play size={12} aria-hidden />
          {t('sql.history.run')}
        </Button>
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={sql === null}
          onClick={() => sql && onEdit(sql, entry.db)}
        >
          <SquarePen size={12} aria-hidden />
          {t('sql.history.edit')}
        </Button>
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={sql === null}
          onClick={() => sql && onBookmark(sql, entry.db)}
        >
          <BookmarkPlus size={12} aria-hidden />
          {t('sql.history.bookmark')}
        </Button>
        {confirm ? (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs text-negative"
            disabled={remove.isPending}
            autoFocus
            onClick={() => remove.mutate()}
            onBlur={() => setConfirm(false)}
          >
            <Trash2 size={12} aria-hidden />
            {t('sql.history.deleteConfirm')}
          </Button>
        ) : (
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirm(true)}>
            <Trash2 size={12} aria-hidden />
            {t('sql.history.delete')}
          </Button>
        )}
      </div>
    </li>
  )
}

function HistoryPanel({
  product,
  onRun,
  onEdit,
  onBookmark,
}: {
  product?: Product
  onRun: (sql: string, db: string | null) => void
  onEdit: (sql: string, db: string | null) => void
  onBookmark: (sql: string, db: string | null) => void
}) {
  const queryClient = useQueryClient()
  const [generated, setGenerated] = useState(false)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [confirmAll, setConfirmAll] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250)
    return () => clearTimeout(id)
  }, [text])

  const q = useInfiniteQuery({
    queryKey: historyKey(generated, query),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      listHistory({
        data: {
          limit: 50,
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
          ...(generated ? {} : { source: 'user' as const }),
          ...(query ? { query } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  })
  const clear = useMutation({
    mutationFn: () => deleteHistory({ data: { all: true } }),
    onSuccess: () => {
      setConfirmAll(false)
      void queryClient.invalidateQueries({ queryKey: ['sql', 'history'] })
    },
  })
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? []
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['sql', 'history'] })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-col gap-2 px-4">
        <Input
          type="search"
          aria-label={t('sql.history.search')}
          placeholder={t('sql.history.search')}
          className="h-8"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-muted">
          <Checkbox checked={generated} onChange={(e) => setGenerated(e.target.checked)} />
          {t('sql.history.showGenerated')}
        </label>
        {isSessionOnly(q.data?.pages[0]) && <Notice tone="neutral">{t('sql.sessionOnly')}</Notice>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={q.isPending}>
        {q.isPending ? (
          <div className="flex flex-col gap-3 px-4" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded bg-active" />
            ))}
          </div>
        ) : q.isError ? (
          <p className="px-4 text-sm text-muted">
            {t('sql.history.error')}{' '}
            <button type="button" className="text-ink underline" onClick={() => void q.refetch()}>
              {t('table.retry')}
            </button>
          </p>
        ) : entries.length === 0 ? (
          <p className="px-4 text-sm text-muted">
            {query ? t('sql.history.noMatch') : t('sql.history.empty')}
          </p>
        ) : (
          <>
            <ul>
              {entries.map((e) => (
                <Entry
                  key={e.id}
                  entry={e}
                  product={product}
                  onRun={onRun}
                  onEdit={onEdit}
                  onBookmark={onBookmark}
                  onDeleted={refresh}
                />
              ))}
            </ul>
            {q.hasNextPage && (
              <div className="p-4">
                <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  {t('sql.history.more')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {entries.length > 0 && (
        <div className="border-t border-rule px-4 py-2">
          {confirmAll ? (
            <div className="flex items-center gap-2">
              <Button
                className="border-negative text-negative"
                disabled={clear.isPending}
                autoFocus
                onClick={() => clear.mutate()}
              >
                {t('sql.history.clearConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmAll(false)}>
                {t('sql.bookmark.cancel')}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmAll(true)}>
              {t('sql.history.clear')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Right-hand drawer with History and Bookmarks. Its content mounts only while it is open, so nothing is
 * fetched at page load or before the user asks (NFR-ISS-105). On a phone it covers the tab.
 */
export function HistoryDrawer({
  tab,
  onTab,
  onClose,
  product,
  onRun,
  onEdit,
  onBookmark,
}: {
  tab: DrawerTab
  onTab: (t: DrawerTab) => void
  onClose: () => void
  product?: Product
  onRun: (sql: string, db: string | null) => void
  onEdit: (sql: string, db: string | null) => void
  onBookmark: (sql: string, db: string | null) => void
}) {
  const asideRef = useRef<HTMLElement>(null)
  useEffect(() => asideRef.current?.focus(), [])
  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      aria-label={t('sql.drawer.label')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
      className="absolute inset-0 z-20 flex flex-col gap-2 bg-surface pt-2 md:static md:inset-auto md:z-auto md:w-[360px] md:shrink-0 md:border-l md:border-border"
    >
      <div className="flex items-center gap-1 px-3">
        <div role="tablist" aria-label={t('sql.drawer.label')} className="flex gap-1">
          {(['history', 'bookmarks'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={tab === k}
              onClick={() => onTab(k)}
              className={cn(
                'press h-8 rounded-[var(--radius-control)] px-3 text-sm pointer-coarse:h-11',
                tab === k
                  ? 'bg-active font-medium text-ink'
                  : 'text-muted hover:bg-active/60 hover:text-ink',
              )}
            >
              {t(k === 'history' ? 'sql.drawer.history' : 'sql.drawer.bookmarks')}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={t('sql.drawer.close')}
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
      {tab === 'history' ? (
        <HistoryPanel product={product} onRun={onRun} onEdit={onEdit} onBookmark={onBookmark} />
      ) : (
        <BookmarksPanel product={product} onRun={onRun} onEdit={onEdit} />
      )}
    </aside>
  )
}
