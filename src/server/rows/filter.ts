/**
 * Filter and search compiler (FR-ROW-008, FR-ROW-009, spec 5.5). Turns the typed filter tree into a WHERE
 * fragment with `?` placeholders. Column names must exist in the catalog model, the operator must be on the
 * allow-list of the column's kind (`OPERATORS_BY_KIND`), and every value is a parameter checked by the codec.
 * The only SQL text produced here is fixed: quoted names, operators from the table below, `ESCAPE '!'`, and
 * integers computed from validated byte counts.
 *
 * Guard rail, not a boundary (SEC-TGT-050): the target's privileges decide what a user may read; this compiler
 * keeps filter input from ever being SQL.
 */
import { quoteIdent as q } from '../db/identifiers'
import { operatorAllowed, operatorArity, supportsMatchCase } from '../../lib/rows/filter-tree'
import {
  bytesLhs,
  bytesParam,
  compareLhs,
  likeEscape,
  parseText,
  RowValueError,
  type Param,
  type SqlFragment,
} from './codecs'
import {
  filterWithinLimits,
  MAX_SEARCH_COLUMNS,
  type FilterCondition,
  type FilterNode,
  type FilterOperator,
  type RowColumn,
  type RowTable,
  type SearchInput,
} from './types'

function refuse(
  code: ConstructorParameters<typeof RowValueError>[0],
  message: string,
  field?: string,
): never {
  throw new RowValueError(code, message, field)
}

const COMPARE_OPS: Partial<Record<FilterOperator, string>> = {
  '=': '=',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
}

/** Binary-safe `COLLATE` for a regular expression that must match case. */
function binaryCollation(col: RowColumn): string {
  const cs = (col.charset ?? 'utf8mb4').toLowerCase()
  if (!/^[a-z0-9]+$/.test(cs))
    refuse('operator-not-allowed', 'match case is not available', col.name)
  return `${cs}_bin`
}

function values(cond: FilterCondition, col: RowColumn): Param[] {
  return cond.values.map((v) => parseText(col, v, 'filter'))
}

function compileCondition(table: RowTable, cond: FilterCondition): SqlFragment {
  const col = table.columns.find((c) => c.name === cond.column)
  if (!col) return refuse('unknown-column', `Unknown column`, cond.column)
  if (!operatorAllowed(col.kind, cond.op)) {
    return refuse(
      'operator-not-allowed',
      `Operator ${cond.op} is not allowed for ${col.kind}`,
      col.name,
    )
  }
  const matchCase = cond.matchCase === true
  if (matchCase && !supportsMatchCase(col.kind)) {
    return refuse('operator-not-allowed', 'Match case applies to text columns only', col.name)
  }
  const arity = operatorArity(cond.op)
  const n = cond.values.length
  if (
    (arity === 'none' && n !== 0) ||
    (arity === 'one' && n !== 1) ||
    (arity === 'two' && n !== 2) ||
    (arity === 'list' && n < 1)
  ) {
    return refuse(
      'invalid-value',
      `Operator ${cond.op} takes ${arity === 'list' ? 'a list of' : arity} value(s)`,
      col.name,
    )
  }

  const c = q(col.name)
  const op = cond.op
  if (op === 'is null') return { sql: `${c} IS NULL`, params: [] }
  if (op === 'is not null') return { sql: `${c} IS NOT NULL`, params: [] }
  if (op === 'empty') return { sql: `CHAR_LENGTH(${c}) = 0`, params: [] }
  if (op === 'not empty') return { sql: `CHAR_LENGTH(${c}) <> 0`, params: [] }

  const isText = col.kind === 'char' || col.kind === 'text'
  const lhs = isText && matchCase ? bytesLhs(col) : compareLhs(col)
  const ph = isText && matchCase ? bytesParam(col) : '?'
  const vals = values(cond, col)

  switch (op) {
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return { sql: `${lhs} ${COMPARE_OPS[op]} ${ph}`, params: [vals[0]!] }
    case 'between':
    case 'not between':
      return {
        sql: `${lhs} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ${ph} AND ${ph}`,
        params: [vals[0]!, vals[1]!],
      }
    case 'in':
    case 'not in': {
      const list = vals.map(() => ph).join(', ')
      return { sql: `${lhs} ${op === 'in' ? 'IN' : 'NOT IN'} (${list})`, params: vals }
    }
    case 'contains':
    case 'not contains':
      return {
        sql: `${lhs} ${op === 'contains' ? 'LIKE' : 'NOT LIKE'} ${ph} ESCAPE '!'`,
        params: [`%${likeEscape(cond.values[0]!)}%`],
      }
    case 'starts with':
      return { sql: `${lhs} LIKE ${ph} ESCAPE '!'`, params: [`${likeEscape(cond.values[0]!)}%`] }
    case 'ends with':
      return { sql: `${lhs} LIKE ${ph} ESCAPE '!'`, params: [`%${likeEscape(cond.values[0]!)}`] }
    case 'like':
    case 'not like':
      return {
        sql: `${lhs} ${op === 'like' ? 'LIKE' : 'NOT LIKE'} ${ph}`,
        params: [cond.values[0]!],
      }
    case 'regexp':
      return matchCase
        ? { sql: `${c} COLLATE ${binaryCollation(col)} REGEXP ?`, params: [cond.values[0]!] }
        : { sql: `${c} REGEXP ?`, params: [cond.values[0]!] }
    case 'has':
      return { sql: `FIND_IN_SET(?, ${c}) > 0`, params: [vals[0]!] }
    case 'has not':
      return { sql: `FIND_IN_SET(?, ${c}) = 0`, params: [vals[0]!] }
    case 'text contains':
      return {
        sql: `CAST(${c} AS CHAR) LIKE ? ESCAPE '!'`,
        params: [`%${likeEscape(cond.values[0]!)}%`],
      }
    case 'starts with hex': {
      const bytes = vals[0] as Buffer
      if (bytes.length === 0) return refuse('invalid-value', 'Give at least one byte', col.name)
      return { sql: `LEFT(${c}, ${bytes.length}) = ?`, params: [bytes] }
    }
    default:
      return refuse('operator-not-allowed', `Operator ${String(op)} is not supported`, col.name)
  }
}

