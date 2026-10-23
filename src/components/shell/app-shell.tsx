import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { LogOut, Menu, MessageSquare, X } from 'lucide-react'
import { BrandName } from '~/components/brand'
import { TableView } from '~/components/grid/table-view'
import { SessionEndedDialog } from '~/components/session-ended-dialog'
import { StructureDialogs, type StructureAction } from '~/components/structure/db-dialogs'
import { TableDesigner } from '~/components/structure/table-designer'
import { Button } from '~/components/ui/button'
import { setCsrfToken } from '~/lib/csrf'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { getDatabases } from '~/server/browse.functions'
import { logout } from '~/server/session.functions'
import type { ExecuteResult, PreviewInput } from '~/server/structure/types'
import { SidebarTree, type OpenTable } from './sidebar-tree'

export type SessionInfo = {
  csrf: string
  target: { host: string; port: number; username: string }
  /** True when the session is read-only; structure actions are then shown disabled with the reason. */
  readOnly?: boolean
}

/** A table grid, the designer of an existing table, or the designer of a table that does not exist yet. */
type ShellTab = {
  id: string
  kind: 'table' | 'designer'
  db: string
  /** Absent for a new table. */
  table?: string
}

const SEP = '\u0000'
const tableTab = (db: string, table: string): ShellTab => ({
  id: `t${SEP}${db}${SEP}${table}`,
  kind: 'table',
  db,
  table,
})
const designTab = (db: string, table: string): ShellTab => ({
  id: `d${SEP}${db}${SEP}${table}`,
  kind: 'designer',
  db,
  table,
})
const tabLabel = (tab: ShellTab) =>
  tab.kind === 'table'
    ? (tab.table as string)
    : tab.table
      ? t('structure.tab.design', { name: tab.table })
      : t('structure.tab.new')
const targetLabel = (s: SessionInfo['target']) => `${s.host}:${s.port}`

function AssistantPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside
      aria-labelledby="assistant-title"
      className="fixed inset-0 z-30 flex flex-col bg-surface md:static md:z-auto md:w-[var(--assistant-width)] md:shrink-0 md:border-l md:border-border"
    >
      <div className="flex h-12 items-center justify-between px-5">
        <h2 id="assistant-title" className="text-base font-semibold">
          {t('assistant.title')}
        </h2>
        <Button variant="ghost" size="icon" aria-label={t('assistant.close')} onClick={onClose}>
          <X size={16} aria-hidden />
        </Button>
      </div>
      <p className="px-5 text-sm text-muted">{t('assistant.body')}</p>
      <div className="mt-auto p-5">
        <input
          disabled
          aria-label={t('assistant.input')}
          placeholder={t('assistant.input')}
          className="h-10 w-full rounded-[var(--radius-control)] border border-control bg-raised px-3 text-sm placeholder:text-faint"
        />
      </div>
    </aside>
  )
}

