/**
 * Draft model of the filter builder (FR-ROW-008): editable tree with client ids, per-kind operators,
 * value validation and conversion to the wire `FilterNode`. Pure; the server validates again. The operator
 * allow-list is package A's (`src/lib/rows/filter-tree.ts`); nothing here widens it.
 */
import type {
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  RowColumn,
  TypeKind,
} from '~/server/rows/types'
import { OPERATORS_BY_KIND, operatorArity, type OperatorArity } from '~/lib/rows/filter-tree'
import {
  FILTER_OPERATORS,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  MAX_FILTER_IN_VALUES,
  MAX_FILTER_VALUE_BYTES,
} from '~/server/rows/types'

export function operatorsFor(kind: TypeKind): FilterOperator[] {
  return [...OPERATORS_BY_KIND[kind]]
}

/** How many values an operator takes and how the control looks (the allow-list is package A's). */
export type ValueShape = OperatorArity

export function valueShape(op: FilterOperator): ValueShape {
  return operatorArity(op)
}

/** Operators the case switch applies to. */
export function supportsMatchCase(kind: TypeKind, op: FilterOperator): boolean {
  return (
    (kind === 'char' || kind === 'text') &&
    op !== 'is null' &&
    op !== 'is not null' &&
    op !== 'regexp'
  )
}

// ---- Draft tree ------------------------------------------------------------------------------------------------

export type DraftCondition = {
  id: string
  type: 'condition'
  column: string
  op: FilterOperator
  values: string[]
  matchCase: boolean
}
export type DraftGroup = {
  id: string
  type: 'group'
  op: 'and' | 'or'
  negate: boolean
  children: DraftNode[]
}
export type DraftNode = DraftCondition | DraftGroup

let counter = 0
export function draftId(): string {
  counter += 1
  return `d${counter}`
}

export function emptyGroup(op: 'and' | 'or' = 'and'): DraftGroup {
  return { id: draftId(), type: 'group', op, negate: false, children: [] }
}

/** The operator a new condition on this column starts with; `preferred` is the user's string default. */
export function defaultOperator(kind: TypeKind, preferred?: FilterOperator): FilterOperator {
  const ops = operatorsFor(kind)
  if ((kind === 'char' || kind === 'text') && preferred && ops.includes(preferred)) return preferred
  return ops[0]!
}

export function newCondition(column: RowColumn, preferred?: FilterOperator): DraftCondition {
  const op = defaultOperator(column.kind, preferred)
  return {
    id: draftId(),
    type: 'condition',
    column: column.name,
    op,
    values: initialValues(op),
    matchCase: false,
  }
}

export function initialValues(op: FilterOperator): string[] {
  const shape = valueShape(op)
  return shape === 'two' ? ['', ''] : shape === 'one' ? [''] : []
}

/** Changing the column or operator keeps what can be kept and resets the rest. */
export function withOperator(
  c: DraftCondition,
  kind: TypeKind,
  op: FilterOperator,
): DraftCondition {
  const before = valueShape(c.op)
  const after = valueShape(op)
  let values = c.values
  if (before !== after) {
    values =
      after === 'two'
        ? [c.values[0] ?? '', '']
        : after === 'one'
          ? [c.values[0] ?? '']
          : after === 'list'
            ? c.values.filter((v) => v !== '')
            : []
  }
  return { ...c, op, values, matchCase: supportsMatchCase(kind, op) ? c.matchCase : false }
}

export function withColumn(
  c: DraftCondition,
  column: RowColumn,
  preferred?: FilterOperator,
): DraftCondition {
  const ops = operatorsFor(column.kind)
  const op = ops.includes(c.op) ? c.op : defaultOperator(column.kind, preferred)
  const resetValues = ops.includes(c.op) ? c.values : initialValues(op)
  // A value typed for another kind is rarely valid for this one: keep it only for text kinds.
  const keep = column.kind === 'char' || column.kind === 'text' ? resetValues : initialValues(op)
  return { ...c, column: column.name, op, values: keep, matchCase: false }
}

export function countConditions(node: DraftNode): number {
  return node.type === 'condition'
    ? 1
    : node.children.reduce((sum, child) => sum + countConditions(child), 0)
}

/** Depth of a group: a root with only conditions has depth 1 (contract: at most MAX_FILTER_DEPTH). */
export function groupDepth(node: DraftNode): number {
  if (node.type === 'condition') return 0
  return 1 + node.children.reduce((max, child) => Math.max(max, groupDepth(child)), 0)
}

export function canAddCondition(root: DraftGroup): boolean {
  return countConditions(root) < MAX_FILTER_CONDITIONS
}

/** Whether a group at `depth` (root = 1) may get a child group. */
export function canAddGroup(depth: number): boolean {
  return depth < MAX_FILTER_DEPTH
}

export function updateNode(
  root: DraftGroup,
  id: string,
  fn: (node: DraftNode) => DraftNode | null,
): DraftGroup {
  const walk = (node: DraftNode): DraftNode | null => {
    if (node.id === id) return fn(node)
    if (node.type === 'condition') return node
    const children: DraftNode[] = []
    for (const child of node.children) {
      const next = walk(child)
      if (next) children.push(next)
    }
    return { ...node, children }
  }
  const result = walk(root)
  return result && result.type === 'group' ? result : root
}

// ---- Validation -------------------------------------------------------------------------------------------------

