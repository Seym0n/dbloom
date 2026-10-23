import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { LogOut, Menu, MessageSquare, X } from 'lucide-react'
import { BrandName } from '~/components/brand'
import { TableView } from '~/components/grid/table-view'
import { SessionEndedDialog } from '~/components/session-ended-dialog'
import { Button } from '~/components/ui/button'
import { setCsrfToken } from '~/lib/csrf'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { getDatabases } from '~/server/browse.functions'
import { logout } from '~/server/session.functions'
import { SidebarTree, type OpenTable } from './sidebar-tree'

export type SessionInfo = {
  csrf: string
  target: { host: string; port: number; username: string }
}

const tabKey = (tab: OpenTable) => `${tab.db}\u0000${tab.table}`
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
  const [tabs, setTabs] = useState<OpenTable[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>()
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const active = tabs.find((tab) => tabKey(tab) === activeKey)
  const databases = useQuery({ queryKey: ['databases'], queryFn: () => getDatabases() })

  function open(tab: OpenTable) {
    setTabs((current) =>
      current.some((c) => tabKey(c) === tabKey(tab)) ? current : [...current, tab],
    )
    setActiveKey(tabKey(tab))
    setMenuOpen(false)
  }

  function close(tab: OpenTable) {
    const index = tabs.findIndex((c) => tabKey(c) === tabKey(tab))
    const next = tabs.filter((c) => tabKey(c) !== tabKey(tab))
    setTabs(next)
    if (activeKey === tabKey(tab)) {
      const neighbour = next[Math.min(index, next.length - 1)]
      setActiveKey(neighbour ? tabKey(neighbour) : undefined)
    }
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
          <SidebarTree active={active} onOpen={open} />
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
              <span className="text-ink">{active.table}</span>
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
                const selected = tabKey(tab) === activeKey
                return (
                  <div key={tabKey(tab)} className="relative flex shrink-0 items-center">
                    <button
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveKey(tabKey(tab))}
                      className={cn(
                        'press h-11 pr-1 pl-3 text-sm',
                        selected ? 'font-semibold text-ink' : 'text-muted hover:text-ink',
                      )}
                    >
                      {tab.table}
                    </button>
                    <button
                      aria-label={t('tab.close', { name: tab.table })}
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
          {active ? (
            <TableView key={tabKey(active)} db={active.db} table={active.table} />
          ) : (
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
