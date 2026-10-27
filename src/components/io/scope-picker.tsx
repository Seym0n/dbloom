import { useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'
import { ioCatalog } from '~/lib/io/api'
import { t } from '~/i18n'
import type { ExportTarget } from './export-model'

export type ScopeItem = { name: string; view?: boolean }

/** Databases of the server or tables of one database, from the catalog. Other scopes have no list. */
export function useScopeItems(target: ExportTarget) {
  const key =
    target.kind === 'server'
      ? ['io', 'scope', 'server']
      : ['io', 'scope', 'database', (target as { db?: string }).db]
  const query = useQuery({
    queryKey: key,
    enabled: target.kind === 'server' || target.kind === 'database',
    queryFn: async (): Promise<ScopeItem[]> => {
      if (target.kind === 'server') return (await ioCatalog().databases()).map((name) => ({ name }))
      if (target.kind === 'database')
        return (await ioCatalog().tables(target.db)).map((x) => ({
          name: x.name,
          view: x.kind === 'view',
        }))
      return []
    },
  })
  return query
}

/** Rows shown at most; the rest is reachable through the search (a database can hold 100 000 tables). */
export const PICKER_RENDER_LIMIT = 300

export function filterItems(items: ScopeItem[], query: string): ScopeItem[] {
  const q = query.trim().toLowerCase()
  return q === '' ? items : items.filter((i) => i.name.toLowerCase().includes(q))
}

/** Scope picker with search (FR-IO-026): everything is selected until the user unticks something. */
export function ScopePicker({
  kind,
  items,
  excluded,
  onChange,
  loading,
  failed,
}: {
  kind: 'server' | 'database'
  items: ScopeItem[]
  excluded: string[]
  onChange: (excluded: string[]) => void
  loading?: boolean
  failed?: boolean
}) {
  const [query, setQuery] = useState('')
  const searchId = useId()
  const listId = useId()
  const matches = useMemo(() => filterItems(items, query), [items, query])
  const shown = matches.slice(0, PICKER_RENDER_LIMIT)
  const out = useMemo(() => new Set(excluded), [excluded])
  const selected = items.length - items.filter((i) => out.has(i.name)).length
  const noun = kind === 'server' ? t('io.scope.databases') : t('io.scope.tables')

  const setMany = (names: string[], on: boolean) => {
    const next = new Set(excluded)
    for (const n of names) {
      if (on) next.delete(n)
      else next.add(n)
    }
    onChange([...next])
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor={searchId}>{t('io.scope.search', { what: noun })}</Label>
          <Input
            id={searchId}
            type="search"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          onClick={() =>
            setMany(
              matches.map((m) => m.name),
              true,
            )
          }
        >
          {t('io.scope.all')}
        </Button>
        <Button
          onClick={() =>
            setMany(
              matches.map((m) => m.name),
              false,
            )
          }
        >
          {t('io.scope.none')}
        </Button>
      </div>
      <p className="text-xs text-muted" aria-live="polite">
        {loading
          ? t('io.scope.loading')
          : failed
            ? t('io.scope.failed')
            : selected === 0
              ? t('io.scope.noneSelected')
              : t('io.scope.count', { selected, total: items.length })}
      </p>
      <ul
        id={listId}
        aria-label={noun}
        className="max-h-64 overflow-y-auto rounded-lg border border-border p-1"
      >
        {shown.map((item) => (
          <li key={item.name}>
            <label className="flex min-h-8 items-center gap-2 rounded px-2 text-sm hover:bg-raised pointer-coarse:min-h-11">
              <Checkbox
                checked={!out.has(item.name)}
                onChange={(e) => setMany([item.name], e.target.checked)}
              />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.view && <span className="text-xs text-faint">{t('io.scope.view')}</span>}
            </label>
          </li>
        ))}
        {!loading && matches.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-muted">{t('io.scope.empty')}</li>
        )}
      </ul>
      {matches.length > shown.length && (
        <p className="text-xs text-muted">
          {t('io.scope.more', { shown: shown.length, total: matches.length })}
        </p>
      )}
    </div>
  )
}
