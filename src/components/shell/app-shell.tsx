import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { LogOut, Menu, MessageSquare, Plus, UserRound, X } from 'lucide-react'
import { BrandName } from '~/components/brand'
import { TableView } from '~/components/grid/table-view'
import { ConnectionLost } from '~/components/connection-lost'
import { AssistantHost } from '~/components/assistant/assistant-host'
import { SessionEndedDialog } from '~/components/session-ended-dialog'
import { SqlTab, type SqlTabMeta } from '~/components/sql/sql-tab'
import { getSqlLimits } from '~/components/sql/server-api'
import { DropTarget, UploadStatusPanel } from '~/components/io/drop-overlay'
import { ExportTab } from '~/components/io/export-tab'
import { ImportTab, type UploadedFile } from '~/components/io/import-tab'
import { wireIoCatalog } from '~/components/io/wire'
import { StructureDialogs, type StructureAction } from '~/components/structure/db-dialogs'
import { TableDesigner } from '~/components/structure/table-designer'
import { Button } from '~/components/ui/button'
import { ActionsMenu } from '~/components/ui/menu'
import { Dialog } from '~/components/ui/dialog'
import { setCsrfToken } from '~/lib/csrf'
import { ioApi } from '~/lib/io/api'
import { useUploadQueue } from '~/lib/io/use-uploads'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { getDatabases } from '~/server/browse.functions'
import { logout } from '~/server/session.functions'
import type { ExecuteResult, PreviewInput } from '~/server/structure/types'
import type { OpenSearch } from '~/routes/index'
import type { FilterNode } from '~/server/rows/types'
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
  kind: 'table' | 'designer' | 'sql' | 'io'
  /** The database of the tab; for an SQL tab '' means none. */
  db: string
  /** Running number of an SQL tab, for its title. */
  seq?: number
  /** Text an SQL tab starts with (a bookmark or the assistant's statement); never run by itself. */
  initialText?: string
  /** Absent for a new table. */
  table?: string
  /** A table tab opened from a link: rows whose columns equal these values (FR-ROW-014). */
  key?: [string, string][]
  /** Export or import page (kind `io`); the scope is `db` and `table`, none of them meaning the server. */
  ioMode?: 'export' | 'import'
  /** A file already uploaded by a drop; the import page starts with its analysis. */
  upload?: UploadedFile
  /** An export of one SQL result set (kind `io`, mode export). */
  result?: { db?: string; text: string; statementIndex: number }
}

const SEP = '\u0000'
const tableTab = (db: string, table: string): ShellTab => ({
  id: `t${SEP}${db}${SEP}${table}`,
  kind: 'table',
  db,
  table,
})
/** The key of a link as a filter: every [column, value] pair is an equality, all of them must hold. */
const keyFilter = (key: [string, string][]): FilterNode => ({
  type: 'group',
  op: 'and',
  children: key.map(([column, value]) => ({
    type: 'condition' as const,
    column,
    op: '=' as const,
    values: [value],
  })),
})
const linkedTab = (db: string, table: string, key: [string, string][]): ShellTab => ({
  ...tableTab(db, table),
  id: `t${SEP}${db}${SEP}${table}${SEP}${JSON.stringify(key)}`,
  key,
})
const designTab = (db: string, table: string): ShellTab => ({
  id: `d${SEP}${db}${SEP}${table}`,
  kind: 'designer',
  db,
  table,
})
const ioName = (tab: ShellTab) =>
  tab.result ? t('io.export.resultName') : (tab.table ?? (tab.db || t('io.tab.serverName')))
const tabLabel = (tab: ShellTab) =>
  tab.kind === 'io'
    ? t(tab.ioMode === 'import' ? 'io.tab.import' : 'io.tab.export', { name: ioName(tab) })
    : tab.kind === 'sql'
      ? t('sql.tab.title', { n: tab.seq ?? 1 })
      : tab.kind === 'table'
        ? (tab.table as string)
        : tab.table
          ? t('structure.tab.design', { name: tab.table })
          : t('structure.tab.new')
const targetLabel = (s: SessionInfo['target']) => `${s.host}:${s.port}`

// The io screens read databases, tables and columns through the shell's own server functions.
wireIoCatalog()

const tabButtonId = (id: string) => `tab-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`

