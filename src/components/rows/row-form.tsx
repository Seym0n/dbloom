/**
 * Insert, copy, edit and bulk-edit form of one table (FR-ROW-015, 016, 018, 025, SCN-037, 039, 041).
 *
 * The form tracks, per field, the original server value and a dirty flag. Only dirty fields are written, so
 * opening a row and saving it without changes sends nothing and never alters stored data (DATA-ISS-010).
 * Statements are never built here: the form sends a typed `RowChange`; the server builds, classifies and
 * previews the SQL and asks for confirmation through `useRowChanger`.
 */
import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Eye, Plus } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { t } from '~/i18n'
import {
  MAX_BULK_ROWS,
  MAX_INSERT_ROWS,
  type Cell,
  type FkInfo,
  type FnName,
  type GuardValue,
  type PreviewRowsResponse,
  type ReadRowResponse,
  type RowChange,
  type RowColumn,
  type RowPermissions,
  type RowTable,
  type WireValue,
} from '~/server/rows/types'
import {
  Alert,
  PlanPreviewDialog,
  SqlBlock,
  rowsText,
  useRowChanger,
  type DoneResponse,
  type Failure,
} from './delete-dialog'
import { FkBody } from './fk-picker'
import {
  DEFAULT_UPLOAD_BYTES,
  NULL_WIRE,
  RowFormContext,
  functionsFor,
  initialWire,
  insertInitial,
  isBinaryKind,
  isDirty,
  isGenerated,
  isPartialCell,
  sendInInsert,
  tryGuard,
  validateWire,
  wireEqual,
  type FieldError,
  type LoadFullResult,
  type RowFormContextValue,
} from './form-core'
import type { EditorValue, ValueEditorProps } from './registry'
import { formsApi, describeRowsRefusal } from './server-api-forms'
import { EditorShell, fnLabel, valueEditors } from './value-editors'

export type FormMode = 'insert' | 'copy' | 'edit' | 'bulk-edit'

/** Rows selected in the grid for a bulk edit: the key and the cells of each (aligned with `columns`). */
export type BulkSelection = {
  columns: string[]
  rows: { key: Record<string, GuardValue>; cells: Cell[] }[]
}

type Field = {
  original: Cell
  digest?: string
  /** What an untouched field holds; the insert form sends a field only when it moved away from this. */
  initial: WireValue
  current: WireValue
  touched: boolean
}
type Block = Record<string, Field>

const FULL_VALUE_BYTES = 16 * 1024 * 1024

// ---- Pure logic (tested directly) -----------------------------------------------------------------------------------------

export function makeInsertBlock(model: RowTable, presets?: Record<string, string | null>): Block {
  const block: Block = {}
  for (const column of model.columns) {
    if (isGenerated(column)) continue
    const initial = insertInitial(column)
    const preset = presets?.[column.name]
    const current: WireValue =
      preset === undefined ? initial : preset === null ? NULL_WIRE : { t: 'v', v: preset }
    block[column.name] = { original: null, initial, current, touched: preset !== undefined }
  }
  return block
}

/** The block of an edit form from the row `readRow` returned. */
export function blockFromRow(
  model: RowTable,
  row: Extract<ReadRowResponse, { found: true }>,
): Block {
  const block: Block = {}
  for (const column of model.columns) {
    const index = row.columns.indexOf(column.name)
    const cell = index >= 0 ? row.cells[index] : undefined
    if (cell === undefined) continue
    const initial = initialWire(column, cell)
    block[column.name] = {
      original: cell,
      digest: row.digests[column.name],
      initial,
      current: initial,
      touched: false,
    }
  }
  return block
}

/** The block of a copy: every value of the source, auto-increment and generated columns left to the server. */
export function blockForCopy(
  model: RowTable,
  row: Extract<ReadRowResponse, { found: true }>,
  full: Record<string, string>,
): Block {
  const block: Block = {}
  for (const column of model.columns) {
    if (isGenerated(column)) continue
    const initial = insertInitial(column)
    const index = row.columns.indexOf(column.name)
    let cell: Cell | undefined = index >= 0 ? row.cells[index] : undefined
    if (cell !== undefined && column.name in full) cell = full[column.name] ?? null
    let current: WireValue = initial
    if (column.autoIncrement || cell === undefined) current = initial
    else if (
      isPartialCell(cell) &&
      !(typeof cell === 'object' && 'binary' in cell && cell.size <= 32)
    ) {
      current = initial
    } else current = initialWire(column, cell)
    block[column.name] = { original: null, initial, current, touched: true }
  }
  return block
}

export function makeBulkBlock(model: RowTable): Block {
  const block: Block = {}
  for (const column of model.columns) {
    if (isGenerated(column)) continue
    const initial: WireValue =
      column.kind === 'enum' ? { t: 'v', v: column.members?.[0] ?? '' } : { t: 'v', v: '' }
    block[column.name] = { original: null, initial, current: initial, touched: false }
  }
  return block
}

export const fieldKey = (block: number, column: string) => `${block}:${column}`

export const fieldIsDirty = (mode: FormMode, column: RowColumn, f: Field): boolean =>
  mode === 'edit'
    ? isDirty(column, f.original, f.current, f.touched)
    : !wireEqual(f.initial, f.current)

/** Why a column cannot be edited in this form, or null (generated, privileges, read-only connection). */
export function disabledReason(
  column: RowColumn,
  mode: FormMode,
  permissions: RowPermissions,
): 'generated' | 'read-only' | 'privilege' | null {
  if (isGenerated(column)) return 'generated'
  if (permissions.readOnly) return 'read-only'
  if (mode === 'insert' || mode === 'copy') {
    return !permissions.insert || column.privileges?.insert === false ? 'privilege' : null
  }
  if (!permissions.update || column.privileges?.update === false) return 'privilege'
  if (permissions.updateColumns && !permissions.updateColumns.includes(column.name))
    return 'privilege'
  return null
}

