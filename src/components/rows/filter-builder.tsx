import { useId, useMemo, useState, type ReactNode } from 'react'
import { ListFilter, Plus, Trash2, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { Select } from '~/components/ui/select'
import type { FilterNode, FilterOperator, RowColumn } from '~/server/rows/types'
import { MAX_FILTER_CONDITIONS, MAX_FILTER_IN_VALUES } from '~/server/rows/types'
import { cn } from '~/lib/utils'
import { t, type MessageKey } from '~/i18n'
import {
  canAddCondition,
  canAddGroup,
  conditionsOf,
  countConditions,
  emptyGroup,
  fromFilterNode,
  newCondition,
  operatorsFor,
  supportsMatchCase,
  toFilterNode,
  updateNode,
  validateCondition,
  valueShape,
  withColumn,
  withOperator,
  wireConditions,
  type DraftCondition,
  type DraftGroup,
  type DraftNode,
  type ValueProblem,
} from './filter-model'
import { CountBadge, RowsPopover } from './rows-popover'

export const OPERATOR_LABEL: Record<FilterOperator, MessageKey> = {
  '=': 'rows.filter.op.eq',
  '!=': 'rows.filter.op.ne',
  '<': 'rows.filter.op.lt',
  '<=': 'rows.filter.op.le',
  '>': 'rows.filter.op.gt',
  '>=': 'rows.filter.op.ge',
  between: 'rows.filter.op.between',
  'not between': 'rows.filter.op.notBetween',
  in: 'rows.filter.op.in',
  'not in': 'rows.filter.op.notIn',
  'is null': 'rows.filter.op.isNull',
  'is not null': 'rows.filter.op.isNotNull',
  contains: 'rows.filter.op.contains',
  'not contains': 'rows.filter.op.notContains',
  'starts with': 'rows.filter.op.startsWith',
  'ends with': 'rows.filter.op.endsWith',
  empty: 'rows.filter.op.empty',
  'not empty': 'rows.filter.op.notEmpty',
  like: 'rows.filter.op.like',
  'not like': 'rows.filter.op.notLike',
  regexp: 'rows.filter.op.regexp',
  has: 'rows.filter.op.has',
  'has not': 'rows.filter.op.hasNot',
  'text contains': 'rows.filter.op.textContains',
  'starts with hex': 'rows.filter.op.startsWithHex',
}

const PROBLEM_LABEL: Record<ValueProblem, MessageKey> = {
  required: 'rows.filter.problem.required',
  number: 'rows.filter.problem.number',
  integer: 'rows.filter.problem.integer',
  date: 'rows.filter.problem.date',
  time: 'rows.filter.problem.time',
  datetime: 'rows.filter.problem.datetime',
  year: 'rows.filter.problem.year',
  hex: 'rows.filter.problem.hex',
  bit: 'rows.filter.problem.bit',
  member: 'rows.filter.problem.member',
  tooLong: 'rows.filter.problem.tooLong',
  duplicate: 'rows.filter.problem.duplicate',
  tooMany: 'rows.filter.problem.tooMany',
}

function placeholderFor(column: RowColumn): string | undefined {
  switch (column.kind) {
    case 'date':
      return t('rows.filter.hint.date')
    case 'datetime':
    case 'timestamp':
      return t('rows.filter.hint.datetime')
    case 'time':
      return t('rows.filter.hint.time')
    case 'binary':
    case 'blob':
      return t('rows.filter.hint.hex')
    case 'year':
      return t('rows.filter.hint.year')
    default:
      return undefined
  }
}

function inputModeFor(kind: RowColumn['kind']): 'numeric' | 'decimal' | undefined {
  if (kind === 'int' || kind === 'year' || kind === 'bit') return 'numeric'
  if (kind === 'decimal' || kind === 'float') return 'decimal'
  return undefined
}

/** One value control, chosen by the column kind (UPD-016): members for enum and set, a date field, numeric keypad. */
function ValueInput({
  column,
  value,
  onChange,
  label,
  invalid,
  describedBy,
}: {
  column: RowColumn
  value: string
  onChange: (value: string) => void
  label: string
  invalid: boolean
  describedBy?: string
}) {
  const common = {
    'aria-label': label,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
  }
  if ((column.kind === 'enum' || column.kind === 'set') && column.members) {
    return (
      <Select compact {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('rows.filter.chooseMember')}</option>
        {column.members.map((m) => (
          <option key={m} value={m}>
            {m === '' ? t('rows.filter.emptyMember') : m}
          </option>
        ))}
      </Select>
    )
  }
  return (
    <Input
      {...common}
      className="h-8 min-w-0 pointer-coarse:h-11"
      type={column.kind === 'date' ? 'date' : 'text'}
      inputMode={inputModeFor(column.kind)}
      placeholder={placeholderFor(column)}
      value={value}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** The values of IN / NOT IN: duplicates are refused as typed (UPD-021); enum columns get checkboxes. */
function ListInput({
  column,
  values,
  onChange,
  label,
  invalid,
  describedBy,
}: {
  column: RowColumn
  values: string[]
  onChange: (values: string[]) => void
  label: string
  invalid: boolean
  describedBy?: string
}) {
  const [draft, setDraft] = useState('')
  const id = useId()
  if (column.kind === 'enum' && column.members) {
    return (
      <fieldset
        className="flex min-w-0 flex-wrap gap-x-4 gap-y-1"
        aria-label={label}
        aria-describedby={describedBy}
      >
        {column.members.map((m) => {
          const cid = `${id}-${m}`
          return (
            <span key={m} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                id={cid}
                checked={values.includes(m)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...values, m] : values.filter((v) => v !== m))
                }
              />
              <label htmlFor={cid}>{m === '' ? t('rows.filter.emptyMember') : m}</label>
            </span>
          )
        })}
      </fieldset>
    )
  }
  const add = (raw: string) => {
    const parts = raw
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p !== '')
    if (parts.length === 0) return
    const next = [...values]
    for (const p of parts) {
      if (!next.includes(p) && next.length < MAX_FILTER_IN_VALUES) next.push(p)
    }
    onChange(next)
    setDraft('')
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Input
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="h-8 min-w-0 pointer-coarse:h-11"
          inputMode={inputModeFor(column.kind)}
          placeholder={placeholderFor(column) ?? t('rows.filter.addValue')}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text')
            if (/\r?\n/.test(text)) {
              e.preventDefault()
              add(text)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
            }
          }}
        />
        <Button
          aria-label={t('rows.filter.addValue')}
          size="icon"
          className="pointer-coarse:h-11 pointer-coarse:w-11"
          onClick={() => add(draft)}
          disabled={draft.trim() === ''}
        >
          <Plus size={14} aria-hidden />
        </Button>
      </div>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={t('rows.filter.listValues')}>
          {values.map((v) => (
            <li
              key={v}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--pill-neutral-bg)] py-0.5 pr-1 pl-2 text-xs text-[var(--pill-neutral-ink)]"
            >
              <span className="truncate">{v}</span>
              <button
                type="button"
                aria-label={t('rows.filter.removeValue', { value: v })}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="press grid h-4 w-4 place-items-center rounded-full hover:bg-active"
              >
                <X size={10} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ConditionRow({
  condition,
  position,
  columns,
  byName,
  preferredOperator,
  showProblems,
  onChange,
  onRemove,
}: {
  condition: DraftCondition
  position: number
  columns: RowColumn[]
  byName: ReadonlyMap<string, RowColumn>
  preferredOperator?: FilterOperator
  showProblems: boolean
  onChange: (next: DraftCondition) => void
  onRemove: () => void
}) {
  const column = byName.get(condition.column)
  const kind = column?.kind ?? 'unknown'
  const shape = valueShape(condition.op)
  const problem = validateCondition(condition, column)
  const visible = problem && (showProblems || problem !== 'required')
  // A message appears only for a field the user typed into, or after an attempt to apply.
  const typed = condition.values.some((v) => v !== '')
  const showProblem = visible && (showProblems || typed)
  const msgId = `${condition.id}-msg`
  const n = String(position)
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-1.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,9rem)_minmax(0,1fr)_auto]">
        <Select
          compact
          className="pointer-coarse:h-11"
          aria-label={t('rows.filter.column', { n })}
          value={condition.column}
          onChange={(e) => {
            const next = byName.get(e.target.value)
            if (next) onChange(withColumn(condition, next, preferredOperator, column?.kind))
          }}
        >
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          compact
          className="pointer-coarse:h-11"
          aria-label={t('rows.filter.operator', { n })}
          value={condition.op}
          onChange={(e) =>
            onChange(withOperator(condition, kind, e.target.value as FilterOperator))
          }
        >
          {operatorsFor(kind).map((op) => (
            <option key={op} value={op}>
              {t(OPERATOR_LABEL[op])}
            </option>
          ))}
        </Select>
        <div className="order-last col-span-3 min-w-0 sm:order-none sm:col-span-1">
          {column && shape === 'one' && (
            <ValueInput
              column={column}
              value={condition.values[0] ?? ''}
              label={t('rows.filter.value', { n })}
              invalid={Boolean(showProblem)}
              describedBy={showProblem ? msgId : undefined}
              onChange={(v) => onChange({ ...condition, values: [v] })}
            />
          )}
          {column && shape === 'two' && (
            <div className="grid grid-cols-2 items-center gap-1.5">
              <ValueInput
                column={column}
                value={condition.values[0] ?? ''}
                label={t('rows.filter.valueFrom', { n })}
                invalid={Boolean(showProblem)}
                describedBy={showProblem ? msgId : undefined}
                onChange={(v) => onChange({ ...condition, values: [v, condition.values[1] ?? ''] })}
              />
              <ValueInput
                column={column}
                value={condition.values[1] ?? ''}
                label={t('rows.filter.valueTo', { n })}
                invalid={Boolean(showProblem)}
                describedBy={showProblem ? msgId : undefined}
                onChange={(v) => onChange({ ...condition, values: [condition.values[0] ?? '', v] })}
              />
            </div>
          )}
          {column && shape === 'list' && (
            <ListInput
              column={column}
              values={condition.values}
              label={t('rows.filter.value', { n })}
              invalid={Boolean(showProblem)}
              describedBy={showProblem ? msgId : undefined}
              onChange={(values) => onChange({ ...condition, values })}
            />
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="pointer-coarse:h-11 pointer-coarse:w-11"
          aria-label={t('rows.filter.removeCondition', { n })}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>
      {supportsMatchCase(kind, condition.op) && (
        <label className="flex items-center gap-2 pl-0.5 text-xs text-muted">
          <Checkbox
            checked={condition.matchCase}
            onChange={(e) => onChange({ ...condition, matchCase: e.target.checked })}
          />
          {t('rows.filter.matchCase')}
        </label>
      )}
      {condition.op === 'like' && <p className="text-xs text-muted">{t('rows.filter.likeHint')}</p>}
      {showProblem && problem && (
        <p id={msgId} className="text-xs text-negative">
          {t(PROBLEM_LABEL[problem])}
        </p>
      )}
    </div>
  )
}

