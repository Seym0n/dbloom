import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight,
  Database,
  Eraser,
  Eye,
  PencilLine,
  Plus,
  Table2,
  Terminal,
  Trash2,
  Wrench,
} from 'lucide-react'
import { ActionsMenu, type MenuItem } from '~/components/ui/menu'
import type { StructureAction } from '~/components/structure/db-dialogs'
import { getDatabases, getTables } from '~/server/browse.functions'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

export type OpenTable = { db: string; table: string }

export type SqlHandlers = {
  /** Opens a new SQL tab, on this database when one is given. */
  onNew: (db?: string) => void
}

export type StructureHandlers = {
  /** True when the session cannot change structure: every action is shown disabled with the reason. */
  readOnly: boolean
  onAction: (action: StructureAction) => void
  onNewTable: (db: string) => void
  onDesign: (target: OpenTable) => void
}

/** Row with a trailing slot that appears on hover, on focus within, and always on touch screens. */
function Row({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="group/row relative flex items-center">
      {children}
      {actions && (
        <div className="absolute right-1 flex items-center gap-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100">
          {actions}
        </div>
      )}
    </div>
  )
}

function TableList({
  db,
  active,
  onOpen,
  structure,
  writable,
}: {
  db: string
  active: OpenTable | undefined
  onOpen: (t: OpenTable) => void
  structure: StructureHandlers
  writable: boolean
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['tables', db],
    queryFn: () => getTables({ data: { db } }),
  })
  if (isPending) return <div className="mx-2 my-1 h-5 w-24 rounded bg-active" aria-hidden />
  if (isError) return <p className="px-9 py-1 text-xs text-negative">{t('table.error')}</p>
  if (data.length === 0) return <p className="px-9 py-1 text-xs text-faint">{t('nav.noTables')}</p>
  const reason = structure.readOnly ? t('structure.readOnly') : undefined
  return (
    <ul className="mt-0.5 flex flex-col gap-px">
      {data.map((tbl) => {
        const isActive = active?.db === db && active.table === tbl.name
        const isView = tbl.kind === 'view'
        const Icon = isView ? Eye : Table2
        const target = { db, table: tbl.name }
        const items: MenuItem[] = [
          ...(isView
            ? []
            : [
                {
                  key: 'design',
                  label: t('structure.menu.design'),
                  icon: <Wrench size={14} strokeWidth={1.5} />,
                  onSelect: () => structure.onDesign(target),
                },
              ]),
          {
            key: 'rename',
            label: t('structure.menu.rename'),
            icon: <PencilLine size={14} strokeWidth={1.5} />,
            onSelect: () => structure.onAction({ type: 'renameTable', ...target, view: isView }),
            disabled: structure.readOnly,
            reason,
          },
          ...(isView
            ? []
            : [
                {
                  key: 'truncate',
                  label: t('structure.menu.truncate'),
                  icon: <Eraser size={14} strokeWidth={1.5} />,
                  onSelect: () => structure.onAction({ type: 'truncateTable', ...target }),
                  disabled: structure.readOnly,
                  reason,
                  danger: true,
                },
              ]),
          {
            key: 'drop',
            label: t(isView ? 'structure.menu.dropView' : 'structure.menu.dropTable'),
            icon: <Trash2 size={14} strokeWidth={1.5} />,
            onSelect: () => structure.onAction({ type: 'dropTable', ...target, view: isView }),
            disabled: structure.readOnly,
            reason,
            danger: true,
          },
        ]
        return (
          <li key={tbl.name}>
            <Row
              actions={
                writable ? (
                  <ActionsMenu
                    label={t('structure.menu.table', { name: tbl.name })}
                    items={items}
                  />
                ) : undefined
              }
            >
              <button
                type="button"
                onClick={() => onOpen(target)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'press flex h-8 w-full items-center gap-2 rounded-lg pr-8 pl-9 text-left text-sm pointer-coarse:h-11',
                  isActive ? 'bg-active text-ink' : 'text-muted hover:bg-active/60 hover:text-ink',
                )}
              >
                <Icon size={14} strokeWidth={1.5} aria-hidden className="shrink-0" />
                <span className="truncate">{tbl.name}</span>
              </button>
            </Row>
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
  structure,
  reveal,
  sql,
}: {
  name: string
  active: OpenTable | undefined
  onOpen: (t: OpenTable) => void
  structure: StructureHandlers
  reveal: string | undefined
  sql?: SqlHandlers
}) {
  const [open, setOpen] = useState(active?.db === name)
  const system = SYSTEM_SCHEMAS.has(name.toLowerCase())

  useEffect(() => {
    if (reveal === name) setOpen(true)
  }, [reveal, name])

  const reason = structure.readOnly ? t('structure.readOnly') : undefined
  const items: MenuItem[] = [
    {
      key: 'new-table',
      label: t('structure.menu.newTable'),
      icon: <Plus size={14} strokeWidth={1.5} />,
      onSelect: () => structure.onNewTable(name),
      disabled: structure.readOnly,
      reason,
    },
    {
      key: 'drop-db',
      label: t('structure.menu.dropDatabase'),
      icon: <Trash2 size={14} strokeWidth={1.5} />,
      onSelect: () => structure.onAction({ type: 'dropDatabase', db: name }),
      disabled: structure.readOnly,
      reason,
      danger: true,
    },
  ]

  return (
    <li>
      <Row
        actions={
          <>
            {sql && (
              <button
                type="button"
                aria-label={t('sql.menu.newIn', { name })}
                title={t('sql.menu.newIn', { name })}
                onClick={() => sql.onNew(name)}
                className="press grid h-6 w-6 place-items-center rounded text-faint hover:bg-active hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9"
              >
                <Terminal size={14} aria-hidden />
              </button>
            )}
            {!system && (
              <>
                <button
                  type="button"
                  aria-label={t('structure.menu.newTableIn', { name })}
                  aria-disabled={structure.readOnly || undefined}
                  title={reason}
                  onClick={() => !structure.readOnly && structure.onNewTable(name)}
                  className="press grid h-6 w-6 place-items-center rounded text-faint hover:bg-active hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9"
                >
                  <Plus size={14} aria-hidden />
                </button>
                <ActionsMenu label={t('structure.menu.database', { name })} items={items} />
              </>
            )}
          </>
        }
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'press flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 text-left text-sm text-ink hover:bg-active/60 pointer-coarse:h-11',
            system ? (sql ? 'pr-9' : 'pr-2') : sql ? 'pr-24' : 'pr-16',
          )}
        >
          <ChevronRight
            size={14}
            strokeWidth={1.5}
            aria-hidden
            className={cn(
              'shrink-0 text-faint transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          <Database size={14} strokeWidth={1.5} aria-hidden className="shrink-0 text-muted" />
          <span className="truncate">{name}</span>
        </button>
      </Row>
      {open && (
        <TableList
          db={name}
          active={active}
          onOpen={onOpen}
          structure={structure}
          writable={!system}
        />
      )}
    </li>
  )
}

export function SidebarTree({
  active,
  onOpen,
  structure,
  reveal,
  sql,
}: {
  active: OpenTable | undefined
  onOpen: (t: OpenTable) => void
  structure: StructureHandlers
  reveal?: string
  sql?: SqlHandlers
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
        <div className="flex items-center justify-between pr-1">
          <h2 className="px-2 pb-1 text-xs text-faint">{t('nav.databases')}</h2>
          {sql && (
            <button
              type="button"
              onClick={() => sql.onNew()}
              className="press -mt-0.5 mr-auto flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted hover:bg-active hover:text-ink pointer-coarse:h-9"
            >
              <Terminal size={12} aria-hidden />
              {t('sql.menu.new')}
            </button>
          )}
          <button
            type="button"
            aria-disabled={structure.readOnly || undefined}
            title={structure.readOnly ? t('structure.readOnly') : undefined}
            onClick={() => !structure.readOnly && structure.onAction({ type: 'createDatabase' })}
            className="press -mt-0.5 flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted hover:bg-active hover:text-ink aria-disabled:cursor-not-allowed pointer-coarse:h-9"
          >
            <Plus size={12} aria-hidden />
            {t('structure.menu.newDatabase')}
          </button>
        </div>
        {structure.readOnly && (
          <p className="px-2 pb-1 text-xs text-muted">{t('structure.readOnly')}</p>
        )}
        <ul className="flex flex-col gap-px">
          {user.map((d) => (
            <DatabaseRow
              key={d.name}
              name={d.name}
              active={active}
              onOpen={onOpen}
              structure={structure}
              reveal={reveal}
              sql={sql}
            />
          ))}
        </ul>
      </div>
      {system.length > 0 && (
        <div>
          <h2 className="px-2 pb-1 text-xs text-faint">{t('nav.system')}</h2>
          <ul className="flex flex-col gap-px">
            {system.map((d) => (
              <DatabaseRow
                key={d.name}
                name={d.name}
                active={active}
                onOpen={onOpen}
                structure={structure}
                reveal={reveal}
                sql={sql}
              />
            ))}
          </ul>
        </div>
      )}
    </nav>
  )
}