/** Columns a bulk edit may set: no digest kinds (they need one row's digest), no binary, no unknown kind. */
export function bulkEligible(column: RowColumn): boolean {
  return (
    !isGenerated(column) &&
    column.kind !== 'unknown' &&
    column.kind !== 'float' &&
    column.kind !== 'json' &&
    column.kind !== 'geometry' &&
    !isBinaryKind(column.kind)
  )
}

export type BuildArgs = {
  mode: FormMode
  model: RowTable
  blocks: Block[]
  ignore: boolean
  rowKey?: Record<string, GuardValue>
  bulk?: BulkSelection
  bulkColumns?: ReadonlySet<string>
}
export type BuildResult = {
  change: RowChange | null
  errors: Record<string, FieldError>
  noChanges: boolean
}

/** The `RowChange` of the form, with the field-level validation of FR-ROW-025. Pure. */
export function buildFormChange(args: BuildArgs): BuildResult {
  const { mode, model, blocks } = args
  const errors: Record<string, FieldError> = {}
  const check = (bi: number, column: RowColumn, wire: WireValue) => {
    const error = validateWire(column, wire)
    if (error) errors[fieldKey(bi, column.name)] = error
  }

  if (mode === 'insert' || mode === 'copy') {
    const rows = blocks.map((block, bi) => {
      const record: Record<string, WireValue> = {}
      for (const column of model.columns) {
        const f = block[column.name]
        if (!f || isGenerated(column)) continue
        if (!sendInInsert(column, f.initial, f.current)) continue
        check(bi, column, f.current)
        record[column.name] = f.current
      }
      return record
    })
    return {
      change: Object.keys(errors).length > 0 ? null : { op: 'insert', rows, ignore: args.ignore },
      errors,
      noChanges: false,
    }
  }

  if (mode === 'edit') {
    const block = blocks[0]
    if (!block || !args.rowKey) return { change: null, errors, noChanges: true }
    const set: Record<string, WireValue> = {}
    const old: Record<string, GuardValue> = {}
    for (const column of model.columns) {
      const f = block[column.name]
      if (!f || isGenerated(column) || !fieldIsDirty('edit', column, f)) continue
      check(0, column, f.current)
      set[column.name] = f.current
      const guard = tryGuard(column, f.original, f.digest)
      if (guard) old[column.name] = guard
    }
    if (Object.keys(set).length === 0) return { change: null, errors, noChanges: true }
    return {
      change:
        Object.keys(errors).length > 0
          ? null
          : { op: 'update', targets: [{ key: args.rowKey, old }], set },
      errors,
      noChanges: false,
    }
  }

  const block = blocks[0]
  const chosen = args.bulkColumns ?? new Set<string>()
  if (!block || !args.bulk || chosen.size === 0) return { change: null, errors, noChanges: true }
  const set: Record<string, WireValue> = {}
  for (const column of model.columns) {
    const f = block[column.name]
    if (!f || !chosen.has(column.name)) continue
    check(0, column, f.current)
    set[column.name] = f.current
  }
  const targets = args.bulk.rows.map((row) => {
    const old: Record<string, GuardValue> = {}
    for (const name of Object.keys(set)) {
      const column = model.columns.find((c) => c.name === name)
      const index = args.bulk?.columns.indexOf(name) ?? -1
      const cell = index >= 0 ? row.cells[index] : undefined
      if (!column || cell === undefined) continue
      const guard = tryGuard(column, cell)
      if (guard) old[name] = guard
    }
    return { key: row.key, old }
  })
  return {
    change: Object.keys(errors).length > 0 ? null : { op: 'update', targets, set },
    errors,
    noChanges: false,
  }
}

type Item = { kind: 'column'; column: RowColumn } | { kind: 'fk'; fk: FkInfo; columns: RowColumn[] }

/** Single fields and composite foreign keys (their columns are picked together, DATA-ISS-012). */
export function buildItems(model: RowTable, showInvisible: boolean, mode: FormMode): Item[] {
  const visible = (c: RowColumn) => showInvisible || !c.invisible || mode === 'bulk-edit'
  const grouped = new Map<string, FkInfo>()
  for (const fk of model.outgoing) {
    if (fk.columns.length < 2) continue
    const columns = fk.columns.map((n) => model.columns.find((c) => c.name === n))
    if (columns.some((c) => !c || isGenerated(c) || c.kind === 'unknown' || !visible(c))) continue
    if (fk.columns.some((n) => grouped.has(n))) continue
    for (const n of fk.columns) grouped.set(n, fk)
  }
  const items: Item[] = []
  const done = new Set<FkInfo>()
  for (const column of model.columns) {
    if (!visible(column)) continue
    const fk = grouped.get(column.name)
    if (fk) {
      if (done.has(fk)) continue
      done.add(fk)
      items.push({
        kind: 'fk',
        fk,
        columns: fk.columns.flatMap((n) => model.columns.filter((c) => c.name === n)),
      })
    } else items.push({ kind: 'column', column })
  }
  return items
}

const errorText = (error: FieldError | undefined) =>
  error ? t(error.key, error.values) : undefined

// ---- Components -------------------------------------------------------------------------------------------------------------------