export function AppShell({
  session,
  open: link,
  connectionSlot,
  account,
}: {
  session: SessionInfo
  open?: OpenSearch
  /** Account mode: the connection switcher under the server card. Direct mode passes nothing. */
  connectionSlot?: ReactNode
  /** Account mode: sign-out and session-ended lead to the account sign-in, and the shell links to /account. */
  account?: { onSignOut: () => void | Promise<void>; /** Shown in the account menu. */ name?: string }
}) {
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
  const sqlSeq = useRef(0)
  const [sqlMeta, setSqlMeta] = useState<Record<string, SqlTabMeta>>({})
  const [closing, setClosing] = useState<ShellTab | null>(null)
  const ioSeq = useRef(0)
  const ioCaps = useQuery({
    queryKey: ['io', 'caps'],
    queryFn: () => ioApi().getCapabilities(),
    staleTime: 60_000,
    retry: false,
  })
  const ioPrefs = useQuery({
    queryKey: ['io', 'prefs'],
    queryFn: () => ioApi().getPrefs(),
    staleTime: 60_000,
    retry: false,
  })
  const limits = useQuery({
    queryKey: ['sql', 'limits'],
    queryFn: () => getSqlLimits(),
    staleTime: 5 * 60_000,
    retry: false,
  })
  // The SQL entry is hidden only when the server says the tab is switched off (ST-164).
  const sqlEnabled = !(limits.error && /sql_disabled/.test(limits.error.message))
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

  // A link into a table (`/?db=..&table=..&key=..`) opens its tab, once per distinct link.
  const linkKey =
    link?.db && link.table ? JSON.stringify([link.db, link.table, link.key ?? null]) : ''
  const openedLink = useRef('')
  useEffect(() => {
    if (!linkKey || !link?.db || !link.table || openedLink.current === linkKey) return
    openedLink.current = linkKey
    open(link.key ? linkedTab(link.db, link.table, link.key) : tableTab(link.db, link.table))
  }, [linkKey])

  function openSql(db?: string, initialText?: string) {
    sqlSeq.current += 1
    open({
      id: `s${SEP}${sqlSeq.current}`,
      kind: 'sql',
      db: db ?? '',
      seq: sqlSeq.current,
      ...(initialText ? { initialText } : {}),
    })
  }

  /** Export and import pages are tabs; one per mode and scope, an import with a dropped file is always new. */
  function openIo(
    mode: 'export' | 'import',
    scope: { db?: string; table?: string },
    upload?: UploadedFile,
  ) {
    ioSeq.current += 1
    const unique = upload ? SEP + ioSeq.current : ''
    open({
      id: 'i' + SEP + mode + SEP + (scope.db ?? '') + SEP + (scope.table ?? '') + unique,
      kind: 'io',
      ioMode: mode,
      db: scope.db ?? '',
      ...(scope.table ? { table: scope.table } : {}),
      ...(upload ? { upload } : {}),
    })
  }

  const uploads = useUploadQueue({
    limitBytes: ioCaps.data?.limits.uploadBytes,
    onDone: (item) =>
      openIo('import', active?.db ? { db: active.db } : {}, {
        uploadId: item.uploadId,
        name: item.name,
        bytes: item.bytes,
        format: item.format,
      }),
  })

  function openResultExport(result: { db?: string; text: string; statementIndex: number }) {
    ioSeq.current += 1
    open({
      id: 'i' + SEP + 'result' + SEP + ioSeq.current,
      kind: 'io',
      ioMode: 'export',
      db: result.db ?? '',
      result,
    })
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

  /** Unsaved SQL text asks first (FR-SQL-024); everything else closes at once. */
  const close = (tab: ShellTab) => {
    if (tab.kind === 'sql' && sqlMeta[tab.id]?.dirty) setClosing(tab)
    else closeWhere((c) => c.id === tab.id)
  }

  // Leaving the page with unsaved SQL asks first; the text lives only in this page's memory.
  const anyDirty = Object.values(sqlMeta).some((m) => m.dirty)
  useEffect(() => {
    if (!anyDirty) return
    const guard = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [anyDirty])

  /** Tabs follow a change that ran: dropped tables and databases close, a renamed table is renamed. */
  function structureApplied(input: PreviewInput, result: ExecuteResult) {
    if (!result.ok) return
    if (input.action === 'dropTable') {
      closeWhere((c) => c.kind !== 'sql' && c.db === input.db && c.table === input.table)
    } else if (input.action === 'dropDatabase') {
      closeWhere((c) => c.kind !== 'sql' && c.db === input.name)
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
    if (account) await Promise.resolve(account.onSignOut()).catch(() => undefined)
    else await logout().catch(() => undefined)
    setCsrfToken(undefined)
    queryClient.clear()
    await router.invalidate()
  }

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[48px_minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]">
      <SessionEndedDialog
        {...(account ? { onAccountSignIn: () => void signOut() } : {})}
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
            setSqlMeta({})
          }
        }}
      />

      <ConnectionLost />

      <Dialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        labelledBy="sql-close-title"
        className="w-[min(420px,calc(100vw-32px))]"
      >
        <div className="flex flex-col gap-4 p-6">
          <h2 id="sql-close-title" className="text-base font-semibold">
            {t('sql.close.title')}
          </h2>
          <p className="text-sm text-muted">{t('sql.close.body')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setClosing(null)}>{t('sql.close.keep')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (closing) closeWhere((c) => c.id === closing.id)
                setClosing(null)
              }}
            >
              {t('sql.close.discard')}
            </Button>
          </div>
        </div>
      </Dialog>

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
        <DropTarget
          enabled={ioPrefs.data?.dragDrop ?? true}
          onFiles={(files) => uploads.add(files)}
          className="flex min-h-0 flex-1 flex-col gap-4"
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
          {connectionSlot}
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
              sql={sqlEnabled ? { onNew: (db) => openSql(db) } : undefined}
              io={{
                onExport: (scope) => {
                  setMenuOpen(false)
                  openIo('export', scope)
                },
                onImport: (scope) => {
                  setMenuOpen(false)
                  openIo('import', scope)
                },
              }}
            />
          </div>
          {!account && (
            <Button variant="ghost" className="justify-start" onClick={() => void signOut()}>
              <LogOut size={14} strokeWidth={1.5} aria-hidden />
              {t('nav.logout')}
            </Button>
          )}
        </DropTarget>
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
              {targetLabel(session.target)} /{' '}
              {active.kind === 'io' && !active.db ? null : (
                <>
                  {active.kind === 'sql'
                    ? (sqlMeta[active.id]?.db ?? active.db) || t('sql.status.noDatabase')
                    : active.db}{' '}
                  /{' '}
                </>
              )}
              <span className="text-ink">
                {active.kind === 'io'
                  ? t(active.ioMode === 'import' ? 'io.crumb.import' : 'io.crumb.export')
                  : active.kind === 'sql'
                    ? t('sql.tab.crumb')
                    : (active.table ?? t('structure.tab.new'))}
              </span>
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
        {account && (
          <ActionsMenu
            label={t('nav.accountMenu')}
            className="h-8 w-auto max-w-[200px] gap-2 px-2 text-sm text-muted pointer-coarse:h-9 pointer-coarse:w-auto"
            trigger={
              <>
                <UserRound size={14} strokeWidth={1.5} aria-hidden />
                <span className="hidden truncate sm:inline">{account.name}</span>
              </>
            }
            header={account.name ? <p className="truncate text-sm font-medium">{account.name}</p> : undefined}
            items={[
              {
                key: 'account',
                label: t('nav.account'),
                icon: <UserRound size={14} strokeWidth={1.5} />,
                onSelect: () => void router.navigate({ to: '/account' }),
              },
              {
                key: 'logout',
                label: t('nav.logout'),
                icon: <LogOut size={14} strokeWidth={1.5} />,
                onSelect: () => void signOut(),
              },
            ]}
          />
        )}
      </header>

      <main className="col-start-1 row-start-2 mr-2 mb-2 ml-2 flex min-h-0 overflow-hidden rounded-[var(--radius-sheet)] border border-border bg-surface md:col-start-2 md:ml-0">
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 && (
            <div className="relative flex shrink-0 overflow-x-auto border-b border-border px-3">
              {/* Close buttons sit beside their tab, so the tablist owns the tab buttons by id and nothing else. */}
              <div
                role="tablist"
                aria-label={t('tab.list')}
                aria-owns={tabs.map((tab) => tabButtonId(tab.id)).join(' ')}
                className="absolute size-0"
              />
              {tabs.map((tab) => {
                const selected = tab.id === activeKey
                return (
                  <div key={tab.id} className="relative flex shrink-0 items-center">
                    <button
                      id={tabButtonId(tab.id)}
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveKey(tab.id)}
                      className={cn(
                        'press h-11 pr-1 pl-3 text-sm',
                        selected ? 'font-semibold text-ink' : 'text-muted hover:text-ink',
                      )}
                    >
                      {tabLabel(tab)}
                      {tab.kind === 'sql' && (sqlMeta[tab.id]?.db ?? tab.db) && (
                        <span className="ml-1.5 font-normal text-faint">
                          {sqlMeta[tab.id]?.db ?? tab.db}
                        </span>
                      )}
                      {tab.kind === 'sql' && sqlMeta[tab.id]?.dirty && (
                        <span
                          role="img"
                          aria-label={t('sql.tab.unsaved')}
                          title={t('sql.tab.unsaved')}
                          className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle"
                        />
                      )}
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
              {sqlEnabled && (
                <button
                  type="button"
                  aria-label={t('sql.tab.new')}
                  title={t('sql.tab.new')}
                  onClick={() => openSql(active?.db || undefined)}
                  className="press my-auto ml-1 grid h-8 w-8 shrink-0 place-items-center rounded text-muted hover:bg-active hover:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
                >
                  <Plus size={14} aria-hidden />
                </button>
              )}
            </div>
          )}
          {/* SQL tabs stay mounted while hidden: typed text, results and undo history live in page memory only. */}
          {tabs
            .filter((tab) => tab.kind === 'sql')
            .map((tab) => (
              <div
                key={tab.id}
                className={cn('min-h-0 flex-1 flex-col', tab.id === activeKey ? 'flex' : 'hidden')}
              >
                <SqlTab
                  tabId={tab.id.replace(/[^A-Za-z0-9_-]/g, '_')}
                  initialDb={tab.db}
                  initialText={tab.initialText}
                  readOnly={readOnly}
                  active={tab.id === activeKey}
                  onMeta={(m) => setSqlMeta((cur) => ({ ...cur, [tab.id]: m }))}
                  onExport={openResultExport}
                />
              </div>
            ))}
          {/* Export and import pages stay mounted while hidden: a running upload, mapping or job view survives a tab switch. */}
          {tabs
            .filter((tab) => tab.kind === 'io')
            .map((tab) => (
              <div
                key={tab.id}
                className={cn('min-h-0 flex-1 flex-col', tab.id === activeKey ? 'flex' : 'hidden')}
              >
                {tab.ioMode === 'import' ? (
                  <ImportTab
                    target={{
                      ...(tab.db ? { db: tab.db } : {}),
                      ...(tab.table ? { table: tab.table } : {}),
                    }}
                    serverLabel={targetLabel(session.target)}
                    readOnly={readOnly}
                    {...(tab.upload ? { initialUpload: tab.upload } : {})}
                    onOpenTable={(db, table) => open(tableTab(db, table))}
                    onDropTable={(db, table) =>
                      setAction({ type: 'dropTable', db, table, view: false })
                    }
                  />
                ) : (
                  <ExportTab
                    target={
                      tab.result
                        ? { kind: 'result', ...tab.result }
                        : tab.table
                          ? { kind: 'table', db: tab.db, table: tab.table }
                          : tab.db
                            ? { kind: 'database', db: tab.db }
                            : { kind: 'server' }
                    }
                    serverLabel={targetLabel(session.target)}
                  />
                )}
              </div>
            ))}
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
            <TableView
              key={active.id}
              db={active.db}
              table={active.table}
              onExport={(db, table) => openIo('export', { db, table })}
              {...(active.key ? { initialFilter: keyFilter(active.key) } : {})}
            />
          ) : active ? null : (
            <div className="px-6 pt-8">
              <h1 className="mb-2 text-[22px] font-semibold leading-7">{t('empty.title')}</h1>
              <p className="max-w-md text-sm text-muted">{t('empty.body')}</p>
              {sqlEnabled && (
                <Button className="mt-4" onClick={() => openSql()}>
                  <Plus size={14} aria-hidden />
                  {t('sql.tab.new')}
                </Button>
              )}
            </div>
          )}
        </div>
        {assistantOpen && <AssistantHost onClose={() => setAssistantOpen(false)} onOpenSql={(db, sql) => openSql(db || undefined, sql)} />}
      </main>
      <UploadStatusPanel
        items={uploads.items}
        limitText={
          ioCaps.data ? `${Math.round(ioCaps.data.limits.uploadBytes / 1048576)} MiB` : undefined
        }
        onCancel={uploads.cancel}
        onRemove={uploads.remove}
        onClose={uploads.clear}
      />
    </div>
  )
}