export function AppShell({ session }: { session: SessionInfo }) {
  // The CSRF token lives in memory only; set while rendering so the first requests already carry it.
  if (typeof window !== 'undefined') setCsrfToken(session.csrf)

  const router = useRouter()
  const queryClient = useQueryClient()
  const [tabs, setTabs] = useState<ShellTab[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>()
  const [action, setAction] = useState<StructureAction | null>(null)
  const [reveal, setReveal] = useState<string | undefined>()
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const newTabs = useRef(0)
  const readOnly = Boolean(session.readOnly)

  const active = tabs.find((tab) => tab.id === activeKey)
  const activeTable: OpenTable | undefined =
    active && active.table ? { db: active.db, table: active.table } : undefined
  const databases = useQuery({ queryKey: ['databases'], queryFn: () => getDatabases() })

  // The sidebar opens a freshly created database once, then forgets the request.
  useEffect(() => {
    if (reveal) setReveal(undefined)
  }, [reveal])

  function open(tab: ShellTab) {
    setTabs((current) => (current.some((c) => c.id === tab.id) ? current : [...current, tab]))
    setActiveKey(tab.id)
    setMenuOpen(false)
  }

  function openNewTable(db: string) {
    newTabs.current += 1
    open({ id: `n${SEP}${db}${SEP}${newTabs.current}`, kind: 'designer', db })
  }

  /** Removes the tabs matching `remove`; the selection moves to a neighbour when the active tab went. */
  function closeWhere(remove: (tab: ShellTab) => boolean) {
    const next = tabs.filter((c) => !remove(c))
    setTabs(next)
    const current = tabs.find((c) => c.id === activeKey)
    if (current && remove(current)) {
      const index = tabs.findIndex((c) => c.id === activeKey)
      setActiveKey(next[Math.min(index, next.length - 1)]?.id)
    }
  }

  const close = (tab: ShellTab) => closeWhere((c) => c.id === tab.id)

  /** Tabs follow a change that ran: dropped tables and databases close, a renamed table is renamed. */
  function structureApplied(input: PreviewInput, result: ExecuteResult) {
    if (!result.ok) return
    if (input.action === 'dropTable') {
      closeWhere((c) => c.db === input.db && c.table === input.table)
    } else if (input.action === 'dropDatabase') {
      closeWhere((c) => c.db === input.name)
    } else if (input.action === 'renameTable') {
      if (input.newDb && input.newDb !== input.db) {
        closeWhere((c) => c.db === input.db && c.table === input.table)
        return
      }
      const rename = (tab: ShellTab): ShellTab =>
        tab.db === input.db && tab.table === input.table
          ? tab.kind === 'table'
            ? tableTab(input.db, input.newName)
            : designTab(input.db, input.newName)
          : tab
      const old = tabs.find((c) => c.id === activeKey)
      setTabs(tabs.map(rename))
      if (old) setActiveKey(rename(old).id)
    }
  }

  /** A created table turns its "new table" tab into the designer of the real table. */
  function tableCreated(tab: ShellTab, name: string) {
    const replacement = designTab(tab.db, name)
    setTabs((current) =>
      current.some((c) => c.id === replacement.id)
        ? current.filter((c) => c.id !== tab.id)
        : current.map((c) => (c.id === tab.id ? replacement : c)),
    )
    setActiveKey(replacement.id)
  }

  async function signOut() {
    await logout().catch(() => undefined)
    setCsrfToken(undefined)
    queryClient.clear()
    await router.invalidate()
  }

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[48px_minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]">
      <SessionEndedDialog
        defaults={{ server: targetLabel(session.target), username: session.target.username }}
        onSignedIn={(target) => {
          // Work typed by someone else is not handed to a different sign-in (G3).
          const t0 = session.target
          if (
            target.host !== t0.host ||
            target.port !== t0.port ||
            target.username !== t0.username
          ) {
            setTabs([])
            setActiveKey(undefined)
          }
        }}
      />

      <StructureDialogs
        action={action}
        readOnly={readOnly}
        onClose={() => setAction(null)}
        onApplied={structureApplied}
        onOpenDatabase={setReveal}
      />

      <aside
        className={cn(
          'row-span-2 flex-col gap-4 bg-ground px-3 pb-3',
          'fixed inset-y-0 left-0 z-20 w-[280px] border-r border-border',
          'md:static md:z-auto md:flex md:w-auto md:border-r-0',
          menuOpen ? 'flex' : 'hidden',
        )}
      >
        <div className="flex h-12 shrink-0 items-center px-2">
          <BrandName />
        </div>
        <div className="rounded-lg bg-active/60 px-3 py-2">
          <p className="truncate text-sm font-medium" title={targetLabel(session.target)}>
            {targetLabel(session.target)}
          </p>
          <p className="truncate text-xs text-muted">
            {session.target.username}
            {databases.data ? ` · ${databases.data.length} databases` : ''}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SidebarTree
            active={activeTable}
            onOpen={(tab) => open(tableTab(tab.db, tab.table))}
            reveal={reveal}
            structure={{
              readOnly,
              onAction: (a) => {
                setMenuOpen(false)
                setAction(a)
              },
              onNewTable: openNewTable,
              onDesign: (tab) => open(designTab(tab.db, tab.table)),
            }}
          />
        </div>
        <Button variant="ghost" className="justify-start" onClick={() => void signOut()}>
          <LogOut size={14} strokeWidth={1.5} aria-hidden />
          {t('nav.logout')}
        </Button>
      </aside>

      <header className="col-start-1 row-start-1 flex items-center gap-3 bg-ground px-3 md:col-start-2">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label={t('nav.databases')}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Menu size={16} aria-hidden />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm text-muted">
          {active ? (
            <>
              {targetLabel(session.target)} / {active.db} /{' '}
              <span className="text-ink">{active.table ?? t('structure.tab.new')}</span>
            </>
          ) : (
            targetLabel(session.target)
          )}
        </p>
        <Button
          variant="ghost"
          aria-pressed={assistantOpen}
          onClick={() => setAssistantOpen((v) => !v)}
        >
          <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
          {t('nav.assistant')}
        </Button>
      </header>

      <main className="col-start-1 row-start-2 mr-2 mb-2 ml-2 flex min-h-0 overflow-hidden rounded-[var(--radius-sheet)] border border-border bg-surface md:col-start-2 md:ml-0">
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 && (
            <div
              role="tablist"
              className="flex shrink-0 overflow-x-auto border-b border-border px-3"
            >
              {tabs.map((tab) => {
                const selected = tab.id === activeKey
                return (
                  <div key={tab.id} className="relative flex shrink-0 items-center">
                    <button
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveKey(tab.id)}
                      className={cn(
                        'press h-11 pr-1 pl-3 text-sm',
                        selected ? 'font-semibold text-ink' : 'text-muted hover:text-ink',
                      )}
                    >
                      {tabLabel(tab)}
                    </button>
                    <button
                      aria-label={t('tab.close', { name: tabLabel(tab) })}
                      onClick={() => close(tab)}
                      className="press mr-1 grid h-6 w-6 place-items-center rounded text-faint hover:bg-active hover:text-ink"
                    >
                      <X size={12} aria-hidden />
                    </button>
                    {selected && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-accent" />}
                  </div>
                )
              })}
            </div>
          )}
          {/* Designer tabs stay mounted while hidden, so unsaved edits survive a tab switch. */}
          {tabs
            .filter((tab) => tab.kind === 'designer')
            .map((tab) => (
              <div
                key={tab.id}
                className={cn('min-h-0 flex-1 flex-col', tab.id === activeKey ? 'flex' : 'hidden')}
              >
                <TableDesigner
                  db={tab.db}
                  table={tab.table}
                  readOnly={readOnly}
                  onCreated={(name) => tableCreated(tab, name)}
                />
              </div>
            ))}
          {active?.kind === 'table' && active.table ? (
            <TableView key={active.id} db={active.db} table={active.table} />
          ) : active ? null : (
            <div className="px-6 pt-8">
              <h1 className="mb-2 text-[22px] font-semibold leading-7">{t('empty.title')}</h1>
              <p className="max-w-md text-sm text-muted">{t('empty.body')}</p>
            </div>
          )}
        </div>
        {assistantOpen && <AssistantPanel onClose={() => setAssistantOpen(false)} />}
      </main>
    </div>
  )
}