export type RowFormProps = {
  open: boolean
  db: string
  model: RowTable
  mode: FormMode
  permissions: RowPermissions
  timeZone?: string
  locale?: string
  uploadBytes?: number
  /** Skip the confirmation of soft plans (ST-120). */
  acceptSoft?: boolean
  /** Insert: number of blank rows to start with (`rows.insertRows`). */
  insertRows?: number
  /** Edit and copy: key of the source row. */
  rowKey?: Record<string, GuardValue>
  /** Insert: values to preset, keyed by column (the foreign key of "Insert row" in the referencing panel). */
  presets?: Record<string, string | null>
  /** Bulk edit. */
  bulk?: BulkSelection
  /** Edit: open the neighbouring row of the page after saving (FR-DTB-135). */
  neighbours?: { previous?: () => void; next?: () => void }
  /** True while there are unsaved edits (the grid pauses auto-refresh, FR-ROW-028). */
  onDirtyChange?: (dirty: boolean) => void
  onClose: () => void
  /** The change was applied; the grid refreshes and shows the statements. */
  onChanged: (response: DoneResponse) => void
}

export function RowForm(props: RowFormProps) {
  const titleId = useId()
  // The dialog's Escape and backdrop go through the body, which knows whether anything is unsaved.
  const closeRef = useRef<(() => void) | null>(null)
  return (
    <Dialog
      open={props.open}
      onClose={() => (closeRef.current ? closeRef.current() : props.onClose())}
      labelledBy={titleId}
      className="w-[min(920px,calc(100vw-32px))]"
    >
      {props.open && <FormBody {...props} titleId={titleId} closeRef={closeRef} />}
    </Dialog>
  )
}

const flagsOf = (model: RowTable, column: RowColumn): string[] => {
  const flags: string[] = []
  if (model.primaryKey?.includes(column.name)) flags.push(t('rows.form.flag.primary'))
  if (column.autoIncrement) flags.push(t('rows.form.flag.autoIncrement'))
  if (column.generated) flags.push(t('rows.form.flag.generated', { kind: column.generated }))
  if (column.invisible) flags.push(t('rows.form.flag.invisible'))
  if (!column.nullable) flags.push(t('rows.form.flag.required'))
  return flags
}

