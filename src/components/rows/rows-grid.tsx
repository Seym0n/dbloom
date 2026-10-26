import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, RefreshCw, Timer } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Select } from '~/components/ui/select'
import type {
  Cell,
  ColumnLayout,
  FilterNode,
  GetRowsResponse,
  PrefKey,
  RowColumn,
  RowLimitsResponse,
  RowsTotal,
  SearchInput,
  SortEntry,
} from '~/server/rows/types'
import { DEFAULT_ROW_LIMITS } from '~/server/rows/types'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import { ColumnMenu } from './column-menu'
import { FilterBuilder, FilterChips } from './filter-builder'
import type {
  CellContext,
  CellEditContext,
  GridControls,
  GridSnapshot,
  RowsGridHooks,
} from './grid-hooks'
import {
  AUTO_REFRESH_SECONDS,
  DEFAULT_COLUMN_WIDTH,
  matchingRows,
  newRequestId,
  nextSortList,
  parseDisplayPrefs,
  parseSortPref,
  reconcileLayout,
  rowKeyOf,
  setColumnWidth,
  visibleOrder,
  type AutoRefreshSeconds,
  type DisplayPrefs,
} from './grid-model'
import { GridTable, type GridColumn } from './grid-table'
import { Pager, type CountView } from './pager'
import type { KindRegistry, CellRenderer } from './registry'
import type { RowsApi } from './rows-api'
import { PageFind, TableSearch } from './search-bar'
import { SelectionSummary } from './selection'
import {
  clearSelection,
  emptySelection,
  headerState as headerStateOf,
  selectPage,
  selectedIndexes,
  toggleHeader,
  toggleRow,
  type SelectionState,
} from './selection-model'

export type RowsGridProps = {
  db: string
  table: string
  api: RowsApi
  /** A filter to start with, for instance from a foreign key link (FR-ROW-014). */
  initialFilter?: FilterNode
  renderers?: KindRegistry<CellRenderer>
  hooks?: RowsGridHooks
  locale?: string
}

const EMPTY_HOOKS: RowsGridHooks = {}

// ---- Pieces ------------------------------------------------------------------------------------------------------

/** "SQL that ran" under the grid; kept from the skeleton (same structure, same copy behaviour). */
export function SqlStrip({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-baseline gap-3 border-t border-rule px-6 py-3">
      <span className="shrink-0 text-xs text-muted">{t('table.sql')}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={sql}>
        {sql}
      </code>
      <Button
        variant="ghost"
        className="h-6 self-center px-2 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(sql).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? t('table.copied') : t('table.copy')}
      </Button>
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-6 pt-2" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="h-5 rounded bg-active" />
      ))}
    </div>
  )
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-3 text-sm text-muted"
      role="status"
    >
      <span>{children}</span>
      {action}
    </div>
  )
}

function errorText(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message)
    return message.length > 0 && message.length < 300 ? message : undefined
  }
  return undefined
}

// ---- Loader: preferences and limits first, so the first query already uses them --------------------------------

/**
 * The browse grid of one table. It reads the limits and the saved preferences, then mounts the grid with
 * them as its starting state; a failed read falls back to defaults instead of blocking the table.
 */
// ---- Foreign key names (`full` relation mode) ------------------------------------------------------------------------

const MAX_RELATION_FKS = 10

/** The text of a key cell for a lookup; a cut or large binary value cannot be looked up. */
function keyText(cell: Cell | undefined): string | null {
  if (typeof cell === 'string') return cell
  if (cell && typeof cell === 'object' && 'binary' in cell && cell.size <= 32)
    return `0x${cell.binary}`
  return null
}

/** Per outgoing foreign key: the distinct key tuples of this page, in the order of the referenced columns. */
function relationKeysOf(data: GetRowsResponse | undefined) {
  if (!data) return []
  const out: { fk: string; refColumns: string[]; tuples: string[][] }[] = []
  for (const fk of data.table.outgoing.slice(0, MAX_RELATION_FKS)) {
    const at = fk.columns.map((c) => data.columns.indexOf(c))
    if (at.some((i) => i < 0)) continue
    const seen = new Set<string>()
    const tuples: string[][] = []
    for (const row of data.rows) {
      const tuple = at.map((i) => keyText(row[i]))
      if (tuple.some((v) => v === null)) continue
      const id = JSON.stringify(tuple)
      if (seen.has(id)) continue
      seen.add(id)
      tuples.push(tuple as string[])
    }
    if (tuples.length > 0) out.push({ fk: fk.name, refColumns: fk.refColumns, tuples })
  }
  return out
}

