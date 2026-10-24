/**
 * Operator allow-list of the row filter (FR-ROW-008, spec 5.5). Pure and shared by the UI (which operators to
 * offer) and the server compiler (which operators to accept). The allow-list is data on purpose: it is
 * reviewable in this one place and widening it needs the owner (spec section 11).
 */
import type { FilterNode, FilterOperator, TypeKind } from '../../server/rows/types'

export type {
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
} from '../../server/rows/types'

const NULL_OPS = ['is null', 'is not null'] as const
const COMPARE = ['=', '!=', '<', '<=', '>', '>=', 'between', 'not between'] as const
const LISTS = ['in', 'not in'] as const

const NUMERIC: readonly FilterOperator[] = [...COMPARE, ...LISTS, ...NULL_OPS]
const TEMPORAL: readonly FilterOperator[] = [...COMPARE, ...NULL_OPS]

export const OPERATORS_BY_KIND: Readonly<Record<TypeKind, readonly FilterOperator[]>> = {
  int: NUMERIC,
  decimal: NUMERIC,
  float: NUMERIC,
  year: NUMERIC,
  bit: NUMERIC,
  date: TEMPORAL,
  time: TEMPORAL,
  datetime: TEMPORAL,
  timestamp: TEMPORAL,
  char: [
    'contains',
    'not contains',
    'starts with',
    'ends with',
    '=',
    '!=',
    'empty',
    'not empty',
    'like',
    'not like',
    'regexp',
    ...LISTS,
    ...NULL_OPS,
  ],
  text: [
    'contains',
    'not contains',
    'starts with',
    'ends with',
    '=',
    '!=',
    'empty',
    'not empty',
    'like',
    'not like',
    'regexp',
    ...LISTS,
    ...NULL_OPS,
  ],
  enum: ['=', '!=', ...LISTS, ...NULL_OPS],
  set: ['has', 'has not', ...NULL_OPS],
  binary: ['=', '!=', 'in', 'starts with hex', ...NULL_OPS],
  blob: ['=', '!=', 'in', 'starts with hex', ...NULL_OPS],
  json: ['text contains', ...NULL_OPS],
  geometry: NULL_OPS,
  uuid: ['=', '!=', ...LISTS, ...NULL_OPS],
  inet6: ['=', '!=', ...LISTS, ...NULL_OPS],
  unknown: NULL_OPS,
}

export function operatorAllowed(kind: TypeKind, op: FilterOperator): boolean {
  return OPERATORS_BY_KIND[kind].includes(op)
}

export type OperatorArity = 'none' | 'one' | 'two' | 'list'

/** How many typed values an operator takes; unary operators have no input (FR-UPD-021). */
export function operatorArity(op: FilterOperator): OperatorArity {
  switch (op) {
    case 'is null':
    case 'is not null':
    case 'empty':
    case 'not empty':
      return 'none'
    case 'between':
    case 'not between':
      return 'two'
    case 'in':
    case 'not in':
      return 'list'
    default:
      return 'one'
  }
}

/** Kinds that offer the "match case" option. */
export function supportsMatchCase(kind: TypeKind): boolean {
  return kind === 'char' || kind === 'text'
}

/** An empty group (no children) constrains nothing. */
export function isEmptyFilter(node: FilterNode): boolean {
  return node.type === 'group' && node.children.every(isEmptyFilter)
}
