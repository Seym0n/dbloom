import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import { cn } from '~/lib/utils'
import {
  COLUMN_TYPES,
  type Capabilities,
  type ColumnDef,
  type ColumnType,
} from '~/server/structure/types'
import { t, type MessageKey } from '~/i18n'
import { CellError } from './field'
import {
  applyType,
  blankColumn,
  hasPrimaryColumn,
  moveItem,
  newKey,
  hasFourByteChars,
  removeColumn,
  setColumnName,
  togglePrimaryKey,
  traits,
  typeDisabledReason,
  type ColRow,
  type Draft,
  type FieldErrors,
} from './model'

type DefaultKind = ColumnDef['default']['kind']
const DEFAULT_KINDS: { kind: DefaultKind; label: MessageKey }[] = [
  { kind: 'none', label: 'structure.default.none' },
  { kind: 'null', label: 'structure.default.null' },
  { kind: 'literal', label: 'structure.default.literal' },
  { kind: 'currentTimestamp', label: 'structure.default.currentTimestamp' },
  { kind: 'expression', label: 'structure.default.expression' },
]

const toNumber = (value: string) => (value === '' ? undefined : Number(value))
const cell = 'border-b border-rule px-1.5 py-1.5 align-top first:pl-6 last:pr-6'
const th =
  'sticky top-0 z-10 h-9 border-b border-border bg-surface px-1.5 text-left text-xs font-normal whitespace-nowrap text-muted first:pl-6 last:pr-6'
const compactInput = 'h-8'

