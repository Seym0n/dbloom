/**
 * Value editors per type kind (FR-ROW-003, 013, 018, 025) and the built-in cell renderers, registered in the
 * two registries of `registry.ts` (FR-ROW-031). Every editor gets the same tri-state shell: a value, NULL,
 * DEFAULT, or a function from a fixed list. An untouched field is never sent (see `form-core.ts`).
 */
import { useContext, useId, useState, type ReactNode } from 'react'
import { Braces, Calendar } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { t, type MessageKey } from '~/i18n'
import type { Cell, FnName, RowColumn, TypeKind, WireValue } from '~/server/rows/types'
import { BlobBody } from './blob-field'
import {
  RowFormContext,
  compactJson,
  editText,
  formatBit,
  formatBytes,
  functionsFor,
  hasDefault,
  isPartialCell,
  jsonErrorPosition,
  prettyJson,
  restoreLineBreaks,
  toTextareaValue,
  validateJson,
} from './form-core'
import {
  createKindRegistry,
  type CellDisplayOptions,
  type CellRenderer,
  type ValueEditor,
  type ValueEditorProps,
} from './registry'

// ---- Shell: value / NULL / DEFAULT / function ------------------------------------------------------------------------

type ModeId = 'value' | 'null' | 'default' | 'fn'

const MODE_LABEL: Record<ModeId, MessageKey> = {
  value: 'rows.form.mode.value',
  null: 'rows.form.mode.null',
  default: 'rows.form.mode.default',
  fn: 'rows.form.mode.function',
}

const FN_LABEL: Record<FnName, MessageKey> = {
  now: 'rows.form.fn.now',
  currentTimestamp6: 'rows.form.fn.currentTimestamp6',
  utcTimestamp: 'rows.form.fn.utcTimestamp',
  currentDate: 'rows.form.fn.currentDate',
  unixTimestamp: 'rows.form.fn.unixTimestamp',
  uuid: 'rows.form.fn.uuid',
}

export const fnLabel = (name: FnName) => t(FN_LABEL[name])

export function modeOf(wire: WireValue): ModeId {
  if (wire.t === 'null') return 'null'
  if (wire.t === 'default') return 'default'
  if (wire.t === 'fn') return 'fn'
  return 'value'
}

/** The value a field takes when the user switches back to "Value". */
function restoredValue(column: RowColumn, original: Cell): WireValue {
  if (original !== null && typeof original === 'string')
    return { t: 'v', v: editText(column, original) }
  if (column.kind === 'enum') return { t: 'v', v: column.members?.[0] ?? '' }
  return { t: 'v', v: '' }
}

function ModeBar({ props }: { props: ValueEditorProps }) {
  const { column, value, onChange, disabled, labelId } = props
  const name = useId()
  const fns = functionsFor(column)
  const modes: ModeId[] = ['value']
  if (column.nullable || column.autoIncrement) modes.push('null')
  if (hasDefault(column)) modes.push('default')
  if (fns.length > 0) modes.push('fn')
  if (modes.length < 2) return null
  const active = modeOf(value.current)

  function choose(next: ModeId) {
    if (next === 'value') onChange(restoredValue(column, value.original))
    else if (next === 'null') onChange({ t: 'null' })
    else if (next === 'default') onChange({ t: 'default' })
    else onChange({ t: 'fn', name: fns[0] ?? 'now' })
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      className="inline-flex w-fit flex-wrap gap-0.5 rounded-[var(--radius-control)] bg-raised p-0.5"
    >
      {modes.map((m) => (
        <label key={m} className="relative">
          <input
            type="radio"
            name={name}
            className="peer sr-only"
            checked={active === m}
            disabled={disabled}
            onChange={() => choose(m)}
          />
          <span
            className={cn(
              'inline-flex h-8 min-w-10 cursor-pointer items-center justify-center rounded-[calc(var(--radius-control)-2px)] px-2.5 text-xs font-medium text-muted',
              'peer-checked:bg-surface peer-checked:text-ink peer-checked:shadow-sm',
              'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-[var(--accent)]',
              'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
            )}
          >
            {t(MODE_LABEL[m])}
          </span>
        </label>
      ))}
    </div>
  )
}

function defaultText(column: RowColumn): string {
  if (column.autoIncrement) return t('rows.form.defaultAuto')
  const d = column.default
  if (d.kind === 'expression') return t('rows.form.defaultExpr', { expr: d.text ?? '' })
  if (d.kind === 'literal') return t('rows.form.defaultLiteral', { value: d.text ?? '' })
  return t('rows.form.defaultNull')
}