function GroupEditor({
  group,
  depth,
  isRoot,
  root,
  setRoot,
  columns,
  byName,
  preferredOperator,
  showProblems,
  counter,
}: {
  group: DraftGroup
  depth: number
  isRoot: boolean
  root: DraftGroup
  setRoot: (next: DraftGroup) => void
  columns: RowColumn[]
  byName: ReadonlyMap<string, RowColumn>
  preferredOperator?: FilterOperator
  showProblems: boolean
  counter: { next: () => number }
}) {
  const id = useId()
  const first = columns[0]
  const addCondition = () => {
    if (!first) return
    setRoot(
      updateNode(root, group.id, (n) =>
        n.type === 'group'
          ? { ...n, children: [...n.children, newCondition(first, preferredOperator)] }
          : n,
      ),
    )
  }
  const addGroup = () =>
    setRoot(
      updateNode(root, group.id, (n) =>
        n.type === 'group' ? { ...n, children: [...n.children, emptyGroup('or')] } : n,
      ),
    )
  const canCondition = canAddCondition(root) && Boolean(first)
  const groupAllowed = canAddGroup(depth)
  return (
    <div
      role="group"
      aria-label={isRoot ? t('rows.filter.rootGroup') : t('rows.filter.nestedGroup', { depth })}
      className={cn(
        'flex flex-col gap-2.5',
        !isRoot && 'rounded-md border border-rule bg-raised p-2.5',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">{t('rows.filter.match')}</span>
          <Select
            compact
            className="w-auto pointer-coarse:h-11"
            aria-label={t('rows.filter.matchMode')}
            value={group.op}
            onChange={(e) => {
              const op = e.target.value === 'or' ? 'or' : 'and'
              setRoot(updateNode(root, group.id, (n) => (n.type === 'group' ? { ...n, op } : n)))
            }}
          >
            <option value="and">{t('rows.filter.all')}</option>
            <option value="or">{t('rows.filter.any')}</option>
          </Select>
        </label>
        <span className="flex items-center gap-1.5 text-sm">
          <Checkbox
            id={`${id}-not`}
            checked={group.negate}
            onChange={(e) =>
              setRoot(
                updateNode(root, group.id, (n) =>
                  n.type === 'group' ? { ...n, negate: e.target.checked } : n,
                ),
              )
            }
          />
          <label htmlFor={`${id}-not`}>{t('rows.filter.negate')}</label>
        </span>
        {!isRoot && (
          <Button
            variant="ghost"
            className="ml-auto h-7 px-2 text-xs pointer-coarse:h-11"
            onClick={() => setRoot(updateNode(root, group.id, () => null))}
          >
            <Trash2 size={12} aria-hidden />
            {t('rows.filter.removeGroup')}
          </Button>
        )}
      </div>

      {group.children.length === 0 && (
        <p className="text-sm text-muted">{t('rows.filter.emptyGroup')}</p>
      )}
      {group.children.map((child) => {
        if (child.type === 'group') {
          return (
            <GroupEditor
              key={child.id}
              group={child}
              depth={depth + 1}
              isRoot={false}
              root={root}
              setRoot={setRoot}
              columns={columns}
              byName={byName}
              preferredOperator={preferredOperator}
              showProblems={showProblems}
              counter={counter}
            />
          )
        }
        const position = counter.next()
        return (
          <ConditionRow
            key={child.id}
            condition={child}
            position={position}
            columns={columns}
            byName={byName}
            preferredOperator={preferredOperator}
            showProblems={showProblems}
            onChange={(next) => setRoot(updateNode(root, child.id, () => next))}
            onRemove={() => setRoot(updateNode(root, child.id, () => null))}
          />
        )
      })}

      <div className="flex flex-wrap gap-2">
        <Button
          className="pointer-coarse:h-11"
          onClick={addCondition}
          disabled={!canCondition}
          title={
            !canCondition
              ? t('rows.filter.limitConditions', { max: MAX_FILTER_CONDITIONS })
              : undefined
          }
        >
          <Plus size={14} aria-hidden />
          {t('rows.filter.addCondition')}
        </Button>
        <Button
          className="pointer-coarse:h-11"
          onClick={addGroup}
          disabled={!groupAllowed}
          title={!groupAllowed ? t('rows.filter.limitDepth') : undefined}
        >
          <Plus size={14} aria-hidden />
          {t('rows.filter.addGroup')}
        </Button>
      </div>
    </div>
  )
}

/** The editable tree inside the popover. Remounted at each opening, so it starts from the applied filter. */
export function FilterEditor({
  columns,
  applied,
  preferredOperator,
  onApply,
  onClose,
}: {
  columns: RowColumn[]
  applied: FilterNode | undefined
  preferredOperator?: FilterOperator
  onApply: (node: FilterNode | undefined) => void
  onClose: () => void
}) {
  const byName = useMemo(() => new Map(columns.map((c) => [c.name, c])), [columns])
  const [root, setRoot] = useState<DraftGroup>(() => {
    const draft = fromFilterNode(applied)
    if (draft.children.length === 0 && columns[0]) {
      draft.children.push(newCondition(columns[0], preferredOperator))
    }
    return draft
  })
  const [attempted, setAttempted] = useState(false)
  const conditions = conditionsOf(root)
  const invalid = conditions.filter((c) => validateCondition(c, byName.get(c.column)) !== undefined)
  let position = 0
  const counter = { next: () => ++position }

  const apply = () => {
    if (invalid.length > 0) {
      setAttempted(true)
      return
    }
    onApply(toFilterNode(root, byName))
    onClose()
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        apply()
      }}
    >
      <div className="flex flex-col gap-3 overflow-auto p-3">
        <p className="text-sm text-muted">{t('rows.filter.intro')}</p>
        <GroupEditor
          group={root}
          depth={1}
          isRoot
          root={root}
          setRoot={setRoot}
          columns={columns}
          byName={byName}
          preferredOperator={preferredOperator}
          showProblems={attempted}
          counter={counter}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-rule px-3 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-negative" aria-live="polite">
          {attempted && invalid.length > 0
            ? t('rows.filter.fixConditions', { count: invalid.length })
            : ''}
        </p>
        <Button
          className="pointer-coarse:h-11"
          onClick={() => {
            onApply(undefined)
            onClose()
          }}
          disabled={!applied && countConditions(root) === 0}
        >
          {t('rows.filter.clear')}
        </Button>
        <Button className="pointer-coarse:h-11" onClick={onClose}>
          {t('rows.filter.cancel')}
        </Button>
        <Button variant="primary" type="submit" className="pointer-coarse:h-11">
          {t('rows.filter.apply')}
        </Button>
      </div>
    </form>
  )
}