export type ValueProblem =
  | 'required'
  | 'number'
  | 'integer'
  | 'date'
  | 'time'
  | 'datetime'
  | 'year'
  | 'hex'
  | 'bit'
  | 'member'
  | 'tooLong'
  | 'duplicate'
  | 'tooMany'

const INT = /^[+-]?\d+$/
const HEX_INT = /^0x[0-9a-f]+$/i
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/
const FLOAT = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^-?\d{1,3}:[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$/
const DATETIME = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:[0-5]\d(:[0-5]\d(\.\d{1,6})?)?)?$/
const YEAR = /^\d{2}(\d{2})?$/
const HEX_BYTES = /^0x([0-9a-f]{2})+$/i
const BIT = /^(b'[01]+'|[01]+|\d+|0x[0-9a-f]+)$/i

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** One typed value for a kind; undefined when it is fine. Mirrors what the server codec accepts. */
export function validateValue(column: RowColumn, value: string): ValueProblem | undefined {
  if (value === '') return 'required'
  if (utf8Length(value) > MAX_FILTER_VALUE_BYTES) return 'tooLong'
  const kind = column.kind
  switch (kind) {
    case 'int':
      return INT.test(value) || HEX_INT.test(value) ? undefined : 'integer'
    case 'decimal':
      return DECIMAL.test(value) ? undefined : 'number'
    case 'float':
      return FLOAT.test(value) ? undefined : 'number'
    case 'year':
      return YEAR.test(value) ? undefined : 'year'
    case 'bit':
      return BIT.test(value) ? undefined : 'bit'
    case 'date':
      return DATE.test(value) ? undefined : 'date'
    case 'time':
      return TIME.test(value) ? undefined : 'time'
    case 'datetime':
    case 'timestamp':
      return DATETIME.test(value) ? undefined : 'datetime'
    case 'enum':
    case 'set':
      return column.members?.includes(value) ? undefined : 'member'
    case 'binary':
    case 'blob':
      return HEX_BYTES.test(value) ? undefined : 'hex'
    default:
      return undefined
  }
}

/** First problem of a condition, or undefined when it can be applied. */
export function validateCondition(
  c: DraftCondition | FilterCondition,
  column: RowColumn | undefined,
): ValueProblem | undefined {
  if (!column) return 'required'
  const shape = valueShape(c.op)
  if (shape === 'none') return undefined
  if (shape === 'list') {
    if (c.values.length === 0) return 'required'
    if (c.values.length > MAX_FILTER_IN_VALUES) return 'tooMany'
    if (new Set(c.values).size !== c.values.length) return 'duplicate'
  } else {
    const need = shape === 'two' ? 2 : 1
    if (c.values.length < need) return 'required'
  }
  for (const value of c.values) {
    const problem = validateValue(column, value)
    if (problem) return problem
  }
  return undefined
}

// ---- Conversion --------------------------------------------------------------------------------------------------

/** Normalises what a native picker or the user typed to the form the server wants. */
export function normaliseValue(kind: TypeKind, value: string): string {
  if ((kind === 'datetime' || kind === 'timestamp') && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value.replace('T', ' ')
  }
  return value
}

/** Draft to wire tree. Empty groups are dropped; a lone nested group stays as typed. */
export function toFilterNode(
  node: DraftNode,
  columns: ReadonlyMap<string, RowColumn>,
): FilterNode | undefined {
  if (node.type === 'condition') {
    const kind = columns.get(node.column)?.kind ?? 'unknown'
    const out: FilterCondition = {
      type: 'condition',
      column: node.column,
      op: node.op,
      values: node.values.map((v) => normaliseValue(kind, v)),
    }
    if (node.matchCase && supportsMatchCase(kind, node.op)) out.matchCase = true
    return out
  }
  const children: FilterNode[] = []
  for (const child of node.children) {
    const converted = toFilterNode(child, columns)
    if (converted) children.push(converted)
  }
  if (children.length === 0) return undefined
  const group: FilterGroup = { type: 'group', op: node.op, children }
  if (node.negate) group.negate = true
  return group
}

/** Wire tree to draft (the applied filter reopened in the builder, or a filter from a link). */
export function fromFilterNode(node: FilterNode | undefined): DraftGroup {
  if (!node) return emptyGroup()
  const convert = (n: FilterNode): DraftNode =>
    n.type === 'condition'
      ? {
          id: draftId(),
          type: 'condition',
          column: n.column,
          op: n.op,
          values: [...n.values],
          matchCase: n.matchCase === true,
        }
      : {
          id: draftId(),
          type: 'group',
          op: n.op,
          negate: n.negate === true,
          children: n.children.map(convert),
        }
  const root = convert(node)
  return root.type === 'group' ? root : { ...emptyGroup(), children: [root] }
}

/** Every condition of a draft, depth first. */
export function conditionsOf(node: DraftNode): DraftCondition[] {
  return node.type === 'condition' ? [node] : node.children.flatMap(conditionsOf)
}

/** Every condition of a wire tree. */
export function wireConditions(node: FilterNode | undefined): FilterCondition[] {
  if (!node) return []
  return node.type === 'condition' ? [node] : node.children.flatMap(wireConditions)
}

export function isKnownOperator(op: string): op is FilterOperator {
  return (FILTER_OPERATORS as readonly string[]).includes(op)
}