/** The tri-state frame around the body of a kind. Exported for the cell dialog and tests. */
export function EditorShell({ props, children }: { props: ValueEditorProps; children: ReactNode }) {
  const { column, value, onChange, disabled, labelId } = props
  const mode = modeOf(value.current)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ModeBar props={props} />
      {mode === 'value' && children}
      {mode === 'null' && (
        <p className="inline-flex h-10 items-center text-sm text-faint">{t('rows.form.isNull')}</p>
      )}
      {mode === 'default' && (
        <p className="inline-flex min-h-10 items-center text-sm text-muted">
          {defaultText(column)}
        </p>
      )}
      {mode === 'fn' && value.current.t === 'fn' && (
        <Select
          aria-labelledby={labelId}
          disabled={disabled}
          value={value.current.name}
          onChange={(e) => onChange({ t: 'fn', name: e.target.value as FnName })}
        >
          {functionsFor(column).map((n) => (
            <option key={n} value={n}>
              {fnLabel(n)}
            </option>
          ))}
        </Select>
      )}
    </div>
  )
}

const textOf = (value: ValueEditorProps['value']) =>
  value.current.t === 'v' ? value.current.v : ''

const inputId = (labelId: string) => `${labelId}-in`

function aria(props: ValueEditorProps) {
  return {
    'aria-labelledby': props.labelId,
    'aria-describedby': props.describedById,
    'aria-invalid': Boolean(props.error),
  }
}

// ---- Partial values (cut text) ------------------------------------------------------------------------------------------

function PartialNotice({ props }: { props: ValueEditorProps }) {
  const ctx = useContext(RowFormContext)
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false })
  const { column, value, onChange, disabled } = props
  const original = value.original
  const cut =
    original !== null && typeof original === 'object' && 'cut' in original ? original : null
  async function load() {
    if (!ctx.loadFull) return
    setState({ busy: true })
    const r = await ctx.loadFull(column)
    setState(r.ok ? { busy: false } : { busy: false, error: r.message })
  }
  return (
    <div className="flex flex-col gap-2">
      <textarea
        readOnly
        rows={3}
        className="w-full rounded-[var(--radius-control)] border border-control bg-raised px-3 py-2 font-mono text-xs text-ink"
        value={toTextareaValue(cut?.cut ?? '')}
        aria-labelledby={props.labelId}
        aria-describedby={props.describedById}
      />
      <p className="text-xs text-muted">
        {t('rows.form.partial', { shown: cut?.cut.length ?? 0, length: cut?.length ?? 0 })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || state.busy || !ctx.loadFull} onClick={() => void load()}>
          {state.busy ? t('rows.form.loading') : t('rows.form.loadFull')}
        </Button>
        <Button disabled={disabled} onClick={() => onChange({ t: 'v', v: '' })}>
          {t('rows.form.replace')}
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-xs text-negative">
          {state.error}
        </p>
      )}
    </div>
  )
}

const isUntouchedPartial = (props: ValueEditorProps) =>
  isPartialCell(props.value.original) &&
  typeof props.value.original === 'object' &&
  'cut' in props.value.original &&
  !props.value.dirty

// ---- Plain inputs ----------------------------------------------------------------------------------------------------------

function PlainInput({
  props,
  inputMode,
  placeholder,
  trim,
  mono,
}: {
  props: ValueEditorProps
  inputMode?: 'numeric' | 'decimal' | 'text'
  placeholder?: string
  trim?: boolean
  mono?: boolean
}) {
  return (
    <Input
      id={inputId(props.labelId)}
      {...aria(props)}
      className={cn(mono && 'font-mono')}
      inputMode={inputMode}
      placeholder={placeholder}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      disabled={props.disabled}
      value={textOf(props.value)}
      onChange={(e) => {
        const v = trim ? e.target.value.trim() : e.target.value
        props.onChange({ t: 'v', v })
      }}
    />
  )
}

function IntegerEditor(props: ValueEditorProps) {
  return (
    <EditorShell props={props}>
      <PlainInput props={props} inputMode="numeric" trim mono />
    </EditorShell>
  )
}

function DecimalEditor(props: ValueEditorProps) {
  const { column } = props
  return (
    <EditorShell props={props}>
      <PlainInput props={props} inputMode="decimal" trim mono />
      {column.precision !== undefined && (
        <p className="text-xs text-muted">
          {t('rows.form.decimalHint', { precision: column.precision, scale: column.scale ?? 0 })}
        </p>
      )}
    </EditorShell>
  )
}

