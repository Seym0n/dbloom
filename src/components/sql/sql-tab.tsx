import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  History,
  ListTree,
  Play,
  Square,
  WrapText,
} from 'lucide-react'
import { Button } from '~/components/ui/button'
import { useStructureLists } from '~/components/structure/use-structure'
import { getDatabases } from '~/server/browse.functions'
import { setSessionEnded } from '~/lib/session-state'
import type { SqlExplainResponse, SqlRunOptions, SqlStatementResult } from '~/server/sql/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { SaveBookmarkDialog } from './bookmarks'
import { SqlConfirmDialog, type ConfirmPlan } from './confirm-dialog'
import { useSqlEditor, type EditorApi, type EditorCommands } from './editor'
import { describeSqlError } from './errors'
import { ExplainView, type ExplainFormat } from './explain-view'
import {
  commitsImplicitly,
  formatSeconds,
  newRunId,
  offsetOfPosition,
  locateStatement,
  readOnlyBlocked,
  refreshAfterSql,
  splitLocal,
  statementAt,
  toSingleLine,
} from './helpers'
import { HistoryDrawer, type DrawerTab } from './history-drawer'
import { OptionsPopover, type TabPrefs } from './options-popover'
import { modKey, Notice, Pill } from './parts'
import { ResultPanels, RunErrorPanel, type DoneResponse } from './result-panels'
import {
  cancelSql,
  confirmSql,
  explainSql,
  getCompletionSchema,
  getSqlLimits,
  planAnalyseSql,
  runSql,
} from './server-api'

export type SqlTabMeta = { dirty: boolean; db: string }

const MAX_TEXT = 1_048_576

/** Options chosen in one tab are the starting point of the next tab (page memory only, never stored). */
let remembered: SqlRunOptions = {
  continueOnError: false,
  singleTransaction: false,
  disableForeignKeyChecks: false,
  confirmSoft: false,
}

type RunSnapshot = {
  runId: string
  text: string
  base?: { from: number; to: number }
  options: SqlRunOptions
  db?: string
}

type ExplainState = {
  mode: 'explain' | 'analyse'
  format: ExplainFormat
  text: string
  result: SqlExplainResponse | null
  loading: boolean
  error: string | null
}

/**
 * One SQL tab (spec 5.11). The shell keeps it mounted while another tab is shown, so the text, results
 * and undo history survive a switch; they exist only in this component's memory (FR-SQL-024).
 */
