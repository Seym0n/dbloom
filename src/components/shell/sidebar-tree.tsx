import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Database, Eye, Table2 } from 'lucide-react'
import { getDatabases, getTables } from '~/server/browse.functions'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export type OpenTable = { db: string; table: string }

function TableList({
  db,
  active,
  onOpen,
}: {
  db: string
  active: OpenTable | undefined
  onOpen: (t: OpenTable) => void
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['tables', db],
    queryFn: () => getTables({ data: { db } }),
  })
  if (isPending) return <div className="mx-2 my-1 h-5 w-24 rounded bg-active" aria-hidden />
  if (isError) return <p className="px-9 py-1 text-xs text-negative">{t('table.error')}</p>
  if (data.length === 0) return <p className="px-9 py-1 text-xs text-faint">{t('nav.noTables')}</p>
  return (
    <ul className="mt-0.5 flex flex-col gap-px">
      {data.map((tbl) => {
        const isActive = active?.db === db && active.table === tbl.name
        const Icon = tbl.kind === 'view' ? Eye : Table2
        return (
          <li key={tbl.name}>
            <button
              type="button"
              onClick={() => onOpen({ db, table: tbl.name })}
              aria-current={isActive ? 'true' : undefined}
              className={cn(
                'press flex h-8 w-full items-center gap-2 rounded-lg pr-2 pl-9 text-left text-sm',
                isActive ? 'bg-active text-ink' : 'text-muted hover:bg-active/60 hover:text-ink',
              )}
            >
              <Icon size={14} strokeWidth={1.5} aria-hidden className="shrink-0" />
              <span className="truncate">{tbl.name}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function DatabaseRow({
  name,
  active,
  onOpen,
}: {
  name: string
  active: OpenTable | undefined
  onOpen: (t: OpenTable) => void
}) {
  const [open, setOpen] = useState(active?.db === name)
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press flex h-8 w-full items-center gap-1.5 rounded-lg pr-2 pl-2 text-left text-sm text-ink hover:bg-active/60"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          aria-hidden
          className={cn('shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
        <Database size={14} strokeWidth={1.5} aria-hidden className="shrink-0 text-muted" />
        <span className="truncate">{name}</span>
      </button>
      {open && <TableList db={name} active={active} onOpen={onOpen} />}
    </li>
  )
}

export function SidebarTree({
  active,
  onOpen,
}: {
  active: OpenTable | undefined
  onOpen: (t: OpenTable) => void
}) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['databases'],
    queryFn: () => getDatabases(),
  })
  if (isPending) {
    return (
      <div className="flex flex-col gap-2 px-2" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-5 rounded bg-active" style={{ width: `${70 - i * 8}%` }} />
        ))}
      </div>
    )
  }
  if (isError) {
    return (
      <p className="px-2 text-sm text-muted">
        {t('table.error')}{' '}
        <button type="button" className="text-ink underline" onClick={() => void refetch()}>
          {t('table.retry')}
        </button>
      </p>
    )
  }
  const user = data.filter((d) => !SYSTEM_SCHEMAS.has(d.name.toLowerCase()))
  const system = data.filter((d) => SYSTEM_SCHEMAS.has(d.name.toLowerCase()))
  return (
    <nav aria-label={t('nav.databases')} className="flex flex-col gap-4">
      <div>
        <h2 className="px-2 pb-1 text-xs text-faint">{t('nav.databases')}</h2>
        <ul className="flex flex-col gap-px">
          {user.map((d) => (
            <DatabaseRow key={d.name} name={d.name} active={active} onOpen={onOpen} />
          ))}
        </ul>
      </div>
      {system.length > 0 && (
        <div>
          <h2 className="px-2 pb-1 text-xs text-faint">{t('nav.system')}</h2>
          <ul className="flex flex-col gap-px">
            {system.map((d) => (
              <DatabaseRow key={d.name} name={d.name} active={active} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}
    </nav>
  )
}