function FloatEditor(props: ValueEditorProps) {
  return (
    <EditorShell props={props}>
      <PlainInput props={props} inputMode="decimal" trim mono />
    </EditorShell>
  )
}

function BitEditor(props: ValueEditorProps) {
  const { column } = props
  return (
    <EditorShell props={props}>
      <Input
        id={inputId(props.labelId)}
        {...aria(props)}
        className="font-mono"
        placeholder={formatBit(column, '')}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
        value={textOf(props.value)}
        onChange={(e) => props.onChange({ t: 'v', v: e.target.value.trim() })}
      />
      <p className="text-xs text-muted">{t('rows.form.bitHint', { bits: column.length ?? 1 })}</p>
    </EditorShell>
  )
}

// ---- Date and time --------------------------------------------------------------------------------------------------------------

const FORMAT_HINT: Record<string, MessageKey> = {
  date: 'rows.form.hint.date',
  time: 'rows.form.hint.time',
  datetime: 'rows.form.hint.datetime',
  timestamp: 'rows.form.hint.datetime',
  year: 'rows.form.hint.year',
}

/** Value of the native picker for a stored text, or '' when the text does not map to it exactly. */
export function pickerValue(kind: RowColumn['kind'], text: string): string {
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
  if (kind === 'time') return /^\d{2}:\d{2}:\d{2}$/.test(text) ? text : ''
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text)
  return m ? `${m[1]}T${m[2]}` : ''
}

/** Text for the stored value from what a native picker reported (seconds are always filled in). */
export function pickerToText(kind: RowColumn['kind'], picked: string): string {
  if (kind === 'date') return picked
  if (kind === 'time') return picked.length === 5 ? `${picked}:00` : picked
  const [date = '', time = ''] = picked.split('T')
  return `${date} ${time.length === 5 ? `${time}:00` : time}`.trim()
}

function TemporalEditor(props: ValueEditorProps) {
  const ctx = useContext(RowFormContext)
  const { column, value, onChange, disabled } = props
  const kind = column.kind
  const text = textOf(value)
  // The picker has no fractional seconds and no zero dates, so it is offered only where it cannot lose data.
  const pickerType =
    kind === 'date'
      ? 'date'
      : kind === 'datetime' || kind === 'timestamp'
        ? 'datetime-local'
        : kind === 'time'
          ? 'time'
          : null
  const usePicker = pickerType !== null && (column.fsp ?? 0) === 0
  const pickerId = useId()
  const hint = FORMAT_HINT[kind]
  return (
    <EditorShell props={props}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId(props.labelId)}
          {...aria(props)}
          className="max-w-72 flex-1 font-mono"
          placeholder={hint ? t(hint) : undefined}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={text}
          onChange={(e) => onChange({ t: 'v', v: e.target.value.trim() })}
        />
        {usePicker && pickerType && (
          <>
            <label htmlFor={pickerId} className="sr-only">
              {t('rows.form.pick', { name: column.name })}
            </label>
            <span className="relative inline-flex">
              <Calendar
                size={14}
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
              />
              <input
                id={pickerId}
                type={pickerType}
                step={pickerType === 'date' ? undefined : 1}
                disabled={disabled}
                value={pickerValue(kind, text)}
                onChange={(e) => {
                  if (e.target.value) onChange({ t: 'v', v: pickerToText(kind, e.target.value) })
                }}
                className="h-10 rounded-[var(--radius-control)] border border-control bg-surface pr-2 pl-8 text-sm text-ink disabled:opacity-60"
              />
            </span>
          </>
        )}
      </div>
      <p className="text-xs text-muted">
        {hint ? t(hint) : ''}
        {kind === 'timestamp' && ctx.timeZone
          ? ` · ${t('rows.form.timeZone', { zone: ctx.timeZone })}`
          : ''}
      </p>
    </EditorShell>
  )
}

// ---- Text ------------------------------------------------------------------------------------------------------------------------------