function FormBody(
  props: RowFormProps & { titleId: string; closeRef: { current: (() => void) | null } },
) {
  const { db, model, mode, permissions, titleId, closeRef } = props
  const locale = props.locale ?? 'en-US'
  const insertLike = mode === 'insert' || mode === 'copy'
  const formRoot = useRef<HTMLDivElement>(null)
  const [blocks, setBlocks] = useState<Block[]>(() =>
    mode === 'insert'
      ? Array.from({ length: Math.min(Math.max(props.insertRows ?? 1, 1), MAX_INSERT_ROWS) }, () =>
          makeInsertBlock(model, props.presets),
        )
      : mode === 'bulk-edit'
        ? [makeBulkBlock(model)]
        : [],
  )
  const [load, setLoad] = useState<
    | { status: 'loading' }
    | { status: 'ready' }
    | { status: 'gone' }
    | { status: 'error'; message: string }
  >({ status: mode === 'edit' || mode === 'copy' ? 'loading' : 'ready' })
  const [errors, setErrors] = useState<Record<string, FieldError>>({})
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState<{
    tone: 'info' | 'error'
    text: string
    hint?: string
  } | null>(null)
  const [ignore, setIgnore] = useState(false)
  const [showInvisible, setShowInvisible] = useState(false)
  const [bulkColumns, setBulkColumns] = useState<ReadonlySet<string>>(new Set())
  const [result, setResult] = useState<DoneResponse | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [preview, setPreview] = useState<{
    loading: boolean
    info: PreviewRowsResponse | null
    error: string | null
  } | null>(null)
  const [nested, setNested] = useState<{
    fk: FkInfo
    model: RowTable
    permissions: RowPermissions
    resolve: (key: Record<string, string | null> | null) => void
  } | null>(null)
  const after = useRef<'close' | 'next' | 'previous'>('close')
  const hasInvisible = model.columns.some((c) => c.invisible)

  // ---- Loading the row of an edit or a copy ----
  useEffect(() => {
    if (mode !== 'edit' && mode !== 'copy') return
    if (!props.rowKey) {
      setLoad({ status: 'error', message: t('rows.form.refusal.noIdentity') })
      return
    }
    const rowKey = props.rowKey
    let live = true
    formsApi()
      .readRow({ db, table: model.table, key: rowKey, includeInvisible: hasInvisible })
      .then(async (row) => {
        if (!live) return
        if (!row.found) {
          setLoad({ status: 'gone' })
          return
        }
        if (mode === 'edit') {
          setBlocks([blockFromRow(model, row)])
        } else {
          // Cut text is copied whole: it is read in full before the form opens.
          const full: Record<string, string> = {}
          for (const column of model.columns) {
            const index = row.columns.indexOf(column.name)
            const cell = index >= 0 ? row.cells[index] : undefined
            if (cell && typeof cell === 'object' && 'cut' in cell && !isGenerated(column)) {
              const r = await formsApi().readCell({
                db,
                table: model.table,
                key: rowKey,
                column: column.name,
                maxBytes: FULL_VALUE_BYTES,
              })
              if (r.found && r.value.t === 'text') full[column.name] = r.value.text
            }
          }
          if (!live) return
          setBlocks([blockForCopy(model, row, full)])
        }
        setLoad({ status: 'ready' })
      })
      .catch(
        (e: unknown) =>
          live && setLoad({ status: 'error', message: describeRowsRefusal(e).message }),
      )
    return () => {
      live = false
    }
    // The row is loaded once per opening.
  }, [])

  const dirtyCount = useMemo(() => {
    if (mode === 'bulk-edit') return bulkColumns.size
    let n = 0
    blocks.forEach((block) => {
      for (const column of model.columns) {
        const f = block[column.name]
        if (f && fieldIsDirty(mode, column, f)) n += 1
      }
    })
    return n
  }, [blocks, bulkColumns, mode, model.columns])
  const dirty = dirtyCount > 0 && result === null
  const onDirtyChange = props.onDirtyChange
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // ---- Field changes ----
  const setField = useCallback((bi: number, name: string, wire: WireValue) => {
    setBlocks((prev) =>
      prev.map((block, i) => {
        const f = block[name]
        if (i !== bi || !f) return block
        return { ...block, [name]: { ...f, current: wire, touched: true } }
      }),
    )
    setErrors((prev) => {
      const key = fieldKey(bi, name)
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setServerErrors((prev) => {
      const key = fieldKey(bi, name)
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  // ---- Sending ----
  const changer = useRowChanger({
    db,
    table: model.table,
    model,
    acceptSoft: props.acceptSoft,
    onDone: (response) => {
      props.onChanged(response)
      setBanner(null)
      if (insertLike || response.warnings.length > 0) {
        setResult(response)
        return
      }
      const go = after.current
      props.onClose()
      if (go === 'next') props.neighbours?.next?.()
      if (go === 'previous') props.neighbours?.previous?.()
    },
    onError: (failure: Failure) => {
      setBanner({ tone: 'error', text: failure.message, hint: failure.hint })
      if (failure.field) {
        setServerErrors((prev) => ({
          ...prev,
          [fieldKey(failure.rowIndex ?? 0, failure.field ?? '')]: failure.message,
        }))
      }
      focusFirstInvalid()
    },
    onReload: (conflict) => {
      // Reload row: the server's current values become the originals; the user's edits stay on top of them.
      if (mode !== 'edit') return
      setBlocks((prev) =>
        prev.map((block) => {
          const next: Block = {}
          for (const column of model.columns) {
            const f = block[column.name]
            const index = conflict.columns.indexOf(column.name)
            const cell = index >= 0 ? conflict.current[index] : undefined
            if (!f || cell === undefined) continue
            const initial = initialWire(column, cell)
            const keep = f.touched && !wireEqual(f.current, f.initial)
            next[column.name] = {
              original: cell,
              digest: conflict.digests[column.name] ?? f.digest,
              initial,
              current: keep ? f.current : initial,
              touched: keep,
            }
          }
          return next
        }),
      )
      setBanner({ tone: 'info', text: t('rows.form.reloaded') })
    },
  })

  function focusFirstInvalid() {
    requestAnimationFrame(() => {
      formRoot.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus({ preventScroll: false })
    })
  }

  function build() {
    const built = buildFormChange({
      mode,
      model,
      blocks,
      ignore,
      rowKey: props.rowKey,
      bulk: props.bulk,
      bulkColumns,
    })
    setErrors(built.errors)
    setServerErrors({})
    if (Object.keys(built.errors).length > 0) {
      setBanner({
        tone: 'error',
        text: t('rows.form.fixErrors', { count: Object.keys(built.errors).length }),
      })
      focusFirstInvalid()
      return null
    }
    if (built.noChanges || !built.change) {
      setBanner({
        tone: 'info',
        text: mode === 'bulk-edit' ? t('rows.form.bulkNothing') : t('rows.form.noChanges'),
      })
      return null
    }
    if (built.change.op === 'update' && built.change.targets.length > MAX_BULK_ROWS) {
      setBanner({ tone: 'error', text: t('rows.form.bulkLimit', { max: MAX_BULK_ROWS }) })
      return null
    }
    setBanner(null)
    return built.change
  }

  function submit(go: 'close' | 'next' | 'previous' = 'close') {
    if (changer.busy || permissions.readOnly) return
    const change = build()
    if (!change) return
    after.current = go
    void changer.submit(change)
  }

  async function showSql() {
    const change = build()
    if (!change) return
    setPreview({ loading: true, info: null, error: null })
    try {
      const info = await formsApi().previewRows({ db, table: model.table, change })
      setPreview({ loading: false, info, error: null })
    } catch (e) {
      setPreview({ loading: false, info: null, error: describeRowsRefusal(e).message })
    }
  }

  // ---- Closing without losing edits ----
  const requestClose = useCallback(() => {
    if (changer.busy) return
    if (dirty) setDiscarding(true)
    else props.onClose()
  }, [changer.busy, dirty, props])
  useEffect(() => {
    closeRef.current = requestClose
    return () => {
      closeRef.current = null
    }
  }, [requestClose, closeRef])

  // ---- Context for the editors ----
  const context: RowFormContextValue = useMemo(
    () => ({
      db,
      table: model.table,
      model,
      timeZone: props.timeZone,
      uploadBytes: props.uploadBytes ?? DEFAULT_UPLOAD_BYTES,
      rowKey: props.rowKey,
      singleFk: (column) =>
        model.outgoing.find((fk) => fk.columns.length === 1 && fk.columns[0] === column),
      loadFull: async (column): Promise<LoadFullResult> => {
        if (!props.rowKey) return { ok: false, message: t('rows.form.refusal.noIdentity') }
        try {
          const r = await formsApi().readCell({
            db,
            table: model.table,
            key: props.rowKey,
            column: column.name,
            maxBytes: FULL_VALUE_BYTES,
          })
          if (!r.found) return { ok: false, message: t('rows.form.rowGone') }
          if (r.value.t === 'bytes') return { ok: false, message: t('rows.form.notText') }
          if (r.value.t === 'text' && r.value.truncated) {
            return { ok: false, message: t('rows.form.tooBig') }
          }
          const text = r.value.t === 'text' ? r.value.text : ''
          setBlocks((prev) =>
            prev.map((block) => {
              const f = block[column.name]
              if (!f) return block
              const initial = initialWire(column, text)
              return {
                ...block,
                [column.name]: {
                  original: text,
                  digest: r.digest ?? f.digest,
                  initial,
                  current: initial,
                  touched: false,
                },
              }
            }),
          )
          return { ok: true, text, digest: r.digest, truncated: false }
        } catch (e) {
          return { ok: false, message: describeRowsRefusal(e).message }
        }
      },
      createReferenced: (fk) =>
        new Promise((resolve) => {
          void formsApi()
            .getRows({ db: fk.refDb, table: fk.refTable, page: 0, pageSize: 1, sort: [] })
            .then((r) => setNested({ fk, model: r.table, permissions: r.permissions, resolve }))
            .catch(() => resolve(null))
        }),
    }),
    [db, model, props.rowKey, props.timeZone, props.uploadBytes],
  )

  const items = useMemo(() => buildItems(model, showInvisible, mode), [model, showInvisible, mode])

  // ---- Keyboard: Ctrl+Enter submits, Ctrl+Arrow moves between rows of the same column ----
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
      return
    }
    if (insertLike && e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const field = (e.target as HTMLElement).closest<HTMLElement>('[data-block][data-colix]')
      if (!field) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = formRoot.current?.querySelector<HTMLElement>(
        `[data-block="${Number(field.dataset.block) + step}"][data-colix="${field.dataset.colix}"]`,
      )
      const control = next?.querySelector<HTMLElement>('input:not([type=radio]), textarea, select')
      if (control) {
        e.preventDefault()
        control.focus()
      }
    }
  }

  const title =
    mode === 'insert'
      ? t('rows.form.title.insert', { table: model.table })
      : mode === 'copy'
        ? t('rows.form.title.copy', { table: model.table })
        : mode === 'edit'
          ? t('rows.form.title.edit', { table: model.table })
          : t('rows.form.title.bulk', { rows: rowsText(props.bulk?.rows.length ?? 0) })
  const submitLabel =
    mode === 'edit' || mode === 'bulk-edit' ? t('rows.form.save') : t('rows.form.go')
  const blocked = permissions.readOnly || load.status !== 'ready'

  function setCount(next: number) {
    const count = Math.min(Math.max(Math.trunc(next) || 1, 1), MAX_INSERT_ROWS)
    setBlocks((prev) =>
      count <= prev.length
        ? prev.slice(0, count)
        : [
            ...prev,
            ...Array.from({ length: count - prev.length }, () =>
              makeInsertBlock(model, props.presets),
            ),
          ],
    )
  }

  function applyFunction(columnName: string, fn: FnName) {
    setBlocks((prev) =>
      prev.map((block) => {
        const f = block[columnName]
        return f
          ? { ...block, [columnName]: { ...f, current: { t: 'fn', name: fn }, touched: true } }
          : block
      }),
    )
  }

  return (
    <RowFormContext.Provider value={context}>
      <div className="flex max-h-[calc(100dvh-32px)] flex-col" onKeyDown={onKeyDown}>
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold break-words">
              {title}
            </h2>
            <p className="text-sm text-muted">
              {model.db}.{model.table}
              {dirty && (
                <span className="ml-2">{t('rows.form.unsaved', { count: dirtyCount })}</span>
              )}
            </p>
          </div>
          {insertLike && result === null && (
            <Button variant="primary" disabled={blocked || changer.busy} onClick={() => submit()}>
              {t('rows.form.go')}
            </Button>
          )}
        </header>

        <div
          ref={formRoot}
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-4"
          aria-busy={load.status === 'loading' || changer.busy}
        >
          <div aria-live="polite" role="status" className="empty:hidden">
            {banner && (
              <div className="mb-3 flex flex-col gap-1">
                <Alert tone={banner.tone === 'error' ? 'negative' : 'warning'}>{banner.text}</Alert>
                {banner.hint && <p className="px-1 text-sm break-words">{banner.hint}</p>}
              </div>
            )}
          </div>
          {permissions.readOnly && (
            <div className="mb-3">
              <Alert>{t('rows.form.readOnly')}</Alert>
            </div>
          )}
          {load.status === 'loading' && (
            <p className="text-sm text-muted">{t('rows.form.loading')}</p>
          )}
          {load.status === 'gone' && <Alert tone="negative">{t('rows.dialog.gone.body')}</Alert>}
          {load.status === 'error' && <Alert tone="negative">{load.message}</Alert>}

          {result && <ResultView result={result} model={model} />}

          {load.status === 'ready' && result === null && (
            <>
              {mode === 'insert' && (
                <InsertControls
                  model={model}
                  count={blocks.length}
                  ignore={ignore}
                  onCount={setCount}
                  onIgnore={setIgnore}
                  onApply={applyFunction}
                  disabled={blocked}
                />
              )}
              {hasInvisible && mode !== 'bulk-edit' && (
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={showInvisible}
                    onChange={(e) => setShowInvisible(e.target.checked)}
                  />
                  {t('rows.form.showInvisible')}
                </label>
              )}
              {mode === 'bulk-edit' ? (
                <BulkFields
                  model={model}
                  block={blocks[0]}
                  chosen={bulkColumns}
                  errors={errors}
                  serverErrors={serverErrors}
                  disabled={blocked}
                  locale={locale}
                  onChoose={(name, on) =>
                    setBulkColumns((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(name)
                      else next.delete(name)
                      return next
                    })
                  }
                  onChange={(name, wire) => setField(0, name, wire)}
                />
              ) : (
                blocks.map((block, bi) => (
                  <section
                    key={bi}
                    aria-label={blocks.length > 1 ? t('rows.form.rowN', { n: bi + 1 }) : undefined}
                    className={cn(
                      blocks.length > 1 && 'mb-4 rounded-[var(--radius-card)] bg-raised/50 p-3',
                    )}
                  >
                    {blocks.length > 1 && (
                      <h3 className="mb-1 text-sm font-semibold">
                        {t('rows.form.rowN', { n: bi + 1 })}
                      </h3>
                    )}
                    {items.map((item, ix) => (
                      <FormItem
                        key={item.kind === 'column' ? item.column.name : item.fk.name}
                        item={item}
                        index={ix}
                        block={bi}
                        fields={block}
                        model={model}
                        mode={mode}
                        permissions={permissions}
                        errors={errors}
                        serverErrors={serverErrors}
                        locale={locale}
                        onChange={(name, wire) => setField(bi, name, wire)}
                      />
                    ))}
                  </section>
                ))
              )}
            </>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-raised px-6 py-3">
          {discarding ? (
            <>
              <span className="mr-auto text-sm" role="alert">
                {t('rows.form.discardAsk')}
              </span>
              <Button onClick={() => setDiscarding(false)}>{t('rows.form.keepEditing')}</Button>
              <Button
                variant="outline"
                className="border-negative text-negative hover:bg-[var(--pill-negative-bg)]"
                onClick={props.onClose}
              >
                {t('rows.form.discard')}
              </Button>
            </>
          ) : result ? (
            <>
              {mode === 'insert' && (
                <Button
                  onClick={() => {
                    setResult(null)
                    setBlocks([makeInsertBlock(model, props.presets)])
                  }}
                >
                  {t('rows.form.insertMore')}
                </Button>
              )}
              <Button variant="primary" onClick={props.onClose}>
                {t('rows.dialog.close')}
              </Button>
            </>
          ) : (
            <>
              <Button disabled={blocked || changer.busy} onClick={() => void showSql()}>
                <Eye size={14} aria-hidden />
                {t('rows.form.showSql')}
              </Button>
              <Button disabled={changer.busy} onClick={requestClose}>
                {t('rows.dialog.cancel')}
              </Button>
              {mode === 'edit' && props.neighbours?.previous && (
                <Button disabled={blocked || changer.busy} onClick={() => submit('previous')}>
                  {t('rows.form.saveAndPrevious')}
                </Button>
              )}
              {mode === 'edit' && props.neighbours?.next && (
                <Button disabled={blocked || changer.busy} onClick={() => submit('next')}>
                  {t('rows.form.saveAndNext')}
                </Button>
              )}
              <Button variant="primary" disabled={blocked || changer.busy} onClick={() => submit()}>
                {changer.busy ? t('rows.dialog.working') : submitLabel}
              </Button>
            </>
          )}
        </footer>
      </div>

      {changer.dialogs}
      <PlanPreviewDialog
        open={preview !== null}
        loading={preview?.loading ?? false}
        info={preview?.info ?? null}
        error={preview?.error ?? null}
        tableName={model.table}
        onClose={() => setPreview(null)}
      />
      {nested && (
        <RowForm
          open
          db={nested.fk.refDb}
          model={nested.model}
          mode="insert"
          permissions={nested.permissions}
          timeZone={props.timeZone}
          locale={locale}
          uploadBytes={props.uploadBytes}
          acceptSoft={props.acceptSoft}
          onClose={() => {
            nested.resolve(null)
            setNested(null)
          }}
          onChanged={(response) => {
            nested.resolve(newKeyOf(nested.fk, response))
            setNested(null)
          }}
        />
      )}
    </RowFormContext.Provider>
  )
}

/** The key of a row created from the picker, read from the re-read row of the answer (UI-ISS-110). */
export function newKeyOf(fk: FkInfo, response: DoneResponse): Record<string, string | null> {
  const row = response.rows[0]
  const key: Record<string, string | null> = {}
  fk.refColumns.forEach((column, i) => {
    const index = response.columns.indexOf(column)
    const cell = index >= 0 ? row?.[index] : undefined
    const fallback = i === 0 ? (response.outcomes[0]?.insertId ?? null) : null
    key[column] = typeof cell === 'string' ? cell : fallback
  })
  return key
}

// ---- Fields -------------------------------------------------------------------------------------------------------------------------

function editorValueOf(mode: FormMode, column: RowColumn, f: Field): EditorValue {
  return {
    original: f.original,
    digest: f.digest,
    current: f.current,
    dirty: fieldIsDirty(mode, column, f),
  }
}

function FieldFrame({
  label,
  type,
  flags,
  comment,
  dirty,
  error,
  labelId,
  descId,
  block,
  index,
  children,
}: {
  label: string
  type?: string
  flags: string[]
  comment?: string
  dirty: boolean
  error?: string
  labelId: string
  descId: string
  block: number
  index: number
  children: ReactNode
}) {
  return (
    <div
      data-block={block}
      data-colix={index}
      className="grid gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <label id={labelId} htmlFor={`${labelId}-in`} className="text-sm font-medium break-words">
          {label}
        </label>
        {type && <p className="font-mono text-xs break-words text-muted">{type}</p>}
        {flags.length > 0 && <p className="text-xs text-muted">{flags.join(' · ')}</p>}
        {dirty && (
          <p className="text-xs font-medium text-[var(--accent)]">{t('rows.form.changed')}</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {error && (
          <p id={descId} className="text-xs text-negative">
            {error}
          </p>
        )}
        {comment && <p className="text-xs text-muted">{comment}</p>}
      </div>
    </div>
  )
}

function FormItem({
  item,
  index,
  block,
  fields,
  model,
  mode,
  permissions,
  errors,
  serverErrors,
  locale,
  onChange,
}: {
  item: Item
  index: number
  block: number
  fields: Block
  model: RowTable
  mode: FormMode
  permissions: RowPermissions
  errors: Record<string, FieldError>
  serverErrors: Record<string, string>
  locale: string
  onChange: (column: string, wire: WireValue) => void
}) {
  const labelId = useId()
  const descId = `${labelId}-desc`

  if (item.kind === 'fk') {
    const present = item.columns.map((c) => fields[c.name])
    if (present.some((f) => !f)) return null
    const list = present as Field[]
    const reasons = item.columns.map((c) => disabledReason(c, mode, permissions))
    const disabled = reasons.some((r) => r !== null)
    const message = item.columns
      .map(
        (c) => errorText(errors[fieldKey(block, c.name)]) ?? serverErrors[fieldKey(block, c.name)],
      )
      .find((m) => m !== undefined)
    const keys = list.map((f) => (f.current.t === 'v' ? f.current.v : null))
    const dirty = item.columns.some((c, i) => {
      const f = list[i]
      return f ? fieldIsDirty(mode, c, f) : false
    })
    return (
      <FieldFrame
        label={item.columns.map((c) => c.name).join(', ')}
        type={t('rows.form.fkTo', { table: item.fk.refTable })}
        flags={[]}
        dirty={dirty}
        error={message}
        labelId={labelId}
        descId={descId}
        block={block}
        index={index}
      >
        <FkBody
          fk={item.fk}
          keys={keys}
          disabled={disabled}
          labelId={labelId}
          describedById={descId}
          invalid={Boolean(message)}
          onPick={(picked) =>
            item.columns.forEach((c, i) => {
              const v = picked[i]
              onChange(c.name, v === null || v === undefined ? NULL_WIRE : { t: 'v', v })
            })
          }
        />
        {item.columns.every((c) => c.nullable) && (
          <Button
            className="w-fit"
            disabled={disabled}
            onClick={() => item.columns.forEach((c) => onChange(c.name, NULL_WIRE))}
          >
            {t('rows.fk.clear')}
          </Button>
        )}
      </FieldFrame>
    )
  }

  const { column } = item
  const f = fields[column.name]
  if (!f) {
    if (isGenerated(column) && mode !== 'edit') {
      return (
        <FieldFrame
          label={column.name}
          type={column.fullType}
          flags={flagsOf(model, column)}
          dirty={false}
          labelId={labelId}
          descId={descId}
          block={block}
          index={index}
        >
          <p id={`${labelId}-in`} className="min-h-10 text-sm text-muted">
            {t('rows.form.generatedReadOnly')}
          </p>
        </FieldFrame>
      )
    }
    return null
  }
  const reason = disabledReason(column, mode, permissions)
  const message =
    errorText(errors[fieldKey(block, column.name)]) ?? serverErrors[fieldKey(block, column.name)]
  const value = editorValueOf(mode, column, f)
  const props: ValueEditorProps = {
    column,
    value,
    onChange: (wire) => onChange(column.name, wire),
    disabled: reason !== null,
    error: message,
    labelId,
    describedById: descId,
    mode: mode === 'edit' ? 'edit' : 'insert',
    locale,
  }
  const fk = model.outgoing.find((o) => o.columns.length === 1 && o.columns[0] === column.name)
  const flags = flagsOf(model, column)
  if (reason === 'privilege') flags.push(t('rows.form.noPrivilege'))
  return (
    <FieldFrame
      label={column.name}
      type={column.fullType}
      flags={flags}
      comment={column.comment || undefined}
      dirty={value.dirty}
      error={message}
      labelId={labelId}
      descId={descId}
      block={block}
      index={index}
    >
      {reason === 'generated' ? (
        <p id={`${labelId}-in`} className="min-h-10 text-sm break-words text-muted">
          {f.original === null
            ? 'NULL'
            : typeof f.original === 'string'
              ? f.original
              : t('rows.form.generatedReadOnly')}
          <span className="ml-2 text-xs">{t('rows.form.generatedReadOnly')}</span>
        </p>
      ) : fk && column.kind !== 'unknown' ? (
        <EditorShell props={props}>
          <FkBody
            fk={fk}
            keys={[f.current.t === 'v' ? f.current.v : null]}
            disabled={props.disabled}
            labelId={labelId}
            describedById={descId}
            invalid={Boolean(message)}
            onType={(text) => onChange(column.name, { t: 'v', v: text })}
            onPick={(picked) => {
              const v = picked[0]
              onChange(column.name, v === null || v === undefined ? NULL_WIRE : { t: 'v', v })
            }}
          />
        </EditorShell>
      ) : (
        createElement(valueEditors.get(column.kind), props)
      )}
    </FieldFrame>
  )
}

function BulkFields({
  model,
  block,
  chosen,
  errors,
  serverErrors,
  disabled,
  locale,
  onChoose,
  onChange,
}: {
  model: RowTable
  block: Block | undefined
  chosen: ReadonlySet<string>
  errors: Record<string, FieldError>
  serverErrors: Record<string, string>
  disabled: boolean
  locale: string
  onChoose: (column: string, on: boolean) => void
  onChange: (column: string, wire: WireValue) => void
}) {
  if (!block) return null
  return (
    <div className="flex flex-col">
      <p className="pb-2 text-sm text-muted">{t('rows.form.bulkHint')}</p>
      {model.columns
        .filter((c) => !isGenerated(c))
        .map((column) => (
          <BulkField
            key={column.name}
            column={column}
            field={block[column.name]}
            checked={chosen.has(column.name)}
            error={
              errorText(errors[fieldKey(0, column.name)]) ?? serverErrors[fieldKey(0, column.name)]
            }
            disabled={disabled}
            locale={locale}
            onChoose={(on) => onChoose(column.name, on)}
            onChange={(wire) => onChange(column.name, wire)}
          />
        ))}
    </div>
  )
}

function BulkField({
  column,
  field,
  checked,
  error,
  disabled,
  locale,
  onChoose,
  onChange,
}: {
  column: RowColumn
  field: Field | undefined
  checked: boolean
  error?: string
  disabled: boolean
  locale: string
  onChoose: (on: boolean) => void
  onChange: (wire: WireValue) => void
}) {
  const labelId = useId()
  const checkId = useId()
  const eligible = bulkEligible(column) && field !== undefined
  const props: ValueEditorProps | null = field
    ? {
        column,
        value: { original: null, current: field.current, dirty: checked },
        onChange,
        disabled,
        error,
        labelId,
        describedById: `${labelId}-desc`,
        mode: 'insert',
        locale,
      }
    : null
  return (
    <div className="grid gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 items-start gap-2">
        <Checkbox
          id={checkId}
          checked={checked}
          disabled={disabled || !eligible}
          onChange={(e) => onChoose(e.target.checked)}
        />
        <div className="min-w-0">
          <label id={labelId} htmlFor={checkId} className="text-sm font-medium break-words">
            {column.name}
          </label>
          <p className="font-mono text-xs break-words text-muted">{column.fullType}</p>
          {!eligible && <p className="text-xs text-muted">{t('rows.form.bulkNotEligible')}</p>}
        </div>
      </div>
      <div className="min-w-0">
        {checked && props && eligible ? createElement(valueEditors.get(column.kind), props) : null}
        {error && (
          <p id={`${labelId}-desc`} className="text-xs text-negative">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

function InsertControls({
  model,
  count,
  ignore,
  disabled,
  onCount,
  onIgnore,
  onApply,
}: {
  model: RowTable
  count: number
  ignore: boolean
  disabled: boolean
  onCount: (n: number) => void
  onIgnore: (on: boolean) => void
  onApply: (column: string, fn: FnName) => void
}) {
  const countId = useId()
  const candidates = model.columns.filter((c) => !isGenerated(c) && functionsFor(c).length > 0)
  const [column, setColumn] = useState(candidates[0]?.name ?? '')
  const chosen = candidates.find((c) => c.name === column)
  const fns = chosen ? functionsFor(chosen) : []
  const [fn, setFn] = useState(fns[0] ?? 'now')
  const fnValid = fns.includes(fn) ? fn : (fns[0] ?? 'now')
  return (
    <div className="mb-3 flex flex-col gap-3 rounded-[var(--radius-card)] bg-raised p-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <label htmlFor={countId} className="text-sm font-medium">
            {t('rows.form.rowCount')}
          </label>
          <Input
            id={countId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_INSERT_ROWS}
            className="h-10 w-20"
            disabled={disabled}
            value={count}
            onChange={(e) => onCount(Number(e.target.value))}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={ignore}
            disabled={disabled}
            onChange={(e) => onIgnore(e.target.checked)}
          />
          {t('rows.form.ignore')}
        </label>
      </div>
      {candidates.length > 0 && count > 1 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t('rows.form.applyColumn')}</span>
            <Select
              aria-label={t('rows.form.applyColumn')}
              className="w-44"
              value={column}
              disabled={disabled}
              onChange={(e) => setColumn(e.target.value)}
            >
              {candidates.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">{t('rows.form.applyFunction')}</span>
            <Select
              aria-label={t('rows.form.applyFunction')}
              className="w-52"
              value={fnValid}
              disabled={disabled}
              onChange={(e) => setFn(e.target.value as typeof fn)}
            >
              {fns.map((n) => (
                <option key={n} value={n}>
                  {fnLabel(n)}
                </option>
              ))}
            </Select>
          </div>
          <Button disabled={disabled || !chosen} onClick={() => onApply(column, fnValid)}>
            <Plus size={14} aria-hidden />
            {t('rows.form.apply')}
          </Button>
        </div>
      )}
    </div>
  )
}

function ResultView({ result, model }: { result: DoneResponse; model: RowTable }) {
  const ids = result.outcomes.filter((o) => o.insertId !== undefined && o.insertId !== '0')
  const op = result.operation
  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="text-sm font-medium">
        {op === 'insert'
          ? t('rows.form.result.inserted', {
              rows: rowsText(result.affectedRows),
              table: model.table,
            })
          : t('rows.form.result.updated', { rows: rowsText(result.affectedRows) })}
      </p>
      {ids.length > 0 && (
        <p className="text-sm">
          {t('rows.form.result.ids')}{' '}
          <span className="font-mono">{ids.map((o) => o.insertId).join(', ')}</span>
        </p>
      )}
      {result.warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('rows.form.result.warnings')}</p>
          <ul className="flex flex-col gap-1">
            {result.warnings.map((w, i) => (
              <li key={i}>
                <Alert>
                  {w.level} {w.code}: {w.message}
                </Alert>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.statements.map((s, i) => (
        <SqlBlock key={i} sql={s.preview} label={t('rows.dialog.sqlOf', { n: i + 1 })} />
      ))}
    </div>
  )
}