export function SqlTab({
  tabId,
  initialDb,
  initialText,
  readOnly,
  active,
  onMeta,
  onExport,
}: {
  tabId: string
  initialDb: string
  initialText?: string
  readOnly: boolean
  active: boolean
  onMeta: (meta: SqlTabMeta) => void
  /** Opens the export page for one result set: the run's text, the statement's index and the database it ran in. */
  onExport?: (request: { db?: string; text: string; statementIndex: number }) => void
}) {
  const queryClient = useQueryClient()
  const api = useRef<EditorApi>(null)
  const [db, setDb] = useState(initialDb)
  const [options, setOptions] = useState<SqlRunOptions>(remembered)
  const [prefs, setPrefs] = useState<TabPrefs>({ completion: true })
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [view, setView] = useState<{ response: DoneResponse; snapshot: RunSnapshot } | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ plan: ConfirmPlan; snapshot: RunSnapshot } | null>(null)
  // Analyse of a data-changing statement: the confirm plan from planAnalyseSql (spec 5.9).
  const [analysePlan, setAnalysePlan] = useState<{
    plan: ConfirmPlan
    format: ExplainFormat
    text: string
    db?: string
  } | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [explain, setExplain] = useState<ExplainState | null>(null)
  const [drawer, setDrawer] = useState<DrawerTab | null>(null)
  const [save, setSave] = useState<{ sql: string; db: string | null } | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [height, setHeight] = useState<number | null>(null)
  const [snapshotText, setSnapshotText] = useState(initialText ?? '')

  const baseline = useRef('')
  const meta = useRef<SqlTabMeta>({ dirty: false, db: initialDb })
  const current = useRef<RunSnapshot | null>(null)
  const startedAt = useRef(0)
  const runningRef = useRef(false)
  const dbRef = useRef(db)
  dbRef.current = db
  const editorBox = useRef<HTMLDivElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const lists = useStructureLists()
  const product = lists.data?.server.product
  const limits = useQuery({
    queryKey: ['sql', 'limits'],
    queryFn: () => getSqlLimits(),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const databases = useQuery({ queryKey: ['databases'], queryFn: () => getDatabases() })

  const report = useCallback(() => {
    const text = api.current?.getText() ?? ''
    const dirty = text.trim() !== '' && text !== baseline.current
    if (meta.current.dirty !== dirty || meta.current.db !== dbRef.current) {
      meta.current = { dirty, db: dbRef.current }
      onMeta(meta.current)
    }
  }, [onMeta])

  useEffect(() => {
    report()
  }, [db, report])

  // The editor completes against the tab's database; a different one starts a fresh lazy cache.
  useEffect(() => {
    api.current?.resetCompletion()
  }, [db])

  const commands = useRef<EditorCommands>({
    run: () => undefined,
    runStatement: () => undefined,
    explain: () => undefined,
    saveBookmark: () => undefined,
    cancel: () => false,
  })

  const editorRef = useSqlEditor({
    api: api as React.Ref<EditorApi>,
    initialDoc: initialText ?? '',
    product,
    commands,
    completion: {
      db: () => dbRef.current || undefined,
      product: () => lists.data?.server.product,
      enabled: () => prefs.completion,
      fetchSchema: (input) => getCompletionSchema({ data: input }),
    },
    completionOn: prefs.completion,
    onChange: () => {
      report()
      if (readOnly || options.singleTransaction) {
        clearTimeout(debounce.current)
        debounce.current = setTimeout(() => setSnapshotText(api.current?.getText() ?? ''), 150)
      }
    },
    onSelectionChange: setHasSelection,
  })

  useEffect(() => {
    if (active) api.current?.focus()
  }, [active])

  // Elapsed time of a running statement, shown next to Cancel.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), 200)
    return () => clearInterval(id)
  }, [running])

  // Closing the tab or leaving while a run goes on cancels it (FR-SQL-013).
  useEffect(
    () => () => {
      clearTimeout(debounce.current)
      const run = current.current
      if (runningRef.current && run)
        void cancelSql({ data: { runId: run.runId } }).catch(() => undefined)
    },
    [],
  )

  const blocked = readOnly && readOnlyBlocked(snapshotText)
  const implicitCommit = options.singleTransaction && commitsImplicitly(snapshotText)
  const tooLong = snapshotText.length > MAX_TEXT
  const timeoutMs = limits.data?.timeoutMs
  const disabledReason =
    limits.error && /sql_disabled/.test(String(limits.error.message))
      ? t('sql.err.disabled')
      : blocked
        ? t('sql.readOnly.blocked')
        : tooLong
          ? t('sql.err.tooLarge')
          : undefined

  function handleError(error: unknown) {
    const d = describeSqlError(error)
    if (d.sessionEnded) {
      setSessionEnded(true)
      setRunError(t('sql.err.sessionEnded'))
      return d.message
    }
    setRunError(d.message)
    if (d.at !== undefined) api.current?.markError({ from: d.at, to: d.at + 1 })
    return d.message
  }

  function revealError(result: SqlStatementResult, snap?: RunSnapshot) {
    const s = snap ?? view?.snapshot
    const a = api.current
    if (!s || !a) return
    const text = a.getText()
    if (text !== s.text) {
      a.focus()
      return
    }
    const where = locateStatement(s.text, s.base, result.index, result.sql)
    if (!where) return
    if (result.status === 'failed' && result.error.position) {
      const stmtText = s.text.slice(where.from, where.to)
      const at = offsetOfPosition(stmtText, where.from, result.error.position)
      const end = Math.min(
        where.to,
        at + Math.max(1, /^\S+/.exec(s.text.slice(at))?.[0].length ?? 1),
      )
      a.markError({ from: at, to: end })
    } else if (result.status === 'failed') {
      a.markError(where)
    } else {
      a.select(where.from, where.to)
    }
  }

  function finish(response: DoneResponse, snap: RunSnapshot) {
    setRunning(false)
    runningRef.current = false
    setPlan(null)
    setPlanBusy(false)
    setPlanError(null)
    setRunError(null)
    setView({ response, snapshot: snap })
    baseline.current = snap.text
    report()
    if (response.db && response.db !== dbRef.current) setDb(response.db)
    const failed = response.results.find((r) => r.status === 'failed')
    if (failed) revealError(failed, snap)
    else api.current?.markError(null)
    // A successful CREATE, DROP, ALTER or RENAME refreshes the sidebar and cached structure (FR-SQL-025).
    refreshAfterSql(queryClient, response)
    // History changed on the server; the next time the drawer opens it fetches again.
    void queryClient.invalidateQueries({ queryKey: ['sql', 'history'] })
  }

  async function execute(snap: RunSnapshot, range?: { from: number; to: number }) {
    if (runningRef.current) return
    setExplain(null)
    setRunError(null)
    setRunning(true)
    runningRef.current = true
    startedAt.current = Date.now()
    setElapsed(0)
    current.current = snap
    api.current?.markError(null)
    try {
      const response = await runSql({
        data: {
          runId: snap.runId,
          tabId,
          ...(snap.db ? { db: snap.db } : {}),
          text: snap.text,
          ...(range ? { range } : {}),
          options: snap.options,
        },
      })
      if (response.kind === 'confirm') {
        setRunning(false)
        runningRef.current = false
        setPlanError(null)
        setPlan({ plan: response, snapshot: snap })
        return
      }
      finish(response, snap)
    } catch (error) {
      setRunning(false)
      runningRef.current = false
      handleError(error)
    }
  }

  function plainRun(kind: 'all' | 'statement', override?: { text: string; db?: string | null }) {
    const a = api.current
    if (!a || runningRef.current) return
    if (override) a.setText(override.text)
    const text = a.getText()
    if (text.trim() === '') return
    let range: { from: number; to: number } | undefined
    if (kind === 'statement') {
      const st = statementAt(splitLocal(text).statements, a.getCursor())
      if (!st) return
      range = { from: st.start, to: st.end }
    } else {
      const sel = a.getSelection()
      if (sel.from !== sel.to) range = { from: sel.from, to: sel.to }
    }
    const sent = range ? text.slice(range.from, range.to) : text
    if (text.length > MAX_TEXT) {
      setRunError(t('sql.err.tooLarge'))
      return
    }
    if (readOnly && readOnlyBlocked(sent)) {
      setRunError(t('sql.readOnly.blocked'))
      return
    }
    const useDb = override && override.db !== undefined ? (override.db ?? '') : db
    if (override && override.db) setDb(override.db)
    remembered = options
    void execute(
      {
        runId: newRunId(),
        text,
        ...(range ? { base: range } : {}),
        options,
        ...(useDb ? { db: useDb } : {}),
      },
      range,
    )
  }

  async function confirm(p: ConfirmPlan) {
    const snap = plan?.snapshot
    if (!snap) return
    setPlanBusy(true)
    setPlanError(null)
    setRunning(true)
    runningRef.current = true
    startedAt.current = Date.now()
    setElapsed(0)
    current.current = snap
    try {
      const response = await confirmSql({
        data: {
          runId: p.runId,
          planId: p.planId,
          ...(p.confirmToken ? { confirmToken: p.confirmToken } : {}),
        },
      })
      if (response.kind === 'confirm') {
        setRunning(false)
        runningRef.current = false
        setPlanBusy(false)
        setPlan({ plan: response, snapshot: snap })
        return
      }
      finish(response, snap)
    } catch (error) {
      setRunning(false)
      runningRef.current = false
      setPlanBusy(false)
      const d = describeSqlError(error)
      if (d.sessionEnded) {
        setSessionEnded(true)
        setPlan(null)
        setRunError(t('sql.err.sessionEnded'))
      } else setPlanError(d.message)
    }
  }

  function cancel(): boolean {
    const run = current.current
    if (!runningRef.current || !run) return false
    void cancelSql({ data: { runId: run.runId } }).catch((e) => {
      if (describeSqlError(e).sessionEnded) setSessionEnded(true)
    })
    return true
  }

  async function runExplain(
    mode: 'explain' | 'analyse',
    format: ExplainFormat,
    textOverride?: string,
  ) {
    const a = api.current
    if (!a) return
    let text = textOverride
    if (text === undefined) {
      const full = a.getText()
      const sel = a.getSelection()
      if (sel.from !== sel.to) text = full.slice(sel.from, sel.to).trim()
      else text = statementAt(splitLocal(full).statements, a.getCursor())?.text
      if (!text) return
      if (splitLocal(text).statements.length > 1) {
        setExplain({
          mode,
          format,
          text,
          result: null,
          loading: false,
          error: t('sql.explain.one'),
        })
        return
      }
    }
    if (mode === 'analyse' && readOnly && readOnlyBlocked(text)) {
      setExplain({
        mode,
        format,
        text,
        result: null,
        loading: false,
        error: t('sql.readOnly.blocked'),
      })
      return
    }
    setRunError(null)
    setExplain((prev) => ({
      mode,
      format,
      text: text as string,
      result: prev && prev.text === text ? prev.result : null,
      loading: true,
      error: null,
    }))
    try {
      if (mode === 'analyse') {
        // A data-changing statement needs a confirmation first; a safe read is analysed directly.
        try {
          const plan = await planAnalyseSql({ data: { ...(db ? { db } : {}), text } })
          setPlanError(null)
          setExplain((prev) => (prev ? { ...prev, loading: false } : prev))
          setAnalysePlan({ plan, format, text, ...(db ? { db } : {}) })
          return
        } catch (error) {
          if (describeSqlError(error).code !== 'no_confirmation_needed') throw error
        }
      }
      const result = await explainSql({
        data: { ...(db ? { db } : {}), text, mode, format },
      })
      setExplain({ mode, format, text, result, loading: false, error: null })
    } catch (error) {
      const d = describeSqlError(error)
      if (d.sessionEnded) setSessionEnded(true)
      setExplain((prev) => ({
        mode,
        format,
        text: text as string,
        result: prev?.result ?? null,
        loading: false,
        error: d.sessionEnded ? t('sql.err.sessionEnded') : d.message,
      }))
    }
  }

  async function confirmAnalyse(p: ConfirmPlan) {
    const a = analysePlan
    if (!a) return
    setPlanBusy(true)
    setPlanError(null)
    setExplain({
      mode: 'analyse',
      format: a.format,
      text: a.text,
      result: null,
      loading: true,
      error: null,
    })
    try {
      const result = await explainSql({
        data: {
          ...(a.db ? { db: a.db } : {}),
          text: a.text,
          mode: 'analyse',
          format: a.format,
          planId: p.planId,
          ...(p.confirmToken ? { confirmToken: p.confirmToken } : {}),
        },
      })
      setPlanBusy(false)
      setAnalysePlan(null)
      setExplain({
        mode: 'analyse',
        format: a.format,
        text: a.text,
        result,
        loading: false,
        error: null,
      })
      // Analyse executed the statement: history and data may have changed.
      void queryClient.invalidateQueries({ queryKey: ['sql', 'history'] })
      void queryClient.invalidateQueries({ queryKey: ['rows'] })
    } catch (error) {
      setPlanBusy(false)
      const d = describeSqlError(error)
      if (d.sessionEnded) {
        setSessionEnded(true)
        setAnalysePlan(null)
        setRunError(t('sql.err.sessionEnded'))
      } else {
        setPlanError(d.message)
        setExplain((prev) => (prev ? { ...prev, loading: false } : prev))
      }
    }
  }

  function loadFromDrawer(sql: string, entryDb: string | null, runIt: boolean) {
    const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
    if (narrow) setDrawer(null)
    if (runIt) plainRun('all', { text: sql, db: entryDb })
    else {
      api.current?.setText(sql)
      if (entryDb) setDb(entryDb)
      baseline.current = sql
      report()
      api.current?.focus()
    }
  }

  // Latest closures for the keymap.
  commands.current = {
    run: () => (disabledReason ? undefined : plainRun('all')),
    runStatement: () => (disabledReason ? undefined : plainRun('statement')),
    explain: () => void runExplain('explain', explain?.format ?? 'json'),
    saveBookmark: () => {
      const text = api.current?.getText() ?? ''
      if (text.trim() !== '') setSave({ sql: text, db: db || null })
    },
    cancel,
  }

  // Splitter between editor and results: pointer drag and arrow keys.
  const dragStart = useRef<{ y: number; h: number } | null>(null)
  const clampH = (h: number) => Math.max(96, Math.min(640, h))

  const dbOptions = useMemo(() => databases.data?.map((d) => d.name) ?? [], [databases.data])
  const hint = t('sql.hint', { key: modKey() })

  return (
    <section aria-label={t('sql.tab.label')} className="relative flex min-h-0 flex-1 md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
          {running ? (
            <Button variant="primary" className="pointer-coarse:h-11" onClick={() => cancel()}>
              <Square size={14} aria-hidden />
              {t('sql.cancel')}
              <span className="font-normal opacity-80" aria-hidden>
                {(elapsed / 1000).toFixed(1)} s
              </span>
            </Button>
          ) : (
            <Button
              variant="primary"
              className="pointer-coarse:h-11"
              aria-disabled={disabledReason ? true : undefined}
              aria-describedby={disabledReason ? `${tabId}-why` : undefined}
              onClick={() => (disabledReason ? undefined : plainRun('all'))}
            >
              <Play size={14} aria-hidden />
              {hasSelection ? t('sql.runSelection') : t('sql.run')}
            </Button>
          )}
          <Button
            className="pointer-coarse:h-11"
            disabled={running}
            onClick={() => void runExplain('explain', explain?.format ?? 'json')}
          >
            <ListTree size={14} strokeWidth={1.5} aria-hidden />
            <span className="hidden sm:inline">{t('sql.explain')}</span>
            <span className="sr-only sm:hidden">{t('sql.explain')}</span>
          </Button>
          <Button
            className="pointer-coarse:h-11"
            disabled={running}
            title={t('sql.analyse.title')}
            onClick={() => void runExplain('analyse', explain?.format ?? 'json')}
          >
            <Activity size={14} strokeWidth={1.5} aria-hidden />
            <span className="hidden sm:inline">{t('sql.analyse')}</span>
            <span className="sr-only sm:hidden">{t('sql.analyse')}</span>
          </Button>
          <Button
            className="pointer-coarse:h-11"
            onClick={() => {
              const a = api.current
              if (a) a.setText(toSingleLine(a.getText()))
            }}
          >
            <WrapText size={14} strokeWidth={1.5} aria-hidden />
            <span className="hidden md:inline">{t('sql.singleLine')}</span>
            <span className="sr-only md:hidden">{t('sql.singleLine')}</span>
          </Button>
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
          <Button
            className="pointer-coarse:h-11"
            aria-pressed={drawer === 'history'}
            onClick={() => setDrawer((d) => (d === 'history' ? null : 'history'))}
          >
            <History size={14} strokeWidth={1.5} aria-hidden />
            <span className="hidden lg:inline">{t('sql.drawer.history')}</span>
            <span className="sr-only lg:hidden">{t('sql.drawer.history')}</span>
          </Button>
          <Button
            className="pointer-coarse:h-11"
            aria-pressed={drawer === 'bookmarks'}
            onClick={() => setDrawer((d) => (d === 'bookmarks' ? null : 'bookmarks'))}
          >
            <BookmarkIcon size={14} strokeWidth={1.5} aria-hidden />
            <span className="hidden lg:inline">{t('sql.drawer.bookmarks')}</span>
            <span className="sr-only lg:hidden">{t('sql.drawer.bookmarks')}</span>
          </Button>
          <Button
            variant="ghost"
            className="pointer-coarse:h-11"
            aria-label={t('sql.bookmark.saveAs')}
            title={t('sql.bookmark.saveAs')}
            onClick={() => commands.current.saveBookmark()}
          >
            <BookmarkPlus size={14} strokeWidth={1.5} aria-hidden />
          </Button>
          <div className="ml-auto">
            <OptionsPopover
              options={options}
              onChange={(o) => {
                setOptions(o)
                remembered = o
              }}
              prefs={prefs}
              onPrefs={setPrefs}
              implicitCommitWarning={implicitCommit}
            />
          </div>
        </div>

        {disabledReason && (
          <p id={`${tabId}-why`} className="px-3 pb-2 text-sm text-muted">
            {disabledReason}
          </p>
        )}
        {implicitCommit && !disabledReason && (
          <div className="px-3 pb-2">
            <Notice>{t('sql.opt.implicitCommit')}</Notice>
          </div>
        )}

        <div className="border-y border-border">
          <div
            ref={editorBox}
            className={cn(
              'min-h-24 overflow-hidden',
              height === null
                ? '[&_.cm-editor]:max-h-[216px]'
                : '[&_.cm-editor]:h-full [&_.cm-editor]:max-h-none',
            )}
            style={height === null ? undefined : { height }}
          >
            <div ref={editorRef} className="h-full" />
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('sql.resize')}
            aria-valuenow={height ?? undefined}
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              dragStart.current = { y: e.clientY, h: editorBox.current?.clientHeight ?? 96 }
            }}
            onPointerMove={(e) => {
              const s = dragStart.current
              if (s) setHeight(clampH(s.h + e.clientY - s.y))
            }}
            onPointerUp={() => (dragStart.current = null)}
            onDoubleClick={() => setHeight(null)}
            onKeyDown={(e) => {
              const base = height ?? editorBox.current?.clientHeight ?? 96
              if (e.key === 'ArrowDown') setHeight(clampH(base + 24))
              else if (e.key === 'ArrowUp') setHeight(clampH(base - 24))
              else if (e.key === 'Home') setHeight(null)
              else return
              e.preventDefault()
            }}
            className="group flex h-3 cursor-row-resize touch-none items-center justify-center pointer-coarse:h-5"
          >
            <span className="h-0.5 w-10 rounded bg-control group-hover:bg-muted group-focus-visible:bg-accent" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            {t('sql.status.database')}
            <select
              value={db}
              onChange={(e) => setDb(e.target.value)}
              className="h-7 max-w-40 rounded-[var(--radius-control)] border border-control bg-surface px-1.5 text-xs text-ink pointer-coarse:h-10"
            >
              <option value="">{t('sql.status.noDatabase')}</option>
              {db && !dbOptions.includes(db) && <option value={db}>{db}</option>}
              {dbOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {readOnly && <Pill tone="warning">{t('structure.readOnly')}</Pill>}
          {timeoutMs !== undefined && (
            <span>{t('sql.status.timeout', { seconds: formatSeconds(timeoutMs) })}</span>
          )}
          <span className="ml-auto hidden md:inline">{hint}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6" aria-busy={running}>
          {running && (
            <p className="mb-3 text-sm text-muted" role="status">
              {t('sql.running')} {(elapsed / 1000).toFixed(1)} s
            </p>
          )}
          {runError && <RunErrorPanel message={runError} />}
          {explain ? (
            <ExplainView
              statement={explain.text}
              result={explain.result}
              loading={explain.loading}
              error={explain.error}
              mode={explain.mode}
              format={explain.format}
              onFormat={(f) => void runExplain(explain.mode, f, explain.text)}
              onRefresh={() => void runExplain(explain.mode, explain.format, explain.text)}
              onClose={() => setExplain(null)}
            />
          ) : view ? (
            <ResultPanels
              response={view.response}
              product={product}
              dimmed={running}
              onReveal={(r) => revealError(r)}
              {...(onExport
                ? {
                    onExport: (r: SqlStatementResult) =>
                      onExport({
                        ...(view.snapshot.db ? { db: view.snapshot.db } : {}),
                        text: view.snapshot.text,
                        statementIndex: r.index,
                      }),
                  }
                : {})}
            />
          ) : !running && !runError ? (
            <p className="text-sm text-muted">{t('sql.results.empty', { key: modKey() })}</p>
          ) : null}
        </div>
      </div>

      {drawer && (
        <HistoryDrawer
          tab={drawer}
          onTab={setDrawer}
          onClose={() => {
            setDrawer(null)
            api.current?.focus()
          }}
          product={product}
          onRun={(sql, d) => loadFromDrawer(sql, d, true)}
          onEdit={(sql, d) => loadFromDrawer(sql, d, false)}
          onBookmark={(sql, d) => setSave({ sql, db: d })}
        />
      )}

      <SqlConfirmDialog
        plan={plan?.plan ?? analysePlan?.plan ?? null}
        options={plan?.snapshot.options ?? options}
        db={plan?.snapshot.db ?? analysePlan?.db}
        busy={planBusy}
        error={planError}
        onConfirm={(p) => void (plan ? confirm(p) : confirmAnalyse(p))}
        onCancel={() => {
          setPlan(null)
          setAnalysePlan(null)
          setExplain((prev) => (prev?.loading ? { ...prev, loading: false } : prev))
          setPlanError(null)
        }}
      />
      <SaveBookmarkDialog
        request={save}
        onClose={() => setSave(null)}
        onSaved={(b) => {
          baseline.current = b.sql === api.current?.getText() ? b.sql : baseline.current
          report()
        }}
      />
    </section>
  )
}