function TextArea({
  props,
  rows = 4,
  mono,
  onValue,
}: {
  props: ValueEditorProps
  rows?: number
  mono?: boolean
  onValue?: (v: string) => string
}) {
  const stored = textOf(props.value)
  const crlf = /\r/.test(stored)
  return (
    <>
      <textarea
        id={inputId(props.labelId)}
        {...aria(props)}
        rows={rows}
        spellCheck={false}
        disabled={props.disabled}
        className={cn(
          'w-full resize-y rounded-[var(--radius-control)] border border-control bg-surface px-3 py-2 text-sm text-ink disabled:opacity-60',
          mono && 'font-mono text-xs leading-5',
        )}
        value={toTextareaValue(stored)}
        onChange={(e) => {
          const original = props.value.original
          const base = typeof original === 'string' ? original : stored
          const next = restoreLineBreaks(base, e.target.value)
          props.onChange({ t: 'v', v: onValue ? onValue(next) : next })
        }}
      />
      {crlf && <p className="text-xs text-muted">{t('rows.form.crlfKept')}</p>}
    </>
  )
}

function TextEditor(props: ValueEditorProps) {
  const { column } = props
  const stored = textOf(props.value)
  const single =
    column.kind === 'char' && (column.length ?? Infinity) <= 255 && !/[\r\n]/.test(stored)
  if (isUntouchedPartial(props)) {
    return (
      <EditorShell props={props}>
        <PartialNotice props={props} />
      </EditorShell>
    )
  }
  return (
    <EditorShell props={props}>
      {single ? (
        <Input
          id={inputId(props.labelId)}
          {...aria(props)}
          autoComplete="off"
          spellCheck={false}
          disabled={props.disabled}
          value={stored}
          onChange={(e) => props.onChange({ t: 'v', v: e.target.value })}
        />
      ) : (
        <TextArea props={props} />
      )}
      {column.length !== undefined && column.kind === 'char' && (
        <p className="text-xs text-muted">{t('rows.form.maxChars', { max: column.length })}</p>
      )}
    </EditorShell>
  )
}

function EnumEditor(props: ValueEditorProps) {
  const { column, value, onChange, disabled } = props
  const members = column.members ?? []
  const current = textOf(value)
  const unknown = current !== '' && !members.includes(current)
  return (
    <EditorShell props={props}>
      <Select
        id={inputId(props.labelId)}
        {...aria(props)}
        disabled={disabled}
        value={current}
        onChange={(e) => onChange({ t: 'v', v: e.target.value })}
      >
        {unknown && <option value={current}>{current}</option>}
        {members.map((m) => (
          <option key={m} value={m}>
            {m === '' ? t('rows.form.emptyMember') : m}
          </option>
        ))}
      </Select>
    </EditorShell>
  )
}

function SetEditor(props: ValueEditorProps) {
  const { column, value, onChange, disabled, labelId } = props
  const members = column.members ?? []
  const chosen = new Set(textOf(value) === '' ? [] : textOf(value).split(','))
  function toggle(member: string, on: boolean) {
    const next = new Set(chosen)
    if (on) next.add(member)
    else next.delete(member)
    onChange({ t: 'v', v: members.filter((m) => next.has(m)).join(',') })
  }
  return (
    <EditorShell props={props}>
      <fieldset
        aria-labelledby={labelId}
        aria-describedby={props.describedById}
        className="flex flex-wrap gap-x-4 gap-y-2"
      >
        {members.map((m) => (
          <label key={m} className="flex min-h-8 items-center gap-2 text-sm">
            <Checkbox
              checked={chosen.has(m)}
              disabled={disabled}
              onChange={(e) => toggle(m, e.target.checked)}
            />
            {m === '' ? t('rows.form.emptyMember') : m}
          </label>
        ))}
      </fieldset>
      {chosen.size === 0 && <p className="text-xs text-muted">{t('rows.form.emptySet')}</p>}
    </EditorShell>
  )
}

// ---- JSON and geometry -------------------------------------------------------------------------------------------------------------

function JsonEditor(props: ValueEditorProps) {
  const { value, onChange, disabled } = props
  const text = textOf(value)
  if (isUntouchedPartial(props)) {
    return (
      <EditorShell props={props}>
        <PartialNotice props={props} />
      </EditorShell>
    )
  }
  const invalid = text === '' ? null : validateJson(text)
  let position = ''
  if (invalid) {
    try {
      JSON.parse(text)
    } catch (e) {
      const p = jsonErrorPosition(text, e)
      position = t('rows.form.jsonInvalid', { line: p.line, column: p.column })
    }
  }
  return (
    <EditorShell props={props}>
      <TextArea props={props} rows={8} mono />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || prettyJson(text) === null}
          onClick={() => onChange({ t: 'v', v: prettyJson(text) ?? text })}
        >
          <Braces size={14} aria-hidden />
          {t('rows.form.jsonFormat')}
        </Button>
        <Button
          disabled={disabled || compactJson(text) === null}
          onClick={() => onChange({ t: 'v', v: compactJson(text) ?? text })}
        >
          {t('rows.form.jsonCompact')}
        </Button>
        <span
          className={cn('text-xs', invalid ? 'text-negative' : 'text-muted')}
          aria-live="polite"
        >
          {text === '' ? '' : invalid ? position : t('rows.form.jsonValid')}
        </span>
      </div>
    </EditorShell>
  )
}

