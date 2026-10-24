/**
 * Cell viewer and single-cell editors (FR-ROW-011, 013, 017, SCN-038, 047, 048):
 *
 *  - `CellDialog`: text with all whitespace kept and visible markers, a read-only hex view, a JSON view,
 *    geometry as WKT with its SRID, "Load full value", copy, BLOB download/preview/upload and, where the
 *    account may, editing of the one cell. Nothing in the viewer changes the stored value.
 *  - `InlineCellEditor`: the editor shown in place of a grid cell (hook `renderEditor` of `grid-hooks.ts`).
 *    Enter saves, Esc cancels, Tab saves and moves on; one `UPDATE` of one column with the conflict check.
 */
import {
  createElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Braces, Check, Copy, Pencil } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { t, type MessageKey } from '~/i18n'
import type {
  Cell,
  GuardValue,
  Identity,
  RowChange,
  RowColumn,
  RowPermissions,
  RowTable,
  WireValue,
} from '~/server/rows/types'
import type { CellContext, CellEditContext } from './grid-hooks'
import { BlobActions, storedSize } from './blob-field'
import { Alert, useRowChanger, type DoneResponse } from './delete-dialog'
import {
  DEFAULT_UPLOAD_BYTES,
  NULL_WIRE,
  RowFormContext,
  editText,
  formatBytes,
  hexDump,
  hexToBytes,
  initialWire,
  isBinaryKind,
  isGenerated,
  isPartialCell,
  markControls,
  prettyJson,
  textToBytes,
  tryGuard,
  validateWire,
  wireEqual,
  type LoadFullResult,
  type MarkerKind,
  type RowFormContextValue,
} from './form-core'
import { describeRowsRefusal, formsApi } from './server-api-forms'
import { valueEditors } from './value-editors'
import type { EditorValue, ValueEditorProps } from './registry'

const FULL_VALUE_BYTES = 16 * 1024 * 1024

// ---- Who may edit what (shared by the grid hook and the dialog) --------------------------------------------------------------

export function canEditColumn(
  column: RowColumn | undefined,
  table: RowTable,
  identity: Identity,
  permissions: RowPermissions,
  hasKey: boolean,
): boolean {
  if (!column || table.kind === 'view' || identity.kind === 'none' || !hasKey) return false
  if (permissions.readOnly || !permissions.update) return false
  if (isGenerated(column) || column.kind === 'unknown') return false
  if (column.privileges?.update === false) return false
  if (permissions.updateColumns && !permissions.updateColumns.includes(column.name)) return false
  return true
}

/** `canEditCell` of the grid hook. Kinds the in-cell editor cannot show open the cell dialog instead. */
export function canEditCell(ctx: CellContext): boolean {
  return canEditColumn(ctx.column, ctx.table, ctx.identity, ctx.permissions, ctx.key !== undefined)
}

const INLINE_KINDS: ReadonlySet<string> = new Set([
  'int',
  'decimal',
  'float',
  'bit',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'char',
  'enum',
  'uuid',
  'inet6',
])

/** True when one line of text edits the cell; long text, JSON, sets, geometry and binary use the dialog. */
export function inlineEligible(column: RowColumn, cell: Cell): boolean {
  if (!INLINE_KINDS.has(column.kind)) return false
  if (cell !== null && typeof cell !== 'string') return false
  if (column.kind === 'char' && (column.length ?? 0) > 255) return false
  return typeof cell !== 'string' || !/[\r\n]/.test(cell)
}

// ---- Visible markers --------------------------------------------------------------------------------------------------------------

const MARKER_LABEL: Record<MarkerKind, MessageKey> = {
  cr: 'rows.cell.marker.cr',
  lf: 'rows.cell.marker.lf',
  tab: 'rows.cell.marker.tab',
  nbsp: 'rows.cell.marker.nbsp',
  zeroWidth: 'rows.cell.marker.zeroWidth',
  space: 'rows.cell.marker.space',
  control: 'rows.cell.marker.control',
}