function ColumnRowView({
  row,
  index,
  count,
  draft,
  setDraft,
  errors,
  caps,
  disabled,
}: {
  row: ColRow
  index: number
  count: number
  draft: Draft
  setDraft: (next: Draft) => void
  errors: FieldErrors
  caps: Capabilities | undefined
  disabled?: boolean
}) {
  const def = row.def
  const tr = traits(def.type)
  const removed = Boolean(row.removed)
  const off = disabled || removed
  const label = (field: MessageKey) =>
    t('structure.rowLabel', { field: t(field), row: def.name || String(index + 1) })
  const err = (field: string) => errors[`columns.${index}.${field}`]
  const eid = (field: string) => `${row.key}-${field}-error`
  const generatedOk = caps ? caps['generated-column'] : true
  const generated = def.generated !== undefined

  const patch = (next: Partial<ColumnDef>) =>
    setDraft({
      ...draft,
      columns: draft.columns.map((c) =>
        c.key === row.key ? { ...c, def: { ...c.def, ...next } } : c,
      ),
    })
  const move = (to: number) => setDraft({ ...draft, columns: moveItem(draft.columns, index, to) })

  const invalid = (field: string) => Boolean(err(field))

  return (
    <tr className={cn(removed && 'opacity-60')} data-removed={removed || undefined}>
      <td className={cell}>
        <div className="flex gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-7"
            aria-label={t('structure.moveUp', { name: def.name || String(index + 1) })}
            disabled={off || index === 0}
            onClick={() => move(index - 1)}
          >
            <ArrowUp size={14} aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-7"
            aria-label={t('structure.moveDown', { name: def.name || String(index + 1) })}
            disabled={off || index === count - 1}
            onClick={() => move(index + 1)}
          >
            <ArrowDown size={14} aria-hidden />
          </Button>
        </div>
      </td>

      <td className={cell} style={{ minWidth: 176 }}>
        <Input
          id={`col-name-${row.key}`}
          className={cn(compactInput, removed && 'line-through')}
          aria-label={label('structure.col.name')}
          aria-invalid={invalid('name')}
          aria-describedby={err('name') ? eid('name') : undefined}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          value={def.name}
          disabled={off}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(setColumnName(draft, row.key, e.target.value))}
          onKeyDown={(e) => {
            if (e.altKey && e.key === 'ArrowUp') {
              e.preventDefault()
              move(index - 1)
              requestAnimationFrame(() => document.getElementById(`col-name-${row.key}`)?.focus())
            } else if (e.altKey && e.key === 'ArrowDown') {
              e.preventDefault()
              move(index + 1)
              requestAnimationFrame(() => document.getElementById(`col-name-${row.key}`)?.focus())
            }
          }}
        />
        <CellError id={eid('name')} error={err('name')} />
      </td>

      <td className={cell} style={{ minWidth: 140 }}>
        <Select
          compact
          aria-label={label('structure.col.type')}
          aria-invalid={invalid('type')}
          aria-describedby={err('type') ? eid('type') : undefined}
          value={def.type}
          disabled={off}
          onChange={(e) => patch(applyType(def, e.target.value as ColumnType))}
        >
          {COLUMN_TYPES.map((type) => {
            const reason = typeDisabledReason(type, caps)
            return (
              <option key={type} value={type} disabled={reason !== null && type !== def.type}>
                {type.toUpperCase()}
                {reason ? ` (${t(reason)})` : ''}
              </option>
            )
          })}
        </Select>
        <CellError id={eid('type')} error={err('type')} />
      </td>

      <td className={cell} style={{ minWidth: 150 }}>
        {tr.sized && (
          <>
            <Input
              type="number"
              min={1}
              className={compactInput}
              aria-label={label('structure.col.length')}
              aria-invalid={invalid('length')}
              aria-describedby={err('length') ? eid('length') : undefined}
              value={def.length ?? ''}
              disabled={off}
              onChange={(e) => patch({ length: toNumber(e.target.value) })}
            />
            <CellError id={eid('length')} error={err('length')} />
          </>
        )}
        {tr.decimal && (
          <div className="flex gap-1">
            <Input
              type="number"
              min={1}
              className={compactInput}
              aria-label={label('structure.col.precision')}
              aria-invalid={invalid('precision')}
              value={def.precision ?? ''}
              disabled={off}
              onChange={(e) => patch({ precision: toNumber(e.target.value) })}
            />
            <Input
              type="number"
              min={0}
              className={compactInput}
              aria-label={label('structure.col.scale')}
              aria-invalid={invalid('scale')}
              aria-describedby={err('scale') ? eid('scale') : undefined}
              value={def.scale ?? ''}
              disabled={off}
              onChange={(e) => patch({ scale: toNumber(e.target.value) })}
            />
          </div>
        )}
        {tr.decimal && <CellError id={eid('scale')} error={err('scale')} />}
        {tr.list && (
          <>
            <textarea
              rows={2}
              aria-label={label('structure.col.values')}
              aria-invalid={invalid('values')}
              aria-describedby={err('values') ? eid('values') : undefined}
              placeholder={t('structure.col.valuesHint')}
              value={(def.values ?? []).join('\n')}
              disabled={off}
              onChange={(e) => patch({ values: e.target.value.split('\n') })}
              className="w-full rounded-[var(--radius-control)] border border-control bg-surface px-2 py-1 text-sm text-ink placeholder:text-faint disabled:bg-raised"
            />
            <CellError id={eid('values')} error={err('values')} />
          </>
        )}
        {!tr.sized && !tr.decimal && !tr.list && <span className="text-faint">—</span>}
      </td>

      <td className={cn(cell, 'text-center')}>
        <Checkbox
          aria-label={label('structure.col.unsigned')}
          checked={Boolean(def.unsigned)}
          disabled={off || !tr.unsigned}
          onChange={(e) => patch({ unsigned: e.target.checked })}
          className="mt-2.5"
        />
      </td>

      <td className={cn(cell, 'text-center')}>
        <Checkbox
          aria-label={label('structure.col.primary')}
          checked={hasPrimaryColumn(draft, row.ref)}
          disabled={off || def.name === ''}
          onChange={() => setDraft(togglePrimaryKey(draft, row.ref))}
          className="mt-2.5"
        />
      </td>

      <td className={cn(cell, 'text-center')}>
        <Checkbox
          aria-label={label('structure.col.nullable')}
          checked={def.nullable}
          disabled={off}
          onChange={(e) => patch({ nullable: e.target.checked })}
          className="mt-2.5"
        />
      </td>

      <td className={cn(cell, 'text-center')}>
        <Checkbox
          aria-label={label('structure.col.autoIncrement')}
          checked={Boolean(def.autoIncrement) && !generated}
          disabled={off || !tr.integer || generated}
          onChange={(e) => patch({ autoIncrement: e.target.checked })}
          className="mt-2.5"
        />
      </td>

      <td className={cell} style={{ minWidth: 230 }}>
        <div className="flex gap-1">
          <Select
            compact
            className="w-28 shrink-0"
            aria-label={label('structure.col.default')}
            aria-invalid={invalid('default')}
            aria-describedby={err('default') ? eid('default') : undefined}
            value={generated ? 'none' : def.default.kind}
            disabled={off || generated}
            onChange={(e) => {
              const kind = e.target.value as DefaultKind
              patch({
                default:
                  kind === 'literal'
                    ? { kind, value: '' }
                    : kind === 'expression'
                      ? { kind, sql: '' }
                      : kind === 'currentTimestamp'
                        ? { kind }
                        : { kind },
              })
            }}
          >
            {DEFAULT_KINDS.filter((k) => k.kind !== 'currentTimestamp' || tr.timestamp).map((k) => (
              <option key={k.kind} value={k.kind}>
                {t(k.label)}
              </option>
            ))}
          </Select>
          {def.default.kind === 'literal' && !generated && (
            <Input
              className={compactInput}
              aria-label={label('structure.col.defaultValue')}
              value={String(def.default.value)}
              disabled={off}
              onChange={(e) => patch({ default: { kind: 'literal', value: e.target.value } })}
            />
          )}
          {def.default.kind === 'expression' && !generated && (
            <Input
              className={cn(compactInput, 'font-mono')}
              aria-label={label('structure.col.defaultExpression')}
              value={def.default.sql}
              disabled={off}
              onChange={(e) => patch({ default: { kind: 'expression', sql: e.target.value } })}
            />
          )}
        </div>
        {def.default.kind === 'currentTimestamp' && tr.timestamp && !generated && (
          <label className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <Checkbox
              checked={Boolean(def.onUpdateCurrentTimestamp)}
              disabled={off}
              onChange={(e) => patch({ onUpdateCurrentTimestamp: e.target.checked })}
            />
            {t('structure.col.onUpdate')}
          </label>
        )}
        <CellError id={eid('default')} error={err('default')} />
      </td>

      <td className={cell} style={{ minWidth: 220 }}>
        <div className="flex gap-1">
          <Select
            compact
            className="w-28 shrink-0"
            aria-label={label('structure.col.generated')}
            aria-describedby={!generatedOk ? `${row.key}-gen-why` : undefined}
            value={def.generated?.storage ?? 'none'}
            disabled={off || (!generatedOk && !generated)}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'none') patch({ generated: undefined })
              else
                patch({
                  generated: { sql: def.generated?.sql ?? '', storage: v as 'virtual' | 'stored' },
                })
            }}
          >
            <option value="none">{t('structure.generated.none')}</option>
            <option value="virtual">{t('structure.generated.virtual')}</option>
            <option value="stored">{t('structure.generated.stored')}</option>
          </Select>
          {def.generated && (
            <Input
              className={cn(compactInput, 'font-mono')}
              aria-label={label('structure.col.generatedExpression')}
              aria-invalid={invalid('generated')}
              value={def.generated.sql}
              disabled={off}
              onChange={(e) =>
                patch({
                  generated: { sql: e.target.value, storage: def.generated?.storage ?? 'virtual' },
                })
              }
            />
          )}
        </div>
        {!generatedOk && (
          <p id={`${row.key}-gen-why`} className="mt-0.5 text-xs text-muted">
            {t('structure.unsupported')}
          </p>
        )}
        <CellError id={eid('generated')} error={err('generated')} />
      </td>

      <td className={cell} style={{ minWidth: 180 }}>
        <Input
          className={compactInput}
          aria-label={label('structure.col.comment')}
          value={def.comment ?? ''}
          disabled={off}
          aria-describedby={hasFourByteChars(def.comment ?? '') ? eid('comment') : undefined}
          onChange={(e) => patch({ comment: e.target.value })}
        />
        {hasFourByteChars(def.comment ?? '') && (
          <p
            id={eid('comment')}
            role="status"
            className="mt-0.5 text-xs text-[var(--pill-warning-ink)]"
          >
            {t('structure.comment.fourByte')}
          </p>
        )}
      </td>

      <td className={cell}>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={
            removed
              ? t('structure.col.restore', { name: def.name })
              : t('structure.col.remove', { name: def.name || String(index + 1) })
          }
          aria-pressed={row.orig ? removed : undefined}
          onClick={() => setDraft(removeColumn(draft, row.key))}
        >
          {removed ? <RotateCcw size={14} aria-hidden /> : <Trash2 size={14} aria-hidden />}
        </Button>
      </td>
    </tr>
  )
}