function GeometryEditor(props: ValueEditorProps) {
  const { column } = props
  if (isUntouchedPartial(props)) {
    return (
      <EditorShell props={props}>
        <PartialNotice props={props} />
      </EditorShell>
    )
  }
  return (
    <EditorShell props={props}>
      <TextArea props={props} rows={4} mono />
      <p className="text-xs text-muted">
        {column.srid !== undefined
          ? t('rows.form.wktSrid', { srid: column.srid })
          : t('rows.form.wkt')}
        {' · '}
        {t('rows.form.noMap')}
      </p>
    </EditorShell>
  )
}

// ---- Binary, uuid, unknown -----------------------------------------------------------------------------------------------------------

function BinaryEditor(props: ValueEditorProps) {
  return (
    <EditorShell props={props}>
      <BlobBody {...props} />
    </EditorShell>
  )
}

function UuidEditor(props: ValueEditorProps) {
  return (
    <EditorShell props={props}>
      <PlainInput props={props} mono />
    </EditorShell>
  )
}

function UnsupportedEditor(props: ValueEditorProps) {
  return (
    <div className="flex flex-col gap-1">
      <p id={inputId(props.labelId)} className="text-sm text-muted">
        {t('rows.form.unsupported', { type: props.column.fullType })}
      </p>
    </div>
  )
}

// ---- Registries (FR-ROW-031) ---------------------------------------------------------------------------------------------------------

/** Built-in editors by kind. `transformations` replaces entries here; an unknown kind gets the message. */
export const valueEditors = createKindRegistry<ValueEditor>(UnsupportedEditor)

const builtins: [TypeKind[], ValueEditor][] = [
  [['int'], IntegerEditor],
  [['decimal'], DecimalEditor],
  [['float'], FloatEditor],
  [['bit'], BitEditor],
  [['date', 'time', 'datetime', 'timestamp', 'year'], TemporalEditor],
  [['char', 'text'], TextEditor],
  [['enum'], EnumEditor],
  [['set'], SetEditor],
  [['binary', 'blob'], BinaryEditor],
  [['json'], JsonEditor],
  [['geometry'], GeometryEditor],
  [['uuid', 'inet6'], UuidEditor],
]
for (const [kinds, editor] of builtins)
  for (const kind of kinds) valueEditors.register(kind, editor)

/** Plain-text rendering of a cell with the display preferences; text nodes only (FR-ROW-030). */
const renderPlain: CellRenderer = (cell, column, options) => {
  if (cell === null) return <span className="text-faint">NULL</span>
  if (typeof cell === 'string') {
    const text = column.kind === 'bit' ? editText(column, cell) : cell
    return <>{clip(text, options)}</>
  }
  if ('cut' in cell) {
    return (
      <>
        {clip(cell.cut, options)}
        <span className="text-faint">
          {' '}
          … ({new Intl.NumberFormat(options.locale).format(cell.length)} {t('rows.form.chars')})
        </span>
      </>
    )
  }
  return binarySummary(cell, options)
}

function clip(text: string, options: CellDisplayOptions): string {
  if (options.fullText) return text
  const chars = Array.from(text)
  return chars.length > options.displayChars
    ? `${chars.slice(0, options.displayChars).join('')}…`
    : text
}

function binarySummary(cell: { binary: string; size: number }, options: CellDisplayOptions) {
  return (
    <span className="font-mono text-xs text-muted">
      {options.protectBinary ? '' : `0x${cell.binary.toUpperCase()}${cell.size > 32 ? '…' : ''} `}
      <span className="text-faint">({formatBytes(cell.size, options.locale)})</span>
    </span>
  )
}

/** Built-in cell renderers by kind; the fallback renders every kind that has no entry as plain text. */
export const cellRenderers = createKindRegistry<CellRenderer>(renderPlain)
cellRenderers.register('binary', renderPlain)
cellRenderers.register('blob', renderPlain)