/** The text with whitespace kept (`pre-wrap`) and control characters shown as marked glyphs (UI-ISS-114). */
export function MarkedText({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => markControls(text), [text])
  return (
    <pre
      tabIndex={0}
      className={cn(
        'max-h-[50dvh] overflow-auto rounded-[var(--radius-control)] bg-raised px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-ink select-text',
        className,
      )}
    >
      {segments.map((s, i) =>
        s.marker ? (
          <span key={i}>
            <span
              role="img"
              aria-label={t(MARKER_LABEL[s.marker.kind])}
              title={t(MARKER_LABEL[s.marker.kind])}
              className="rounded-sm bg-[var(--pill-warning-bg)] px-0.5 text-[var(--pill-warning-ink)]"
            >
              {s.marker.glyph}
            </span>
            {s.marker.kind === 'lf' ? '\n' : ''}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </pre>
  )
}

// ---- The dialog -----------------------------------------------------------------------------------------------------------------------

export type CellDialogProps = {
  open: boolean
  onClose: () => void
  db: string
  model: RowTable
  column: RowColumn
  cell: Cell
  /** Key of the row; without it the value cannot be loaded in full, downloaded or edited. */
  rowKey?: Record<string, GuardValue>
  identity: Identity
  permissions: RowPermissions
  timeZone?: string
  locale?: string
  uploadBytes?: number
  acceptSoft?: boolean
  /** Open directly in edit mode (a cell the in-cell editor cannot show). */
  startEditing?: boolean
  onChanged?: (response: DoneResponse) => void
}

export function CellDialog(props: CellDialogProps) {
  const titleId = useId()
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      labelledBy={titleId}
      className="w-[min(860px,calc(100vw-32px))]"
    >
      {props.open && <CellBody {...props} titleId={titleId} />}
    </Dialog>
  )
}

type Full =
  | { t: 'text'; text: string; digest?: string; truncated: boolean }
  | { t: 'bytes'; hex: string; digest?: string; truncated: boolean }
  | { t: 'null'; digest?: string }

type ViewId = 'text' | 'hex' | 'json'

function CellBody(props: CellDialogProps & { titleId: string }) {
  const { db, model, column, cell, rowKey, titleId } = props
  const [full, setFull] = useState<Full | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(Boolean(props.startEditing))
  const [draft, setDraft] = useState<WireValue | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const closeId = useId()

  const binary = isBinaryKind(column.kind)
  const original: Cell = useMemo(() => {
    if (!full) return cell
    if (full.t === 'null') return null
    if (full.t === 'text') return full.text
    return cell
  }, [full, cell])
  const digest = full?.digest
  const partial =
    isPartialCell(original) &&
    !(typeof original === 'object' && 'binary' in original && original.size <= 32)
  const canEdit = canEditColumn(
    column,
    model,
    props.identity,
    props.permissions,
    rowKey !== undefined,
  )
  const current = draft ?? initialWire(column, original)
  const dirty = draft !== null && (partial || !wireEqual(initialWire(column, original), draft))

  async function loadFull(): Promise<LoadFullResult> {
    if (!rowKey) return { ok: false, message: t('rows.form.refusal.noIdentity') }
    setLoading(true)
    setLoadError(null)
    try {
      const r = await formsApi().readCell({
        db,
        table: model.table,
        key: rowKey,
        column: column.name,
        maxBytes: FULL_VALUE_BYTES,
      })
      if (!r.found) {
        const message = t('rows.form.rowGone')
        setLoadError(message)
        return { ok: false, message }
      }
      if (r.value.t === 'null') setFull({ t: 'null', digest: r.digest })
      else if (r.value.t === 'text') {
        setFull({ t: 'text', text: r.value.text, digest: r.digest, truncated: r.value.truncated })
        return { ok: true, text: r.value.text, digest: r.digest, truncated: r.value.truncated }
      } else
        setFull({ t: 'bytes', hex: r.value.hex, digest: r.digest, truncated: r.value.truncated })
      return { ok: true, text: '', digest: r.digest, truncated: false }
    } catch (e) {
      const message = describeRowsRefusal(e).message
      setLoadError(message)
      return { ok: false, message }
    } finally {
      setLoading(false)
    }
  }

  const context: RowFormContextValue = useMemo(
    () => ({
      db,
      table: model.table,
      model,
      timeZone: props.timeZone,
      uploadBytes: props.uploadBytes ?? DEFAULT_UPLOAD_BYTES,
      rowKey,
      loadFull,
    }),
    // `loadFull` closes over stable props only.
    [db, model, rowKey, props.timeZone, props.uploadBytes, column.name],
  )

  const changer = useRowChanger({
    db,
    table: model.table,
    model,
    acceptSoft: props.acceptSoft,
    onDone: (response) => {
      props.onChanged?.(response)
      props.onClose()
    },
  })

  function save() {
    if (!rowKey || changer.busy) return
    const wire = current
    const error = validateWire(column, wire)
    if (error) {
      setFieldError(t(error.key, error.values))
      return
    }
    setFieldError(null)
    if (!dirty) {
      setEditing(false)
      return
    }
    const guard = tryGuard(column, original, digest)
    const change: RowChange = {
      op: 'update',
      targets: [{ key: rowKey, old: guard ? { [column.name]: guard } : {} }],
      set: { [column.name]: wire },
    }
    void changer.submit(change)
  }

  // ---- Text of the value in every view ----
  const text: string | null =
    full?.t === 'text'
      ? full.text
      : full?.t === 'null'
        ? null
        : cell === null
          ? null
          : typeof cell === 'string'
            ? column.kind === 'bit'
              ? editText(column, cell)
              : cell
            : 'cut' in cell
              ? cell.cut
              : null
  const bytesHex: string | null =
    full?.t === 'bytes'
      ? full.hex
      : cell !== null && typeof cell === 'object' && 'binary' in cell
        ? cell.binary
        : null
  const length =
    full?.t === 'text'
      ? [...full.text].length
      : cell !== null && typeof cell === 'object' && 'cut' in cell
        ? cell.length
        : typeof cell === 'string'
          ? [...cell].length
          : undefined
  const size = binary
    ? full?.t === 'bytes' && !full.truncated
      ? full.hex.length / 2
      : storedSize(cell)
    : undefined
  const isPartial =
    !full &&
    isPartialCell(cell) &&
    !(typeof cell === 'object' && 'binary' in cell && cell.size <= 32)
  const views: ViewId[] =
    column.kind === 'json' ? ['json', 'text', 'hex'] : binary ? ['hex'] : ['text', 'hex']
  const [view, setView] = useState<ViewId>(views[0] ?? 'text')

  const hex = useMemo(() => {
    if (binary) return bytesHex ? hexDump(hexToBytes(bytesHex)) : ''
    return text !== null ? hexDump(textToBytes(text)) : ''
  }, [binary, bytesHex, text])
  const pretty = useMemo(
    () => (column.kind === 'json' && text ? prettyJson(text) : null),
    [column.kind, text],
  )

  return (
    <RowFormContext.Provider value={context}>
      <div className="flex max-h-[calc(100dvh-32px)] flex-col">
        <header className="shrink-0 px-6 pt-5 pb-3">
          <h2 id={titleId} className="text-base font-semibold break-words">
            {t(editing ? 'rows.cell.titleEdit' : 'rows.cell.title', { column: column.name })}
          </h2>
          <p className="text-sm text-muted">
            <span className="font-mono">{column.fullType}</span>
            {length !== undefined &&
              ` · ${t('rows.cell.chars', { count: new Intl.NumberFormat(props.locale ?? 'en-US').format(length) })}`}
            {size !== undefined && ` · ${formatBytes(size)}`}
            {column.kind === 'timestamp' && props.timeZone
              ? ` · ${t('rows.form.timeZone', { zone: props.timeZone })}`
              : ''}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
          {editing ? (
            <div className="flex flex-col gap-3">
              <p id={`${titleId}-label`} className="sr-only">
                {column.name}
              </p>
              {createElement(valueEditors.get(column.kind), {
                column,
                value: {
                  original,
                  digest,
                  current,
                  dirty,
                } satisfies EditorValue,
                onChange: (wire: WireValue) => {
                  setDraft(wire)
                  setFieldError(null)
                },
                disabled: changer.busy,
                error: fieldError ?? undefined,
                labelId: `${titleId}-label`,
                describedById: `${titleId}-error`,
                mode: 'edit',
                locale: props.locale ?? 'en-US',
              } satisfies ValueEditorProps)}
              {fieldError && (
                <p id={`${titleId}-error`} role="alert" className="text-xs text-negative">
                  {fieldError}
                </p>
              )}
            </div>
          ) : (
            <>
              {views.length > 1 && (
                <div
                  role="tablist"
                  aria-label={t('rows.cell.views')}
                  className="inline-flex w-fit gap-0.5 rounded-[var(--radius-control)] bg-raised p-0.5"
                >
                  {views.map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      className={cn(
                        'press h-8 rounded-[calc(var(--radius-control)-2px)] px-3 text-xs font-medium text-muted',
                        view === v && 'bg-surface text-ink shadow-sm',
                      )}
                      onClick={() => setView(v)}
                    >
                      {t(`rows.cell.view.${v}` as MessageKey)}
                    </button>
                  ))}
                </div>
              )}
              {cell === null && full?.t !== 'text' ? (
                <p className="rounded-[var(--radius-control)] bg-raised px-3 py-2 text-sm text-faint">
                  NULL
                </p>
              ) : view === 'hex' ? (
                <>
                  <pre
                    tabIndex={0}
                    aria-label={t('rows.cell.hexLabel')}
                    className="max-h-[50dvh] overflow-auto rounded-[var(--radius-control)] bg-raised px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-ink select-text"
                  >
                    {hex || t('rows.cell.noBytes')}
                  </pre>
                  <p className="text-xs text-muted">
                    {binary ? t('rows.cell.hexBinary') : t('rows.cell.hexText')}
                  </p>
                </>
              ) : view === 'json' && pretty !== null ? (
                <MarkedText text={pretty} />
              ) : view === 'json' && text !== null ? (
                <>
                  <Alert>{t('rows.cell.jsonInvalid')}</Alert>
                  <MarkedText text={text} />
                </>
              ) : text !== null ? (
                <MarkedText text={text} />
              ) : (
                <p className="rounded-[var(--radius-control)] bg-raised px-3 py-2 text-sm text-muted">
                  {t('rows.cell.binaryNoText')}
                </p>
              )}
              {column.kind === 'geometry' && (
                <p className="text-xs text-muted">
                  {column.srid !== undefined
                    ? t('rows.form.wktSrid', { srid: column.srid })
                    : t('rows.form.wkt')}
                  {' · '}
                  {t('rows.form.noMap')}
                </p>
              )}
              {isPartial && (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-muted">
                    {t('rows.cell.partial', {
                      shown: text?.length ?? 0,
                      length: length ?? 0,
                    })}
                  </p>
                  <Button disabled={loading || !rowKey} onClick={() => void loadFull()}>
                    {loading ? t('rows.form.loading') : t('rows.form.loadFull')}
                  </Button>
                </div>
              )}
              {binary && cell !== null && rowKey && (
                <BlobActions column={column} size={size} disabled={changer.busy} />
              )}
              {full && 'truncated' in full && full.truncated && (
                <Alert>{t('rows.cell.truncatedFull')}</Alert>
              )}
              {loadError && <Alert tone="negative">{loadError}</Alert>}
            </>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-raised px-6 py-3">
          {!editing && text !== null && (
            <Button
              className="mr-auto"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
              <span aria-live="polite">{copied ? t('table.copied') : t('rows.cell.copy')}</span>
            </Button>
          )}
          {!editing && column.kind === 'json' && pretty !== null && view === 'text' && (
            <span className="mr-auto inline-flex items-center gap-1 text-xs text-muted">
              <Braces size={12} aria-hidden />
              {t('rows.form.jsonValid')}
            </span>
          )}
          <Button id={closeId} disabled={changer.busy} onClick={props.onClose}>
            {editing ? t('rows.dialog.cancel') : t('rows.dialog.close')}
          </Button>
          {!editing && canEdit && (
            <Button onClick={() => setEditing(true)}>
              <Pencil size={14} aria-hidden />
              {t('rows.cell.edit')}
            </Button>
          )}
          {editing && (
            <Button variant="primary" disabled={changer.busy || !dirty} onClick={save}>
              {changer.busy ? t('rows.dialog.working') : t('rows.form.save')}
            </Button>
          )}
        </footer>
      </div>
      {changer.dialogs}
    </RowFormContext.Provider>
  )
}

// ---- Inline editing --------------------------------------------------------------------------------------------------------------------

/** Rows of the answer in the order of the grid's columns, filled from the old row where a column is absent. */
export function alignRow(columns: string[], response: DoneResponse, previous: Cell[]): Cell[] {
  const row = response.rows[0]
  return columns.map((name, i) => {
    const index = response.columns.indexOf(name)
    const cell = index >= 0 ? row?.[index] : undefined
    return cell === undefined ? (previous[i] ?? null) : cell
  })
}

/**
 * The in-cell editor (hook `renderEditor`). For a kind that one line cannot hold it opens the cell dialog in
 * edit mode instead, so every editable cell can be edited from the keyboard.
 */
export function InlineCellEditor({
  ctx,
  locale,
  acceptSoft,
  uploadBytes,
}: {
  ctx: CellEditContext
  locale?: string
  acceptSoft?: boolean
  uploadBytes?: number
}) {
  const column = ctx.column
  if (!column || !ctx.key) return null
  if (!inlineEligible(column, ctx.cell)) {
    return (
      <>
        <span className="text-faint">…</span>
        <CellDialog
          open
          startEditing
          onClose={() => ctx.cancel()}
          db={ctx.table.db}
          model={ctx.table}
          column={column}
          cell={ctx.cell}
          rowKey={ctx.key}
          identity={ctx.identity}
          permissions={ctx.permissions}
          timeZone={ctx.timeZone}
          locale={locale}
          uploadBytes={uploadBytes}
          acceptSoft={acceptSoft}
          onChanged={(response) => {
            ctx.replaceRow(ctx.rowIndex, alignRow(ctx.columns, response, ctx.row))
            ctx.showStatement(response.statements.map((s) => s.preview).join(';\n'))
          }}
        />
      </>
    )
  }
  return <InlineInput ctx={ctx} column={column} keyValues={ctx.key} acceptSoft={acceptSoft} />
}

function InlineInput({
  ctx,
  column,
  keyValues,
  acceptSoft,
}: {
  ctx: CellEditContext
  column: RowColumn
  keyValues: Record<string, GuardValue>
  acceptSoft?: boolean
}) {
  const initial = useMemo(() => initialWire(column, ctx.cell), [column, ctx.cell])
  const [current, setCurrent] = useState<WireValue>(initial)
  const [error, setError] = useState<string | null>(null)
  // Float values are guarded by a digest, so the stored value is read once before editing starts.
  const needsRead = column.kind === 'float'
  const [digest, setDigest] = useState<string | undefined>(undefined)
  const [ready, setReady] = useState(!needsRead)
  const move = useRef<'next' | 'previous' | undefined>(undefined)
  const labelId = useId()
  const inputId = `${labelId}-in`

  useEffect(() => {
    if (!needsRead) return
    let live = true
    formsApi()
      .readCell({ db: ctx.table.db, table: ctx.table.table, key: keyValues, column: column.name })
      .then((r) => {
        if (!live) return
        if (r.found) setDigest(r.digest)
        setReady(true)
      })
      .catch((e: unknown) => {
        if (!live) return
        setError(describeRowsRefusal(e).message)
        setReady(true)
      })
    return () => {
      live = false
    }
  }, [needsRead, ctx.table.db, ctx.table.table, keyValues, column.name])

  useEffect(() => {
    if (!ready) return
    const el = document.getElementById(inputId)
    el?.focus()
    if (el instanceof HTMLInputElement) el.select()
  }, [ready, inputId])

  const changer = useRowChanger({
    db: ctx.table.db,
    table: ctx.table.table,
    model: ctx.table,
    acceptSoft,
    onDone: (response) => {
      ctx.replaceRow(ctx.rowIndex, alignRow(ctx.columns, response, ctx.row))
      ctx.showStatement(response.statements.map((s) => s.preview).join(';\n'))
      ctx.finish(move.current ? { move: move.current } : undefined)
    },
    // The cell reverts after the message was read (error, conflict closed, row gone).
    onSettled: () => ctx.cancel(),
    onReload: (conflict) => {
      ctx.replaceRow(ctx.rowIndex, conflict.current)
    },
  })

  function save(next?: 'next' | 'previous') {
    if (changer.busy || !ready) return
    move.current = next
    if (wireEqual(current, initial)) {
      ctx.finish(next ? { move: next } : undefined)
      return
    }
    const invalid = validateWire(column, current)
    if (invalid) {
      setError(t(invalid.key, invalid.values))
      return
    }
    const guard = tryGuard(column, ctx.cell, digest)
    const change: RowChange = {
      op: 'update',
      targets: [{ key: keyValues, old: guard ? { [column.name]: guard } : {} }],
      set: { [column.name]: current },
    }
    void changer.submit(change)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      ctx.cancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      save()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      save(e.shiftKey ? 'previous' : 'next')
    }
  }

  const isNull = current.t === 'null'
  const text = current.t === 'v' ? current.v : ''
  const label = t('rows.cell.editing', { column: column.name })
  return (
    <div className="flex min-w-0 flex-col gap-0.5" onKeyDown={onKeyDown}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-1" aria-busy={!ready || changer.busy}>
        {column.kind === 'enum' ? (
          <Select
            compact
            id={inputId}
            aria-labelledby={labelId}
            aria-invalid={Boolean(error)}
            disabled={!ready || changer.busy || isNull}
            value={text}
            onChange={(e) => {
              setError(null)
              setCurrent({ t: 'v', v: e.target.value })
            }}
          >
            {text !== '' && !column.members?.includes(text) && <option value={text}>{text}</option>}
            {(column.members ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id={inputId}
            aria-labelledby={labelId}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${labelId}-error` : undefined}
            className="h-8 min-w-0 flex-1 px-2 font-mono"
            autoComplete="off"
            spellCheck={false}
            disabled={!ready || changer.busy || isNull}
            value={isNull ? '' : text}
            placeholder={isNull ? 'NULL' : undefined}
            onChange={(e) => {
              setError(null)
              setCurrent({ t: 'v', v: e.target.value })
            }}
          />
        )}
        {column.nullable && (
          <Button
            className="h-8 px-2 text-xs"
            aria-pressed={isNull}
            disabled={!ready || changer.busy}
            onClick={() => {
              setError(null)
              setCurrent(isNull ? { t: 'v', v: text } : NULL_WIRE)
            }}
          >
            NULL
          </Button>
        )}
      </div>
      {error && (
        <p id={`${labelId}-error`} role="alert" className="text-xs text-negative">
          {error}
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {changer.busy ? t('rows.dialog.working') : ''}
      </span>
      {changer.dialogs}
    </div>
  )
}
