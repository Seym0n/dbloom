/**
 * Parser adapter (FR-SQL-005, 006, spec 5.1). The only file that imports the parser package; server
 * side only (the package is a WASM build and is never shipped to the browser).
 *
 * The parser is advisory: it refines what the lexer already knows (restricting WHERE, ALTER drops,
 * tables) and never decides alone. Everything the classifier needs is reduced to `ParsedFacts`, so a
 * replacement parser (e.g. `node-sql-parser`, dialect `mariadb`) implements `StatementParser` and
 * nothing else changes.
 */
import { init, parse } from '@guanmingchiu/sqlparser-ts'

export type SqlProduct = 'mysql' | 'mariadb'

export type ParseFailureReason =
  | 'off' // kill switch DBLOOM_SQL_PARSER=off
  | 'not-ready' // initParser() was not awaited or failed
  | 'too-large' // statement over the size budget
  | 'timeout' // the parse itself took longer than the time budget
  | 'rejected' // syntax the parser does not accept (often valid MySQL / MariaDB)
  | 'multiple' // more than one statement in the text
  | 'empty'

export type TableRef = { db?: string; table: string }

export type StatementFamily =
  | 'query'
  | 'insert'
  | 'replace'
  | 'update'
  | 'delete'
  | 'create'
  | 'alterTable'
  | 'drop'
  | 'truncate'
  | 'renameTable'
  | 'call'
  | 'lockTables'
  | 'explain'
  | 'other'

export type ParsedFacts = {
  family: StatementFamily
  /** The key of the top-level node of the parser's own tree (for diagnostics and tests). */
  statement: string
  tables: TableRef[]
  /** `query`: contains a locking clause (FOR UPDATE and the like). */
  locking?: boolean
  /** `update` / `delete` (also inside a WITH query). */
  dml?: { hasWhere: boolean; whereNonRestricting: boolean; hasLimit: boolean; singleTable: boolean }
  /** `alterTable`. */
  alter?: { drops: boolean; narrowing: boolean }
  /** `create` / `drop`: object type as the parser names it ('Table', 'Schema', 'View', ...). */
  objectType?: string
  /** `explain`. */
  explain?: { analyze: boolean; inner: ParsedFacts }
}

export type ParseResult =
  | { ok: true; ast: unknown; facts: ParsedFacts; ms: number }
  | { ok: false; reason: ParseFailureReason; message?: string }

/** What a parser package must provide. */
export interface StatementParser {
  readonly name: string
  version(): string
  init(): Promise<void>
  ready(): boolean
  /** Synchronous after `init()`. Exactly one statement, no delimiter. */
  parse(text: string, product: SqlProduct): ParseResult
}

export const PARSE_MAX_BYTES = 256 * 1024
export const PARSE_MAX_MS = 500

// ---- Reading the tree of @guanmingchiu/sqlparser-ts -------------------------------------------------

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function firstKey(v: unknown): string {
  return isObj(v) ? (Object.keys(v)[0] ?? '') : ''
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function objectName(v: unknown): TableRef | undefined {
  const parts: string[] = []
  for (const p of arr(v)) {
    const id = isObj(p) ? p.Identifier : undefined
    if (isObj(id) && typeof id.value === 'string') parts.push(id.value)
  }
  const table = parts[parts.length - 1]
  if (table === undefined) return undefined
  const db = parts.length > 1 ? parts[parts.length - 2] : undefined
  return db === undefined ? { table } : { db, table }
}

function tableFactorName(f: unknown): TableRef | undefined {
  return isObj(f) && isObj(f.Table) ? objectName(f.Table.name) : undefined
}

/** Canonical text of a subtree without source spans, lower-cased (identifiers are case-insensitive). */
function canon(v: unknown): string {
  return JSON.stringify(v, (k, x) => {
    if (k === 'span') return undefined
    return isObj(x) && isObj(x.Nested) && Object.keys(x).length === 1 ? x.Nested : x
  }).toLowerCase()
}

function hasColumnRef(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasColumnRef)
  if (!isObj(v)) return false
  for (const [k, x] of Object.entries(v)) {
    if (k === 'Identifier' || k === 'CompoundIdentifier') return true
    if (k === 'name' && 'uses_odbc_syntax' in v) continue // function name, not a column
    if (hasColumnRef(x)) return true
  }
  return false
}

const SELF_TRUE_OPS = new Set(['Eq', 'GtEq', 'LtEq', 'Spaceship'])