/** The Filter button with its sheet. `applied` is the filter in force; the count says how many conditions. */
export function FilterBuilder({
  columns,
  applied,
  preferredOperator,
  onApply,
  disabled,
}: {
  columns: RowColumn[]
  applied: FilterNode | undefined
  preferredOperator?: FilterOperator
  onApply: (node: FilterNode | undefined) => void
  disabled?: boolean
}) {
  const count = wireConditions(applied).length
  return (
    <RowsPopover
      label={t('rows.filter.title')}
      icon={<ListFilter size={14} strokeWidth={1.5} aria-hidden />}
      badge={count > 0 ? <CountBadge>{count}</CountBadge> : undefined}
      widthClass="w-[min(720px,calc(100vw-32px))]"
      disabled={disabled}
    >
      {(close) => (
        <FilterEditor
          columns={columns}
          applied={applied}
          preferredOperator={preferredOperator}
          onApply={onApply}
          onClose={close}
        />
      )}
    </RowsPopover>
  )
}

// ---- Chips: the applied filter in words --------------------------------------------------------------------------

function quote(value: string): string {
  return value.length > 40 ? `“${value.slice(0, 40)}…”` : `“${value}”`
}

/** One condition in words, for a chip and its remove label. */
export function describeNode(node: FilterNode): string {
  if (node.type === 'condition') {
    const op = t(OPERATOR_LABEL[node.op])
    const shape = valueShape(node.op)
    const values =
      shape === 'none'
        ? ''
        : shape === 'two'
          ? ` ${quote(node.values[0] ?? '')} ${t('rows.filter.chipAnd')} ${quote(node.values[1] ?? '')}`
          : shape === 'list'
            ? ` ${node.values.slice(0, 3).map(quote).join(', ')}${node.values.length > 3 ? ` +${node.values.length - 3}` : ''}`
            : ` ${quote(node.values[0] ?? '')}`
    return `${node.column} ${op}${values}`
  }
  const joiner = node.op === 'and' ? t('rows.filter.chipAnd') : t('rows.filter.chipOr')
  const inner = node.children.map(describeNode).join(` ${joiner} `)
  return node.negate ? `${t('rows.filter.chipNot')} (${inner})` : `(${inner})`
}

