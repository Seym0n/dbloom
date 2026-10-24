/**
 * Foreign key value picker (FR-ROW-014, UI-DTB-010, UI-ISS-110, DATA-ISS-012): a combobox with server-side
 * search over display value and key, paged by 50, a "Browse..." dialog for big tables, and "Create new row...".
 * It never resets a stored value that has no match: the value stays and is shown as "not found".
 *
 * Key records exchanged with `lookup` are keyed by the column names of the REFERENCED table.
 */
import { useContext, useEffect, useId, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import type { FkInfo, LookupOption } from '~/server/rows/types'
import { RowFormContext } from './form-core'
import { describeRowsRefusal, formsApi } from './server-api-forms'

export const LOOKUP_PAGE_SIZE = 50

const keyText = (key: Record<string, string | null>, fk: FkInfo) =>
  fk.refColumns.map((c) => key[c] ?? 'NULL').join(', ')

export function optionLabel(option: LookupOption, fk: FkInfo): string {
  const key = keyText(option.key, fk)
  return option.display && option.display !== key ? `${option.display} (${key})` : key
}

type LookupState = {
  options: LookupOption[]
  hasNext: boolean
  loading: boolean
  error: string | null
}

/** Searches the referenced table (debounced). One request per query and page, never one per cell. */
function useLookup(fk: FkInfo, query: string, page: number, enabled: boolean): LookupState {
  const ctx = useContext(RowFormContext)
  const [state, setState] = useState<LookupState>({
    options: [],
    hasNext: false,
    loading: false,
    error: null,
  })
  useEffect(() => {
    if (!enabled) return
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    const timer = setTimeout(
      () => {
        formsApi()
          .lookup({ db: ctx.db, table: ctx.table, fk: fk.name, query: query || undefined, page })
          .then(
            (r) =>
              live &&
              setState({ options: r.options, hasNext: r.hasNext, loading: false, error: null }),
          )
          .catch(
            (e: unknown) =>
              live &&
              setState({
                options: [],
                hasNext: false,
                loading: false,
                error: describeRowsRefusal(e).message,
              }),
          )
      },
      query ? 250 : 0,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [enabled, ctx.db, ctx.table, fk.name, query, page])
  return state
}

/** Search box, result list and pager. Used inline (a combobox) and in the browse dialog. */
function LookupList({
  fk,
  onPick,
  autoFocus,
  listClassName,
  label,
}: {
  fk: FkInfo
  onPick: (option: LookupOption) => void
  autoFocus?: boolean
  listClassName?: string
  label: string
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [active, setActive] = useState(-1)
  const lookup = useLookup(fk, query, page, true)
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="relative">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <Input
          role="combobox"
          aria-label={label}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          className="pl-9"
          placeholder={t('rows.fk.search')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0)
            setActive(-1)
          }}
          onKeyDown={(e) => {
            const last = lookup.options.length - 1
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => (i >= last ? 0 : i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i <= 0 ? last : i - 1))
            } else if (e.key === 'Enter') {
              const option = lookup.options[active]
              if (option) {
                e.preventDefault()
                onPick(option)
              }
            }
          }}
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        aria-busy={lookup.loading}
        className={cn(
          'max-h-52 overflow-y-auto rounded-[var(--radius-control)] bg-raised py-1',
          listClassName,
        )}
      >
        {lookup.options.map((o, i) => (
          <li
            key={JSON.stringify(o.key)}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={cn(
              'cursor-pointer px-3 py-2 text-sm break-words hover:bg-active',
              i === active && 'bg-active',
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o)}
          >
            {optionLabel(o, fk)}
          </li>
        ))}
        {!lookup.loading && !lookup.error && lookup.options.length === 0 && (
          <li role="presentation" className="px-3 py-2 text-sm text-muted">
            {t('rows.fk.noMatch')}
          </li>
        )}
        {lookup.loading && (
          <li role="presentation" className="px-3 py-2 text-sm text-muted">
            {t('rows.fk.loading')}
          </li>
        )}
      </ul>
      {lookup.error && (
        <p role="alert" className="text-xs text-negative">
          {lookup.error}
        </p>
      )}
      {(page > 0 || lookup.hasNext) && (
        <div className="flex items-center justify-between gap-2">
          <Button disabled={page === 0 || lookup.loading} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={14} aria-hidden />
            {t('rows.fk.previous')}
          </Button>
          <span className="text-xs text-muted">{t('rows.fk.page', { page: page + 1 })}</span>
          <Button
            disabled={!lookup.hasNext || lookup.loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('rows.fk.next')}
            <ChevronRight size={14} aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )
}

/** Display value of the stored key, or "not found" (DATA-ISS-012); the stored value is never touched. */
function useResolved(fk: FkInfo, keys: (string | null)[]): 'idle' | 'loading' | 'missing' | string {
  const ctx = useContext(RowFormContext)
  const [state, setState] = useState<'idle' | 'loading' | 'missing' | string>('idle')
  const signature = JSON.stringify(keys)
  useEffect(() => {
    if (keys.length === 0 || keys.some((k) => k === null || k === '')) {
      setState('idle')
      return
    }
    let live = true
    setState('loading')
    const key = Object.fromEntries(
      fk.refColumns.map((c, i) => [c, { t: 'v' as const, v: keys[i] ?? '' }]),
    )
    const timer = setTimeout(() => {
      formsApi()
        .lookup({ db: ctx.db, table: ctx.table, fk: fk.name, page: 0, keys: [key] })
        .then((r) => {
          if (!live) return
          const hit = r.options[0]
          setState(hit ? hit.display || 'found' : 'missing')
        })
        .catch(() => live && setState('idle'))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // `signature` stands for `keys`.
  }, [signature, fk.name, fk.refColumns, ctx.db, ctx.table])
  return state
}

/**
 * Body of the editor of a foreign key column (value mode). `keys` align with `fk.columns`; a single-column
 * key can also be typed, a composite key is changed only through the picker so its columns stay together.
 */
export function FkBody({
  fk,
  keys,
  onPick,
  onType,
  disabled,
  labelId,
  describedById,
  invalid,
}: {
  fk: FkInfo
  keys: (string | null)[]
  onPick: (keys: (string | null)[]) => void
  /** Single-column keys only: the typed text. */
  onType?: (text: string) => void
  disabled?: boolean
  labelId: string
  describedById?: string
  invalid?: boolean
}) {
  const ctx = useContext(RowFormContext)
  const [open, setOpen] = useState(false)
  const [browse, setBrowse] = useState(false)
  const [creating, setCreating] = useState(false)
  const findId = `${useId()}-find`
  const focusFind = () => document.getElementById(findId)?.focus()
  const resolved = useResolved(fk, keys)
  const dialogTitle = useId()
  const refName = fk.refTable

  function pick(option: LookupOption) {
    onPick(fk.refColumns.map((c) => option.key[c] ?? null))
    setOpen(false)
    setBrowse(false)
    focusFind()
  }

  async function create() {
    if (!ctx.createReferenced) return
    setCreating(true)
    try {
      const key = await ctx.createReferenced(fk)
      if (key) onPick(fk.refColumns.map((c) => key[c] ?? null))
    } finally {
      setCreating(false)
      setOpen(false)
    }
  }

  const single = fk.columns.length === 1
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
          focusFind()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {single && onType ? (
          <Input
            id={`${labelId}-in`}
            aria-labelledby={labelId}
            aria-describedby={describedById}
            aria-invalid={invalid}
            className="max-w-72 flex-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={keys[0] ?? ''}
            onChange={(e) => onType(e.target.value)}
          />
        ) : (
          <p id={`${labelId}-in`} className="min-h-10 flex-1 text-sm break-words">
            {fk.columns.map((c, i) => (
              <span key={c} className="mr-3 inline-block">
                <span className="text-muted">{c} </span>
                <span className="font-mono">{keys[i] ?? 'NULL'}</span>
              </span>
            ))}
          </p>
        )}
        <Button
          id={findId}
          disabled={disabled}
          aria-expanded={open}
          aria-label={t('rows.fk.findIn', { table: refName })}
          onClick={() => setOpen((o) => !o)}
        >
          <Search size={14} aria-hidden />
          {t('rows.fk.find')}
        </Button>
      </div>
      <p className="text-xs" role="status">
        {resolved === 'loading' && <span className="text-muted">{t('rows.fk.loading')}</span>}
        {resolved === 'missing' && (
          <span className="text-[var(--pill-warning-ink)]">
            {t('rows.fk.notFound', { table: refName })}
          </span>
        )}
        {resolved !== 'idle' &&
          resolved !== 'loading' &&
          resolved !== 'missing' &&
          resolved !== 'found' && (
            <span className="text-muted">
              {t('rows.fk.display', { value: resolved, table: refName })}
            </span>
          )}
      </p>
      {open && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-raised p-3">
          <LookupList
            fk={fk}
            onPick={pick}
            autoFocus
            label={t('rows.fk.searchIn', { table: refName })}
            listClassName="bg-surface"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setBrowse(true)}>{t('rows.fk.browse')}</Button>
            {ctx.createReferenced && (
              <Button disabled={creating || disabled} onClick={() => void create()}>
                <Plus size={14} aria-hidden />
                {t('rows.fk.create')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('rows.fk.close')}
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={browse}
        onClose={() => setBrowse(false)}
        labelledBy={dialogTitle}
        className="w-[min(640px,calc(100vw-32px))]"
      >
        <div className="flex max-h-[calc(100dvh-32px)] flex-col">
          <header className="shrink-0 px-6 pt-5 pb-3">
            <h2 id={dialogTitle} className="text-base font-semibold">
              {t('rows.fk.browseTitle', { table: refName })}
            </h2>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
            <LookupList
              fk={fk}
              onPick={pick}
              autoFocus
              label={t('rows.fk.searchIn', { table: refName })}
              listClassName="max-h-[50dvh]"
            />
          </div>
          <footer className="flex shrink-0 justify-end gap-2 bg-raised px-6 py-3">
            <Button onClick={() => setBrowse(false)}>{t('rows.fk.close')}</Button>
          </footer>
        </div>
      </Dialog>
    </div>
  )
}