function join(parts: SqlFragment[], glue: ' AND ' | ' OR '): SqlFragment | null {
  if (parts.length === 0) return null
  return {
    sql: parts.length === 1 ? parts[0]!.sql : `(${parts.map((p) => p.sql).join(glue)})`,
    params: parts.flatMap((p) => p.params),
  }
}

function compileNode(table: RowTable, node: FilterNode): SqlFragment | null {
  if (node.type === 'condition') return compileCondition(table, node)
  const parts = node.children
    .map((child) => compileNode(table, child))
    .filter((p): p is SqlFragment => p !== null)
  const body = join(parts, node.op === 'and' ? ' AND ' : ' OR ')
  if (!body) return null
  if (!node.negate) return body
  // `join` already parenthesises a group of several parts.
  return { sql: parts.length > 1 ? `NOT ${body.sql}` : `NOT (${body.sql})`, params: body.params }
}

/**
 * Compiles a filter tree to a WHERE condition (without the word WHERE); `null` when the tree constrains
 * nothing. Throws `RowValueError` (a `BuildRefusal`) for an unknown column, an operator that is not allowed,
 * or an invalid value; nothing has been run at that point.
 */
export function compileFilter(table: RowTable, node: FilterNode): SqlFragment | null {
  if (!filterWithinLimits(node)) refuse('invalid-value', 'The filter is too large')
  return compileNode(table, node)
}

const SEARCH_TEXT_KINDS = new Set(['char', 'text', 'enum', 'set'])
const SEARCH_CAST_KINDS = new Set([
  'int',
  'decimal',
  'float',
  'year',
  'date',
  'time',
  'datetime',
  'timestamp',
])

/**
 * Quick search (FR-ROW-009): an OR of "contains" over the text-like columns (at most 30); with `allColumns`
 * numeric and temporal columns too, through `CAST(col AS CHAR)`. A `0x...` text also matches binary columns
 * by their bytes. `null` when the table has no column to search.
 */
export function compileSearch(table: RowTable, search: SearchInput): SqlFragment | null {
  const hex = /^0x(?:[0-9a-f]{2})+$/i.test(search.text)
    ? Buffer.from(search.text.slice(2), 'hex')
    : null
  const parts: SqlFragment[] = []
  const pattern = `%${likeEscape(search.text)}%`
  for (const col of table.columns) {
    if (parts.length >= MAX_SEARCH_COLUMNS) break
    if (col.kind === 'unknown') continue
    const c = q(col.name)
    if (SEARCH_TEXT_KINDS.has(col.kind)) {
      // "Contains" on every text-like kind; enum and set have no `contains` on the filter allow-list
      // (there they compare whole members), the quick search is the one place that reads them as text.
      const exact = search.matchCase && supportsMatchCase(col.kind)
      parts.push({
        sql: exact
          ? `${bytesLhs(col)} LIKE ${bytesParam(col)} ESCAPE '!'`
          : `${c} LIKE ? ESCAPE '!'`,
        params: [pattern],
      })
    } else if (search.allColumns && SEARCH_CAST_KINDS.has(col.kind)) {
      parts.push({ sql: `CAST(${c} AS CHAR) LIKE ? ESCAPE '!'`, params: [pattern] })
    } else if (hex && (col.kind === 'binary' || col.kind === 'blob')) {
      parts.push({ sql: `${c} = ?`, params: [hex] })
    }
  }
  return join(parts, ' OR ')
}

/** ANDs fragments, skipping nulls (an unconstrained part). */
export function combineAnd(...fragments: (SqlFragment | null | undefined)[]): SqlFragment | null {
  return join(
    fragments.filter((f): f is SqlFragment => f !== null && f !== undefined),
    ' AND ',
  )
}