/** Chips of the top level of the applied filter; a chip's x removes that part, "Clear" removes all. */
export function FilterChips({
  applied,
  onChange,
  trailing,
}: {
  applied: FilterNode | undefined
  onChange: (next: FilterNode | undefined) => void
  trailing?: ReactNode
}) {
  if (!applied) return null
  const parts: FilterNode[] =
    applied.type === 'group' && !applied.negate ? applied.children : [applied]
  const joiner =
    applied.type === 'group' && !applied.negate && applied.op === 'or'
      ? t('rows.filter.chipOr')
      : t('rows.filter.chipAnd')
  const remove = (index: number) => {
    if (applied.type !== 'group' || applied.negate) return onChange(undefined)
    const children = applied.children.filter((_, i) => i !== index)
    onChange(children.length === 0 ? undefined : { ...applied, children })
  }
  return (
    <div
      role="group"
      aria-label={t('rows.filter.active')}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-6 pb-2"
    >
      {parts.map((part, i) => {
        const text = describeNode(part)
        return (
          <span key={i} className="contents">
            {i > 0 && <span className="text-xs text-muted">{joiner}</span>}
            <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--pill-neutral-bg)] py-0.5 pr-1 pl-2.5 text-xs text-[var(--pill-neutral-ink)]">
              <span className="truncate" title={text}>
                {text}
              </span>
              <button
                type="button"
                aria-label={t('rows.filter.removeChip', { filter: text })}
                onClick={() => remove(i)}
                className="press grid h-5 w-5 place-items-center rounded-full hover:bg-active pointer-coarse:h-8 pointer-coarse:w-8"
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          </span>
        )
      })}
      <button
        type="button"
        onClick={() => onChange(undefined)}
        className="press ml-1 rounded px-1.5 text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        {t('rows.filter.clearAll')}
      </button>
      {trailing}
    </div>
  )
}

export type { DraftNode }