/** Heuristic tautology test of a WHERE expression. A guard rail, not a prover. */
function isTautology(e: unknown): boolean {
  if (!isObj(e)) return false
  if (!hasColumnRef(e)) return true
  const key = firstKey(e)
  const node = e[key]
  if (key === 'Nested') return isTautology(node)
  if (key === 'Value') return true
  if (key === 'BinaryOp' && isObj(node)) {
    const op = typeof node.op === 'string' ? node.op : ''
    if (op === 'Or') {
      if (isTautology(node.left) || isTautology(node.right)) return true
      const l = isObj(node.left) ? node.left : {}
      const r = isObj(node.right) ? node.right : {}
      const pair = (a: Obj, b: Obj): boolean =>
        'IsNull' in a && 'IsNotNull' in b && canon(a.IsNull) === canon(b.IsNotNull)
      return pair(l, r) || pair(r, l)
    }
    if (op === 'And') return isTautology(node.left) && isTautology(node.right)
    if (SELF_TRUE_OPS.has(op)) return canon(node.left) === canon(node.right)
    return false
  }
  if (key === 'UnaryOp' && isObj(node) && node.op === 'Not') {
    let inner: Obj = isObj(node.expr) ? node.expr : {}
    while (isObj(inner.Nested)) inner = inner.Nested
    const b = inner.BinaryOp
    if (isObj(b) && b.op === 'NotEq') return canon(b.left) === canon(b.right)
  }
  return false
}

function unwrapBody(body: unknown): { kind: string; node: Obj } | undefined {
  if (!isObj(body)) return undefined
  const kind = firstKey(body)
  const inner = body[kind]
  if (!isObj(inner)) return undefined
  const deeper = inner[kind]
  return { kind, node: isObj(deeper) ? deeper : inner }
}

function dmlFacts(kind: 'update' | 'delete', node: Obj): ParsedFacts {
  const tables: TableRef[] = []
  let singleTable = false
  if (kind === 'delete') {
    const from = isObj(node.from) ? (Object.values(node.from)[0] as unknown) : undefined
    const items = arr(from)
    for (const it of items) {
      if (!isObj(it)) continue
      const t = tableFactorName(it.relation)
      if (t) tables.push(t)
      for (const j of arr(it.joins)) {
        const jt = isObj(j) ? tableFactorName(j.relation) : undefined
        if (jt) tables.push(jt)
      }
    }
    singleTable = items.length === 1 && tables.length === 1 && arr(node.tables).length === 0
  } else {
    const tw = isObj(node.table) ? node.table : {}
    const t = tableFactorName(tw.relation)
    if (t) tables.push(t)
    for (const j of arr(tw.joins)) {
      const jt = isObj(j) ? tableFactorName(j.relation) : undefined
      if (jt) tables.push(jt)
    }
    singleTable = tables.length === 1 && arr(tw.joins).length === 0
  }
  const sel = node.selection
  const hasWhere = sel !== undefined && sel !== null
  return {
    family: kind,
    statement: kind === 'update' ? 'Update' : 'Delete',
    tables,
    dml: {
      hasWhere,
      whereNonRestricting: hasWhere && (!hasColumnRef(sel) || isTautology(sel)),
      hasLimit: node.limit !== undefined && node.limit !== null,
      singleTable,
    },
  }
}

function alterFacts(node: Obj): ParsedFacts {
  let drops = false
  let narrowing = false
  for (const op of arr(node.operations)) {
    const k = typeof op === 'string' ? op : firstKey(op)
    if (/^(Drop|Truncate|Discard|Remove|Exchange|Coalesce)/.test(k)) drops = true
    if (/^(ModifyColumn|ChangeColumn|AlterColumn)/.test(k)) narrowing = true
  }
  const t = objectName(node.name)
  return {
    family: 'alterTable',
    statement: 'AlterTable',
    tables: t ? [t] : [],
    alter: { drops, narrowing },
  }
}