/** The referenced row's name for the first column of a foreign key, or nothing. */
function relationDisplayOf(
  data: GetRowsResponse,
  row: Cell[],
  columnName: string,
  mode: DisplayPrefs['relationMode'],
  names: Record<string, Record<string, string>> | undefined,
): { relationDisplay?: string } {
  if (mode !== 'full' || !names) return {}
  const fk = data.table.outgoing.find((f) => f.columns[0] === columnName)
  if (!fk) return {}
  const tuple = fk.columns.map((c) => keyText(row[data.columns.indexOf(c)]))
  if (tuple.some((v) => v === null)) return {}
  const shown = names[fk.name]?.[JSON.stringify(tuple)]
  return shown ? { relationDisplay: shown } : {}
}

export function RowsGrid(props: RowsGridProps) {
  const { db, table, api } = props
  const limits = useQuery({
    queryKey: ['rows', 'limits'],
    queryFn: () => api.getLimits(),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const prefs = useQuery({
    queryKey: ['rows', 'prefs', db, table],
    queryFn: () => api.getPrefs({ db, table }),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  })
  if (limits.isPending || prefs.isPending) {
    return (
      <div className="min-h-0 flex-1" role="status" aria-label={t('rows.grid.loading')}>
        <GridSkeleton />
      </div>
    )
  }
  return (
    <RowsGridLoaded
      {...props}
      limits={limits.data ?? { ...DEFAULT_ROW_LIMITS, stateless: false }}
      prefs={prefs.data?.values ?? {}}
    />
  )
}

type Prefs = Partial<Record<PrefKey, unknown>>

type CountState = {
  scope: string
  view: CountView
  total?: RowsTotal
  durationMs?: number
}

function RowsGridLoaded({
  db,
  table,
  api,
  initialFilter,
  renderers,
  hooks = EMPTY_HOOKS,
  locale = 'en-US',
  limits,
  prefs,
}: RowsGridProps & { limits: RowLimitsResponse; prefs: Prefs }) {
  const queryClient = useQueryClient()
  const gridId = useId()

  // ---- State ----
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(() => {
    const stored = prefs['rows.pageSize']
    return typeof stored === 'number' && limits.pageSizes.includes(stored)
      ? stored
      : limits.defaultPageSize
  })
  const [sort, setSort] = useState<SortEntry[]>(() => {
    const stored = prefs['rows.sort']
    return Array.isArray(stored)
      ? (stored as SortEntry[]).filter(
          (s) => typeof s?.column === 'string' && (s.direction === 'asc' || s.direction === 'desc'),
        )
      : []
  })
  const [filter, setFilter] = useState<FilterNode | undefined>(initialFilter)
  const [search, setSearch] = useState<SearchInput | undefined>()
  const [storedLayout, setStoredLayout] = useState<Partial<ColumnLayout> | undefined>(
    prefs['rows.columns'] as Partial<ColumnLayout> | undefined,
  )
  const [display, setDisplay] = useState<DisplayPrefs>(() =>
    parseDisplayPrefs(prefs, limits.displayChars),
  )
  const [findText, setFindText] = useState('')
  const [autoRefresh, setAutoRefresh] = useState<AutoRefreshSeconds>(0)
  const [selectionBox, setSelectionBox] = useState<{ scope: string; state: SelectionState }>({
    scope: '',
    state: emptySelection,
  })
  const [countBox, setCountBox] = useState<CountState>({ scope: '', view: { status: 'idle' } })
  const [statement, setStatement] = useState<{ stamp: number; sql: string } | undefined>()
  const [focus, setFocus] = useState({ r: 0, c: 0 })
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null)
  const [drag, setDrag] = useState<{ name: string; width: number } | null>(null)
  const stamps = useRef(0)
  const countRequest = useRef<string | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const scopeKey = JSON.stringify([db, table, pageSize, sort, filter ?? null, search ?? null])
  const pageKey = ['rows', db, table, 'page', page, scopeKey] as const

  // ---- Page query ----
  const paused = Boolean(hooks.dirty) || editing !== null
  const query = useQuery({
    queryKey: pageKey,
    queryFn: async () => {
      const response = await api.getRows({
        db,
        table,
        page,
        pageSize,
        sort,
        ...(filter ? { filter } : {}),
        ...(search ? { search } : {}),
      })
      stamps.current += 1
      return { response, stamp: stamps.current }
    },
    placeholderData: keepPreviousData,
    // Rows and the catalog behind them change outside DBLoom: a reopened table must ask again, not show the
    // app-wide 30 s cache (the cached page still shows while the answer is on its way).
    staleTime: 0,
    retry: false,
    refetchInterval: autoRefresh > 0 && !paused ? autoRefresh * 1000 : false,
  })
  const data: GetRowsResponse | undefined = query.data?.response
  const stamp = query.data?.stamp ?? 0
  const settled = !query.isPlaceholderData

  // The server answers the page it can serve (clamped after deletes, FR-ROW-006); follow it, and step back
  // from an empty page that has a previous one.
  useEffect(() => {
    if (!data || !settled) return
    if (data.page !== page) setPage(data.page)
    else if (data.rows.length === 0 && data.hasPrev && page > 0) setPage(page - 1)
  }, [data, settled, page])

  // ---- Columns ----
  const model = data?.table
  const modelByName = useMemo(
    () => new Map<string, RowColumn>((model?.columns ?? []).map((c) => [c.name, c])),
    [model],
  )
  const layout = useMemo(
    () => reconcileLayout(storedLayout, data?.columns ?? []),
    [storedLayout, data?.columns],
  )
  const columns: GridColumn[] = useMemo(() => {
    if (!data) return []
    return visibleOrder(layout).map((name) => {
      const index = data.columns.indexOf(name)
      return {
        name,
        index,
        model: modelByName.get(name),
        align: data.kinds[index] ?? 'text',
        width: drag?.name === name ? drag.width : (layout.widths[name] ?? DEFAULT_COLUMN_WIDTH),
      }
    })
  }, [data, layout, modelByName, drag])

  // ---- Persistence of preferences (never values: FR-ROW-010, 5.9) ----
  const persist = useCallback(
    (key: PrefKey, value: unknown, scope: 'table' | 'global') => {
      const input = scope === 'table' ? { db, table, key, value } : { key, value }
      void api.setPref(input).catch(() => {})
      queryClient.setQueryData(['rows', 'prefs', db, table], (old: unknown) => {
        const prev = old as { values?: Prefs; stateless?: boolean } | undefined
        return { stateless: false, ...prev, values: { ...prev?.values, [key]: value } }
      })
    },
    [api, db, table, queryClient],
  )

  function changeLayout(next: ColumnLayout) {
    setStoredLayout(next)
    persist('rows.columns', next, 'table')
  }
  function changeDisplay(next: DisplayPrefs) {
    const was = display
    setDisplay(next)
    if (next.displayChars !== was.displayChars)
      persist('rows.displayChars', next.displayChars, 'global')
    if (next.fullText !== was.fullText) persist('rows.fullText', next.fullText, 'global')
    if (next.protectBinary !== was.protectBinary)
      persist('rows.protectBinary', next.protectBinary, 'global')
    if (next.gridEditing !== was.gridEditing)
      persist('rows.gridEditing', next.gridEditing, 'global')
    if (next.relationMode !== was.relationMode)
      persist('rows.relationMode', next.relationMode, 'global')
  }

  // ---- Paging, sort, filter, search: each change but the page starts at page 1 (FR-ISS-139) ----
  function applySort(column: string, additive: boolean) {
    const next = nextSortList(sort, column, additive)
    setSort(next)
    setPage(0)
    persist('rows.sort', next, 'table')
  }
  function applyFilter(next: FilterNode | undefined) {
    setFilter(next)
    setPage(0)
  }
  function applySearch(next: SearchInput | undefined) {
    setSearch(next)
    setPage(0)
  }
  function applyPageSize(size: number) {
    setPageSize(size)
    setPage(0)
    persist('rows.pageSize', size, 'table')
  }

  // Stored sort entries of dropped columns are ignored when the model arrives.
  const sortNames = data?.columns
  useEffect(() => {
    if (!sortNames) return
    const clean = parseSortPref(sort, sortNames)
    if (clean.length !== sort.length) setSort(clean)
  }, [sortNames, sort])

  // ---- Count (FR-ROW-007) ----
  const countScope = JSON.stringify([db, table, filter ?? null, search ?? null])
  const count: CountState =
    countBox.scope === countScope ? countBox : { scope: countScope, view: { status: 'idle' } }

  function startCount() {
    const requestId = newRequestId()
    countRequest.current = requestId
    setCountBox({ scope: countScope, view: { status: 'running' } })
    api
      .countRows({
        db,
        table,
        requestId,
        ...(filter ? { filter } : {}),
        ...(search ? { search } : {}),
      })
      .then((result) => {
        if (countRequest.current !== requestId) return
        countRequest.current = null
        if (result.status === 'done') {
          setCountBox({
            scope: countScope,
            view: { status: 'done', durationMs: result.durationMs },
            total: result.total,
            durationMs: result.durationMs,
          })
        } else {
          setCountBox({
            scope: countScope,
            view: { status: result.status === 'timeout' ? 'timeout' : 'cancelled' },
          })
        }
      })
      .catch(() => {
        if (countRequest.current !== requestId) return
        countRequest.current = null
        setCountBox({ scope: countScope, view: { status: 'failed' } })
      })
  }
  function cancelCount() {
    const requestId = countRequest.current
    if (!requestId) return
    countRequest.current = null
    setCountBox({ scope: countScope, view: { status: 'cancelled' } })
    void api.cancelCount({ requestId }).catch(() => {})
  }
  // Leaving the table while counting stops the count on the server.
  useEffect(
    () => () => {
      const requestId = countRequest.current
      if (requestId) void api.cancelCount({ requestId }).catch(() => {})
    },
    [api],
  )

  const total: RowsTotal = data
    ? data.total.kind === 'exact'
      ? data.total
      : (count.total ?? data.total)
    : { kind: 'unknown', value: null }

  // ---- Selection (the page is the unit; any new result clears it) ----
  const selectionScope = `${page}|${stamp}|${scopeKey}`
  const selection = selectionBox.scope === selectionScope ? selectionBox.state : emptySelection
  const rows = data?.rows ?? EMPTY_ROWS
  const rowIndexes = useMemo(() => matchingRows(rows, findText), [rows, findText])
  const chosen = selectedIndexes(selection, rows.length)

  function setSelection(next: SelectionState) {
    setSelectionBox({ scope: selectionScope, state: next })
  }

  // ---- Hooks plumbing ----
  const patchPage = useCallback(
    (fn: (response: GetRowsResponse) => GetRowsResponse) => {
      queryClient.setQueryData(pageKey, (old: unknown) => {
        const prev = old as { response: GetRowsResponse; stamp: number } | undefined
        return prev ? { ...prev, response: fn(prev.response) } : prev
      })
    },
    // pageKey is rebuilt from the same inputs on each render
    [queryClient, db, table, page, scopeKey],
  )

  // ---- Names behind foreign keys, `full` relation mode: one lookup per foreign key and page (FR-ROW-014) ----
  const relationKeys = useMemo(() => relationKeysOf(data), [data])
  const relations = useQuery({
    queryKey: ['rows', 'relations', db, table, JSON.stringify(relationKeys)],
    enabled: display.relationMode === 'full' && relationKeys.length > 0 && Boolean(api.lookup),
    queryFn: async () => {
      const names: Record<string, Record<string, string>> = {}
      for (const { fk, refColumns, tuples } of relationKeys) {
        const answer = await api.lookup!({
          db,
          table,
          fk,
          page: 0,
          keys: tuples.map((tuple) =>
            Object.fromEntries(
              refColumns.map((c, i) => [c, { t: 'v' as const, v: tuple[i] ?? '' }]),
            ),
          ),
        })
        const byTuple: Record<string, string> = {}
        for (const option of answer.options) {
          byTuple[JSON.stringify(refColumns.map((c) => option.key[c] ?? null))] = option.display
        }
        names[fk] = byTuple
      }
      return names
    },
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
  })

  const controls: GridControls = useMemo(
    () => ({
      refresh: () => void query.refetch(),
      replaceRow: (rowIndex, cells) =>
        patchPage((r) => ({ ...r, rows: r.rows.map((row, i) => (i === rowIndex ? cells : row)) })),
      showStatement: (sql) => setStatement({ stamp, sql }),
      clearSelection: () => setSelectionBox({ scope: selectionScope, state: emptySelection }),
      focusCell: (r, c) => focusCell(r, c),
    }),
    [query.refetch, patchPage, stamp, selectionScope],
  )

  function contextOf(rowIndex: number, columnIndex: number): CellContext {
    const response = data!
    const row = response.rows[rowIndex] ?? []
    const columnName = response.columns[columnIndex] ?? ''
    return {
      rowIndex,
      columnIndex,
      columnName,
      column: modelByName.get(columnName),
      cell: row[columnIndex] ?? null,
      row,
      columns: response.columns,
      table: response.table,
      identity: response.identity,
      permissions: response.permissions,
      key: rowKeyOf(response.identity, response.columns, row),
      timeZone: response.timeZone,
      relationMode: display.relationMode,
      ...relationDisplayOf(response, row, columnName, display.relationMode, relations.data),
    }
  }

  const snapshot: GridSnapshot = useMemo(() => {
    const selectedRows = chosen.map((i) => rows[i] ?? [])
    const keys = data
      ? selectedRows
          .map((row) => rowKeyOf(data.identity, data.columns, row))
          .filter((k): k is NonNullable<typeof k> => k !== undefined)
      : []
    return {
      db,
      table,
      response: data,
      selectedIndexes: chosen,
      selectedRows,
      selectedKeys: keys,
      unkeyedSelected: selectedRows.length - keys.length,
      controls,
      busy: query.isFetching,
    }
  }, [db, table, data, selection, rows, controls, query.isFetching])

  // ---- Focus and editing ----
  function focusCell(r: number, c: number) {
    setFocus({ r, c })
    requestAnimationFrame(() => {
      tableRef.current
        ?.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`)
        ?.focus({ preventScroll: false })
    })
  }

  const editable = (r: number, c: number): boolean => {
    if (!data || !display.gridEditing || !hooks.renderEditor || !hooks.canEditCell) return false
    const col = columns[c]
    const rowIndex = rowIndexes[r]
    if (!col || rowIndex === undefined) return false
    return hooks.canEditCell(contextOf(rowIndex, col.index))
  }
  function startEdit(r: number, c: number) {
    if (!editable(r, c)) return
    setFocus({ r, c })
    setEditing({ r, c })
  }
  function nextEditable(r: number, c: number, step: 1 | -1): { r: number; c: number } | undefined {
    const width = columns.length
    for (let i = r * width + c + step; i >= 0 && i < rowIndexes.length * width; i += step) {
      const nr = Math.floor(i / width)
      const nc = i % width
      if (editable(nr, nc)) return { r: nr, c: nc }
    }
    return undefined
  }
  function finishEdit(move?: 'next' | 'previous' | 'down') {
    const at = editing
    setEditing(null)
    if (!at) return
    let target: { r: number; c: number } | undefined
    if (move === 'next') target = nextEditable(at.r, at.c, 1)
    else if (move === 'previous') target = nextEditable(at.r, at.c, -1)
    else if (move === 'down' && editable(at.r + 1, at.c)) target = { r: at.r + 1, c: at.c }
    if (target) {
      setFocus(target)
      setEditing(target)
    } else {
      focusCell(at.r, at.c)
    }
  }
  function renderEditor(context: CellContext) {
    const ctx: CellEditContext = {
      ...context,
      ...controls,
      finish: (options) => finishEdit(options?.move),
      cancel: () => finishEdit(),
    }
    return hooks.renderEditor?.(ctx) ?? null
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    if (editing) return
    const target = e.target as HTMLElement
    const cellEl = target.closest<HTMLElement>('td[data-r]')
    if (!cellEl || (target !== cellEl && target.closest('button, input, a, select, textarea')))
      return
    const r = Number(cellEl.dataset.r)
    const c = Number(cellEl.dataset.c)
    const lastR = rowIndexes.length - 1
    const lastC = columns.length - 1
    const move = (nr: number, nc: number) => {
      e.preventDefault()
      focusCell(Math.max(0, Math.min(lastR, nr)), Math.max(0, Math.min(lastC, nc)))
    }
    const rowIndex = rowIndexes[r]
    switch (e.key) {
      case 'ArrowDown':
        return move(r + 1, c)
      case 'ArrowUp':
        return move(r - 1, c)
      case 'ArrowRight':
        return move(r, c + 1)
      case 'ArrowLeft':
        return move(r, c - 1)
      case 'PageDown':
        return move(r + 10, c)
      case 'PageUp':
        return move(r - 10, c)
      case 'Home':
        return e.ctrlKey || e.metaKey ? move(0, 0) : move(r, 0)
      case 'End':
        return e.ctrlKey || e.metaKey ? move(lastR, lastC) : move(r, lastC)
      case ' ':
        if (rowIndex === undefined) return
        e.preventDefault()
        return setSelection(toggleRow(selection, rowIndex, rowIndexes, e.shiftKey))
      case 'a':
      case 'A':
        if (!(e.ctrlKey || e.metaKey)) return
        e.preventDefault()
        return setSelection(selectPage(rowIndexes))
      case 'Escape':
        if (chosen.length > 0) setSelection(clearSelection())
        return
      case 'Delete':
        if (chosen.length > 0 && hooks.onDeleteKey) {
          e.preventDefault()
          hooks.onDeleteKey(snapshot)
        }
        return
      case 'F2':
        e.preventDefault()
        return startEdit(r, c)
      case 'Enter': {
        e.preventDefault()
        const col = columns[c]
        if (e.shiftKey && col && rowIndex !== undefined && hooks.onOpenCell) {
          return hooks.onOpenCell(contextOf(rowIndex, col.index))
        }
        return startEdit(r, c)
      }
    }
  }

  // ---- Render ----
  const noMatch = Boolean(filter || search)
  const hiddenByFind = findText.trim() !== '' && rowIndexes.length < rows.length
  const readOnlyReason =
    data?.table.kind === 'view'
      ? t('rows.grid.viewReadOnly')
      : data?.permissions.readOnly
        ? t('rows.grid.readOnly')
        : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-6 pb-3">
        {model && (
          <FilterBuilder
            columns={model.columns}
            applied={filter}
            onApply={applyFilter}
            preferredOperator={
              prefs['rows.defaultStringOperator'] === 'starts with' ? 'starts with' : 'contains'
            }
          />
        )}
        <TableSearch
          key={`${db}.${table}`}
          applied={search}
          onSearch={applySearch}
          disabled={!model}
        />
        <PageFind
          value={findText}
          onChange={setFindText}
          matches={rowIndexes.length}
          total={rows.length}
        />
      </div>
      {/* Second band: the table's jobs on the left, the view's controls on the right, one edge each. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {readOnlyReason && (
            <span className="rounded bg-[var(--pill-neutral-bg)] px-2 text-xs leading-5 text-[var(--pill-neutral-ink)]">
              {readOnlyReason}
            </span>
          )}
          <SelectionSummary count={chosen.length} onClear={() => setSelection(clearSelection())} />
          {hooks.toolbar?.(snapshot)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {model && (
            <ColumnMenu
              columns={model.columns}
              layout={layout}
              onLayout={changeLayout}
              display={display}
              onDisplay={changeDisplay}
              canEdit={
                Boolean(hooks.renderEditor) &&
                !data?.permissions.readOnly &&
                data?.table.kind !== 'view'
              }
            />
          )}
          <Button
            onClick={() => void query.refetch()}
            aria-label={t('rows.grid.refresh')}
            className="pointer-coarse:h-11"
          >
            <RefreshCw
              size={14}
              strokeWidth={1.5}
              aria-hidden
              className={cn(query.isFetching && 'animate-spin motion-reduce:animate-none')}
            />
            <span className="hidden lg:inline">{t('rows.grid.refresh')}</span>
          </Button>
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <Timer size={14} strokeWidth={1.5} aria-hidden className="flex-none" />
            <span className="hidden xl:inline">{t('rows.grid.autoRefresh')}</span>
            <span className="sr-only xl:hidden">{t('rows.grid.autoRefresh')}</span>
            <Select
              compact
              className="w-auto pointer-coarse:h-11"
              value={autoRefresh}
              onChange={(e) => setAutoRefresh(Number(e.target.value) as AutoRefreshSeconds)}
            >
              {AUTO_REFRESH_SECONDS.map((s) => (
                <option key={s} value={s}>
                  {s === 0
                    ? t('rows.grid.autoOff')
                    : s < 60
                      ? t('rows.grid.autoSeconds', { n: s })
                      : t('rows.grid.autoMinutes', { n: s / 60 })}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      <FilterChips applied={filter} onChange={applyFilter} />
      {search && (
        <div className="flex flex-wrap items-center gap-2 px-6 pb-2 text-xs text-muted">
          <span>{t('rows.search.active', { text: search.text })}</span>
          <button
            type="button"
            onClick={() => applySearch(undefined)}
            className="press rounded px-1.5 underline-offset-2 hover:text-ink hover:underline"
          >
            {t('rows.search.clear')}
          </button>
        </div>
      )}

      {query.isError && (
        <Notice
          action={
            <button
              type="button"
              className="text-ink underline"
              onClick={() => void query.refetch()}
            >
              {t('table.retry')}
            </button>
          }
        >
          {data ? t('rows.grid.refreshFailed') : t('table.error')}{' '}
          {errorText(query.error) && <span className="text-faint">{errorText(query.error)}</span>}
        </Notice>
      )}

      <div
        ref={tableRef}
        className={cn('min-h-0 flex-1 overflow-auto', query.isFetching && data && 'opacity-70')}
      >
        {!data ? (
          query.isError ? null : (
            <GridSkeleton />
          )
        ) : data.rows.length === 0 ? (
          <div className="px-6 py-4 text-sm text-muted">
            <p>{noMatch ? t('rows.grid.noMatch') : t('table.empty')}</p>
            {noMatch && (
              <Button
                className="mt-3"
                onClick={() => {
                  applyFilter(undefined)
                  applySearch(undefined)
                }}
              >
                {t('rows.grid.clearFilters')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <p id={`${gridId}-help`} className="sr-only">
              {t('rows.grid.keyboardHelp')}
            </p>
            <GridTable
              response={data}
              columns={columns}
              rowIndexes={rowIndexes}
              sort={sort}
              onSort={applySort}
              onResize={(name, width) => setDrag({ name, width })}
              onResizeCommit={(name, width) => {
                setDrag(null)
                changeLayout(setColumnWidth(layout, name, width))
              }}
              selection={selection}
              headerState={headerStateOf(selection, rowIndexes)}
              onToggleAll={() => setSelection(toggleHeader(selection, rowIndexes))}
              onToggleRow={(index, shift) =>
                setSelection(toggleRow(selection, index, rowIndexes, shift))
              }
              display={display}
              locale={locale}
              renderers={renderers}
              hooks={hooks}
              snapshot={snapshot}
              contextOf={contextOf}
              focus={focus}
              onFocusCell={(r, c) => setFocus((f) => (f.r === r && f.c === c ? f : { r, c }))}
              editing={editing}
              onStartEdit={startEdit}
              renderEditor={renderEditor}
              onKeyDown={onKeyDown}
              describedBy={`${gridId}-help`}
              busy={query.isFetching}
              label={t('rows.grid.label', { table })}
            />
            {hiddenByFind && rowIndexes.length === 0 && (
              <p className="px-6 py-3 text-sm text-muted">{t('rows.search.pageNone')}</p>
            )}
          </>
        )}
      </div>

      <footer>
        {data && <SqlStrip sql={statement?.stamp === stamp ? statement.sql : data.sqlShown} />}
        <div className="border-t border-rule">
          <Pager
            page={data?.page ?? page}
            pageSize={pageSize}
            pageSizes={limits.pageSizes}
            rowsOnPage={data?.rows.length ?? 0}
            hasNext={data?.hasNext ?? false}
            hasPrev={data?.hasPrev ?? false}
            total={total}
            count={count.view}
            pageMs={data?.timings.pageMs}
            busy={!data}
            deepOffset={data?.deepOffset}
            onPage={setPage}
            onPageSize={applyPageSize}
            onCount={startCount}
            onCancelCount={cancelCount}
          />
        </div>
      </footer>
    </div>
  )
}

const EMPTY_ROWS: Cell[][] = []