/** The editable column grid. It scrolls inside its own frame, so a phone never scrolls the page sideways. */
export function ColumnsGrid({
  draft,
  setDraft,
  errors,
  caps,
  disabled,
}: {
  draft: Draft
  setDraft: (next: Draft) => void
  errors: FieldErrors
  caps: Capabilities | undefined
  disabled?: boolean
}) {
  const focusKey = useRef<string | null>(null)

  useEffect(() => {
    if (!focusKey.current) return
    document.getElementById(`col-name-${focusKey.current}`)?.focus()
    focusKey.current = null
  }, [draft.columns.length])

  function add() {
    const key = newKey()
    focusKey.current = key
    setDraft({ ...draft, columns: [...draft.columns, { key, ref: '', def: blankColumn() }] })
  }

  const headings: { label: MessageKey; className?: string }[] = [
    { label: 'structure.col.order' },
    { label: 'structure.col.name' },
    { label: 'structure.col.type' },
    { label: 'structure.col.size' },
    { label: 'structure.col.unsigned' },
    { label: 'structure.col.primary' },
    { label: 'structure.col.nullable' },
    { label: 'structure.col.autoIncrement' },
    { label: 'structure.col.default' },
    { label: 'structure.col.generated' },
    { label: 'structure.col.comment' },
    { label: 'structure.col.actions' },
  ]

  return (
    <div className="flex flex-col gap-2">
      {errors['columns'] && (
        <p className="px-6 text-sm text-negative">
          {t(errors['columns'].key, errors['columns'].values)}
        </p>
      )}
      <div
        role="region"
        aria-label={t('structure.columns')}
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {headings.map((h) => (
                <th key={h.label} scope="col" className={th}>
                  <span className={h.label === 'structure.col.actions' ? 'sr-only' : undefined}>
                    {t(h.label)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draft.columns.map((row, index) => (
              <ColumnRowView
                key={row.key}
                row={row}
                index={index}
                count={draft.columns.length}
                draft={draft}
                setDraft={setDraft}
                errors={errors}
                caps={caps}
                disabled={disabled}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6">
        <Button onClick={add} disabled={disabled}>
          <Plus size={14} aria-hidden />
          {t('structure.col.add')}
        </Button>
      </div>
    </div>
  )
}