function factsOf(stmt: unknown): ParsedFacts {
  const key = firstKey(stmt)
  const node = isObj(stmt) ? stmt[key] : undefined
  const other: ParsedFacts = { family: 'other', statement: key, tables: [] }
  if (!isObj(node) && !Array.isArray(node)) return other
  switch (key) {
    case 'Query': {
      const q = node as Obj
      const b = unwrapBody(q.body)
      const locking = arr(q.locks).length > 0
      if (b?.kind === 'Update')
        return { ...dmlFacts('update', b.node), statement: 'Query', locking }
      if (b?.kind === 'Delete')
        return { ...dmlFacts('delete', b.node), statement: 'Query', locking }
      if (b?.kind === 'Insert') {
        const t = isObj(b.node.table) ? objectName(b.node.table.TableName) : undefined
        return {
          family: b.node.replace_into === true ? 'replace' : 'insert',
          statement: 'Query',
          tables: t ? [t] : [],
        }
      }
      return { family: 'query', statement: 'Query', tables: [], locking }
    }
    case 'Insert': {
      const n = node as Obj
      const t = isObj(n.table) ? objectName(n.table.TableName) : undefined
      return {
        family: n.replace_into === true ? 'replace' : 'insert',
        statement: key,
        tables: t ? [t] : [],
      }
    }
    case 'Update':
      return dmlFacts('update', node as Obj)
    case 'Delete':
      return dmlFacts('delete', node as Obj)
    case 'AlterTable':
      return alterFacts(node as Obj)
    case 'CreateTable': {
      const t = objectName((node as Obj).name)
      return { family: 'create', statement: key, tables: t ? [t] : [], objectType: 'Table' }
    }
    case 'CreateView': {
      const t = objectName((node as Obj).name)
      return { family: 'create', statement: key, tables: t ? [t] : [], objectType: 'View' }
    }
    case 'CreateIndex':
    case 'CreateDatabase':
    case 'CreateSchema':
    case 'CreateSequence':
    case 'CreateTrigger':
      return { family: 'create', statement: key, tables: [], objectType: key.slice(6) }
    case 'Drop': {
      const n = node as Obj
      const tables: TableRef[] = []
      for (const nm of arr(n.names)) {
        const t = objectName(nm)
        if (t) tables.push(t)
      }
      const ot = typeof n.object_type === 'string' ? n.object_type : undefined
      return { family: 'drop', statement: key, tables, ...(ot ? { objectType: ot } : {}) }
    }
    case 'Truncate': {
      const tables: TableRef[] = []
      for (const t of arr((node as Obj).table_names)) {
        const r = isObj(t) ? objectName(t.name) : undefined
        if (r) tables.push(r)
      }
      return { family: 'truncate', statement: key, tables }
    }
    case 'RenameTable': {
      const tables: TableRef[] = []
      for (const r of arr(node)) {
        if (!isObj(r)) continue
        for (const k of ['old_name', 'new_name']) {
          const t = objectName(r[k])
          if (t) tables.push(t)
        }
      }
      return { family: 'renameTable', statement: key, tables }
    }
    case 'Call': {
      const t = objectName((node as Obj).name)
      return { family: 'call', statement: key, tables: t ? [t] : [] }
    }
    case 'LockTables': {
      const tables: TableRef[] = []
      for (const l of arr((node as Obj).tables)) {
        const tn =
          isObj(l) && isObj(l.table) && typeof l.table.value === 'string' ? l.table.value : ''
        if (tn) tables.push({ table: tn })
      }
      return { family: 'lockTables', statement: key, tables }
    }
    case 'Explain': {
      const n = node as Obj
      return {
        family: 'explain',
        statement: key,
        tables: [],
        explain: { analyze: n.analyze === true, inner: factsOf(n.statement) },
      }
    }
    default:
      return other
  }
}

// ---- Default implementation: @guanmingchiu/sqlparser-ts ------------------------------------------------

let wasmReady = false
let wasmInit: Promise<void> | undefined

const sqlparserTs: StatementParser = {
  name: '@guanmingchiu/sqlparser-ts',
  version: () => '0.63.0',
  ready: () => wasmReady,
  init(): Promise<void> {
    wasmInit ??= init().then(
      () => {
        wasmReady = true
      },
      (e: unknown) => {
        wasmInit = undefined
        throw e
      },
    )
    return wasmInit
  },
  parse(text: string): ParseResult {
    if (!wasmReady) return { ok: false, reason: 'not-ready' }
    if (text.length > PARSE_MAX_BYTES) return { ok: false, reason: 'too-large' }
    const t0 = performance.now()
    let out: unknown[]
    try {
      // one dialect for both products: the package has no MariaDB dialect (spec 5.1)
      out = parse(text, 'mysql') as unknown[]
    } catch (e) {
      return { ok: false, reason: 'rejected', message: e instanceof Error ? e.message : String(e) }
    }
    const ms = performance.now() - t0
    if (ms > PARSE_MAX_MS) return { ok: false, reason: 'timeout' }
    if (out.length === 0) return { ok: false, reason: 'empty' }
    if (out.length > 1) return { ok: false, reason: 'multiple' }
    return { ok: true, ast: out[0], facts: factsOf(out[0]), ms }
  },
}

let active: StatementParser = sqlparserTs

/** Replace the parser (tests, or a future `node-sql-parser` adapter). */
export function setStatementParser(p: StatementParser): void {
  active = p
}

export function getStatementParser(): StatementParser {
  return active
}

/** Kill switch: `DBLOOM_SQL_PARSER=off` (read at each call). */
export function parserDisabled(): boolean {
  return process.env.DBLOOM_SQL_PARSER?.trim().toLowerCase() === 'off'
}

export function initParser(): Promise<void> {
  return active.init()
}

export function parseStatement(text: string, product: SqlProduct): ParseResult {
  if (parserDisabled()) return { ok: false, reason: 'off' }
  return active.parse(text, product)
}
