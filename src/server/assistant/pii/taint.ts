/**
 * Taint analysis and inference guard (SPEC/34 FR-AST-008, FR-AST-009). Reads the parser's tree of one statement and says,
 * for each output column of a query, whether its values come from a PII column (`pii`), cannot be traced (`unknown`) or
 * are free of PII (`clean`). It also lists every place where a PII column is used in a way that would let a model read a
 * value through the shape of the answer (a comparison other than equality with a token, a function in a predicate, ...).
 *
 * Fail closed: anything this file does not understand becomes `unknown`, never `clean`. Pure: the schema and the rules
 * are passed in, no I/O. The parser must be initialised (`initParser`) by the caller.
 */
import { parseStatement, type SqlProduct } from '~/server/sql/parser'
import type { CompiledRules } from './rules'

export type Taint = 'clean' | 'pii' | 'unknown'
export type OutputColumn = { name: string; taint: Taint }
export type SchemaColumn = { name: string; type: string }
export type TableSchema = { columns: SchemaColumn[]; view: boolean }
export type SchemaLookup = (db: string | undefined, table: string) => TableSchema | undefined

export type AnalyzeContext = {
  product?: SqlProduct
  defaultDb?: string
  rules: CompiledRules
  /** Column lists of the tables the statement names. Without an entry a table's columns are read by name only. */
  schema?: SchemaLookup
  /** No markings and no acknowledgement for this target (SPEC/34 Q7): text-like columns count as unknown. */
  unconfigured?: boolean
  /** True for a token this conversation issued. Only such a literal may be compared with a PII column. */
  isIssuedToken: (literal: string) => boolean
}

export type Violation = { code: 'inference'; detail: string }

export type Analysis =
  | { kind: 'query'; outputs: OutputColumn[]; violations: Violation[] }
  | { kind: 'write'; violations: Violation[] }
  | { kind: 'unsupported'; reason: string }

const rank: Record<Taint, number> = { clean: 0, pii: 1, unknown: 2 }
const join = (a: Taint, b: Taint): Taint => (rank[a] >= rank[b] ? a : b)

const TEXT_TYPE = /^(char|varchar|tinytext|text|mediumtext|longtext|json|enum|set|binary|varbinary|tinyblob|blob|mediumblob|longblob)/i
export const isTextLike = (type: string): boolean => TEXT_TYPE.test(type.trim())

type Node = Record<string, unknown>
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A name part: `{Identifier: {value}}`, `{value}` or a bare string. */
function partValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (isNode(v)) {
    if (isNode(v.Identifier)) return partValue(v.Identifier)
    if (typeof v.value === 'string') return v.value
  }
  return ''
}
const nameParts = (v: unknown): string[] => {
  if (isNode(v) && 'ObjectName' in v) return nameParts(v.ObjectName)
  return arr(v).map(partValue)
}

type Source = {
  alias: string
  db?: string
  table?: string
  cols?: OutputColumn[]
  /** Columns are not known: resolved by name against the markings. */
  opaque?: boolean
  /** Nothing can be said about this source (table function, lateral, ...). */
  unknownAll?: boolean
}
type Scope = { sources: Source[]; parent?: Scope; ctes: Map<string, OutputColumn[]> }
type State = { violations: Map<string, Violation>; steps: number }

class TooComplex extends Error {}

const STEP_LIMIT = 50_000
const step = (st: State): void => {
  if (++st.steps > STEP_LIMIT) throw new TooComplex()
}
const violate = (st: State, detail: string): void => {
  st.violations.set(detail, { code: 'inference', detail })
}

const newScope = (parent?: Scope): Scope => ({ sources: [], ...(parent ? { parent } : {}), ctes: new Map() })
const findCte = (scope: Scope | undefined, name: string): OutputColumn[] | undefined => {
  for (let s = scope; s; s = s.parent) {
    const hit = s.ctes.get(name)
    if (hit) return hit
  }
  return undefined
}

// ---- Column resolution ----------------------------------------------------------------------------------

function opaqueTaint(s: Source, name: string, ctx: AnalyzeContext): Taint {
  if (s.unknownAll) return 'unknown'
  if (s.table !== undefined && ctx.rules.isPiiColumn(s.db, s.table, name)) return 'pii'
  return ctx.unconfigured ? 'unknown' : 'clean'
}

function resolveIn(scope: Scope, parts: string[], ctx: AnalyzeContext): Taint | undefined {
  const name = parts[parts.length - 1]!.toLowerCase()
  let cands: Source[]
  if (parts.length === 1) cands = scope.sources
  else if (parts.length === 2) cands = scope.sources.filter((s) => s.alias === parts[0]!.toLowerCase())
  else
    cands = scope.sources.filter(
      (s) => s.table === parts[parts.length - 2]!.toLowerCase() && (s.db === undefined || s.db === parts[parts.length - 3]!.toLowerCase()),
    )
  let out: Taint | undefined
  for (const s of cands) {
    if (s.unknownAll) out = join(out ?? 'clean', 'unknown')
    else if (s.cols) {
      for (const c of s.cols) if (c.name.toLowerCase() === name) out = join(out ?? 'clean', c.taint)
    } else if (s.opaque) out = join(out ?? 'clean', opaqueTaint(s, name, ctx))
  }
  return out
}

function lookup(scope: Scope, parts: string[], ctx: AnalyzeContext): Taint {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    const r = resolveIn(s, parts, ctx)
    if (r !== undefined) return r
  }
  return 'unknown'
}

function baseTaint(ctx: AnalyzeContext, db: string | undefined, table: string, col: SchemaColumn, view: boolean): Taint {
  if (ctx.rules.isPiiColumn(db, table, col.name)) return 'pii'
  if (view) return 'unknown' // a view may expose a PII column under another name
  if (ctx.unconfigured && isTextLike(col.type)) return 'unknown'
  return 'clean'
}

function renameByAlias(outs: OutputColumn[], alias: unknown): OutputColumn[] {
  const names = arr(isNode(alias) ? alias.columns : undefined).map((c) => (isNode(c) && 'name' in c ? partValue(c.name) : partValue(c)))
  if (names.length === 0) return outs
  if (names.length !== outs.length) return outs.map((o) => ({ ...o, taint: 'unknown' as Taint }))
  return outs.map((o, i) => ({ name: names[i]!, taint: o.taint }))
}

function tableSource(parts: string[], alias: string | undefined, scope: Scope, ctx: AnalyzeContext): Source {
  const table = parts[parts.length - 1]!.toLowerCase()
  const name = alias?.toLowerCase() ?? table
  if (parts.length === 1) {
    const cte = findCte(scope, table)
    if (cte) return { alias: name, cols: cte }
  }
  const db = (parts.length >= 2 ? parts[parts.length - 2]! : ctx.defaultDb)?.toLowerCase()
  const schema = ctx.schema?.(db, table)
  if (!schema) return { alias: name, ...(db ? { db } : {}), table, opaque: true }
  return {
    alias: name,
    ...(db ? { db } : {}),
    table,
    cols: schema.columns.map((c) => ({ name: c.name, taint: baseTaint(ctx, db, table, c, schema.view) })),
  }
}

// ---- Expressions ----------------------------------------------------------------------------------------

const isQueryNode = (n: Node): boolean => 'body' in n && ('locks' in n || 'order_by' in n || 'with' in n || 'limit_clause' in n)

const isBare = (e: unknown): boolean => {
  if (!isNode(e)) return false
  const keys = Object.keys(e)
  if (keys.length !== 1) return false
  const k = keys[0]!
  if (k === 'Identifier' || k === 'CompoundIdentifier') return true
  if (k === 'Nested') return isBare(e.Nested)
  return false
}

const literalString = (e: unknown): string | undefined => {
  if (!isNode(e) || !isNode(e.Value)) return undefined
  const v = (e.Value as Node).value
  if (!isNode(v)) return undefined
  if (typeof v.SingleQuotedString === 'string') return v.SingleQuotedString
  if (typeof v.DoubleQuotedString === 'string') return v.DoubleQuotedString
  return undefined
}
const isNullLiteral = (e: unknown): boolean => isNode(e) && isNode(e.Value) && (e.Value as Node).value === 'Null'

function queryOutputsTaint(outs: OutputColumn[] | undefined): Taint {
  if (!outs) return 'unknown'
  return outs.reduce<Taint>((t, o) => join(t, o.taint), 'clean')
}

function exprTaint(e: unknown, scope: Scope, ctx: AnalyzeContext, st: State): Taint {
  step(st)
  if (Array.isArray(e)) return e.reduce<Taint>((t, x) => join(t, exprTaint(x, scope, ctx, st)), 'clean')
  if (!isNode(e)) return 'clean'
  if (isQueryNode(e)) return queryOutputsTaint(analyzeQuery(e, scope, ctx, st))
  const keys = Object.keys(e)
  if (keys.length === 1) {
    const k = keys[0]!
    const v = e[k]
    switch (k) {
      case 'Identifier':
        return lookup(scope, [partValue(v)], ctx)
      case 'CompoundIdentifier':
        return lookup(scope, arr(v).map(partValue), ctx)
      case 'Value':
        return 'clean'
      case 'Function':
        return functionTaint(v, scope, ctx, st)
      case 'Subquery':
        return exprTaint(v, scope, ctx, st)
      case 'Exists': {
        exprTaint(isNode(v) ? v.subquery : undefined, scope, ctx, st)
        return 'clean'
      }
      case 'InSubquery': {
        const n = isNode(v) ? v : {}
        return join(exprTaint(n.expr, scope, ctx, st), exprTaint(n.subquery, scope, ctx, st))
      }
    }
  }
  let t: Taint = 'clean'
  for (const [k, v] of Object.entries(e)) {
    if (k === 'span') continue
    t = join(t, exprTaint(v, scope, ctx, st))
  }
  return t
}

function windowExprs(over: unknown): unknown[] {
  if (!isNode(over)) return []
  const spec = isNode(over.WindowSpec) ? (over.WindowSpec as Node) : undefined
  if (!spec) return []
  return [...arr(spec.partition_by), ...arr(spec.order_by).map((o) => (isNode(o) ? o.expr : o))]
}

function functionTaint(f: unknown, scope: Scope, ctx: AnalyzeContext, st: State): Taint {
  if (!isNode(f)) return 'unknown'
  const name = partValue(arr(f.name).at(-1)).toUpperCase()
  const parts: unknown[] = [f.args, f.filter, f.within_group, f.parameters]
  for (const w of windowExprs(f.over)) checkBareOrClean(w, scope, ctx, st, 'window')
  const inner = exprTaint(parts, scope, ctx, st)
  if (isNode(f.over) && 'WindowSpec' in f.over) {
    // a window over PII columns changes what the value means: it stays tainted (except a plain count)
    const w = exprTaint(windowExprs(f.over), scope, ctx, st)
    if (name !== 'COUNT') return join(inner, w)
  }
  return name === 'COUNT' ? 'clean' : inner
}

// ---- Predicates and the inference guard -------------------------------------------------------------------

function checkBareOrClean(e: unknown, scope: Scope, ctx: AnalyzeContext, st: State, where: string): void {
  const t = exprTaint(e, scope, ctx, st)
  if (t !== 'clean' && !isBare(e)) violate(st, `${where}: an expression over a PII column`)
}

function isTokenLiteral(e: unknown, ctx: AnalyzeContext): boolean {
  const s = literalString(e)
  return s !== undefined && ctx.isIssuedToken(s)
}

function comparePredicate(l: unknown, r: unknown, op: string, scope: Scope, ctx: AnalyzeContext, st: State): void {
  const tl = exprTaint(l, scope, ctx, st)
  const tr = exprTaint(r, scope, ctx, st)
  if (tl === 'clean' && tr === 'clean') return
  if (isBare(l) && isBare(r)) return
  if (tl !== 'clean' && isBare(l) && tr === 'clean' && (isTokenLiteral(r, ctx) || isNullLiteral(r))) return
  if (tr !== 'clean' && isBare(r) && tl === 'clean' && (isTokenLiteral(l, ctx) || isNullLiteral(l))) return
  violate(st, `${op} on a PII column needs a token of this conversation or another column`)
}

function checkPredicate(e: unknown, scope: Scope, ctx: AnalyzeContext, st: State): void {
  step(st)
  if (!isNode(e)) return
  const keys = Object.keys(e)
  if (keys.length !== 1) {
    if (exprTaint(e, scope, ctx, st) !== 'clean') violate(st, 'predicate: an expression over a PII column')
    return
  }
  const k = keys[0]!
  const v = e[k]
  const n = isNode(v) ? v : ({} as Node)
  switch (k) {
    case 'BinaryOp': {
      const op = String(n.op)
      if (op === 'And' || op === 'Or') {
        checkPredicate(n.left, scope, ctx, st)
        checkPredicate(n.right, scope, ctx, st)
      } else if (op === 'Eq' || op === 'NotEq' || op === 'Spaceship') comparePredicate(n.left, n.right, op, scope, ctx, st)
      else if (exprTaint(e, scope, ctx, st) !== 'clean') violate(st, `${op} on a PII column is refused`)
      return
    }
    case 'UnaryOp': {
      if (String(n.op) === 'Not') checkPredicate(n.expr, scope, ctx, st)
      else if (exprTaint(e, scope, ctx, st) !== 'clean') violate(st, 'unary operator on a PII column is refused')
      return
    }
    case 'Nested':
      checkPredicate(v, scope, ctx, st)
      return
    case 'IsNull':
    case 'IsNotNull':
    case 'IsTrue':
    case 'IsNotTrue':
    case 'IsFalse':
    case 'IsNotFalse':
    case 'IsUnknown':
    case 'IsNotUnknown': {
      if (exprTaint(v, scope, ctx, st) !== 'clean' && !isBare(v)) violate(st, `${k} on an expression over a PII column`)
      return
    }
    case 'InList': {
      const t = exprTaint(n.expr, scope, ctx, st)
      const items = arr(n.list)
      const itemTaint = exprTaint(items, scope, ctx, st)
      if ((t !== 'clean' || itemTaint !== 'clean') && !(isBare(n.expr) && items.every((i) => isTokenLiteral(i, ctx) || isBare(i)))) {
        violate(st, 'IN on a PII column needs tokens of this conversation')
      }
      return
    }
    case 'InSubquery': {
      const t = exprTaint(n.expr, scope, ctx, st)
      if (t !== 'clean' && !isBare(n.expr)) violate(st, 'IN on an expression over a PII column')
      exprTaint(n.subquery, scope, ctx, st)
      return
    }
    case 'Value':
      return
    default:
      if (exprTaint(e, scope, ctx, st) !== 'clean') violate(st, `${k} on a PII column is refused`)
  }
}

// ---- Queries ----------------------------------------------------------------------------------------------

type BodyResult = { outs: OutputColumn[]; scope: Scope }

function exprName(e: unknown, index: number): string {
  if (isNode(e)) {
    if ('Identifier' in e) return partValue(e.Identifier)
    if ('CompoundIdentifier' in e) return arr(e.CompoundIdentifier).map(partValue).at(-1) ?? `col${index + 1}`
  }
  return `col${index + 1}`
}

function sourceOutputs(s: Source): OutputColumn[] {
  if (s.cols) return s.cols
  return [{ name: '*', taint: 'unknown' }]
}

function addRelation(rel: unknown, scope: Scope, outer: Scope, ctx: AnalyzeContext, st: State, ons: { e: unknown }[]): void {
  step(st)
  if (!isNode(rel)) {
    scope.sources.push({ alias: '', unknownAll: true })
    return
  }
  const alias = isNode(rel.alias) ? partValue((rel.alias as Node).name) || undefined : undefined
  if (isNode(rel.Table)) {
    const t = rel.Table as Node
    if (t.args !== undefined && t.args !== null) {
      scope.sources.push({ alias: alias?.toLowerCase() ?? '', unknownAll: true })
      return
    }
    scope.sources.push(tableSource(nameParts(t.name), isNode(t.alias) ? partValue((t.alias as Node).name) || undefined : undefined, scope, ctx))
    return
  }
  if (isNode(rel.Derived)) {
    const d = rel.Derived as Node
    const a = isNode(d.alias) ? partValue((d.alias as Node).name) : ''
    const outs = analyzeQuery(d.subquery, d.lateral === true ? scope : outer, ctx, st)
    if (!outs) scope.sources.push({ alias: a.toLowerCase(), unknownAll: true })
    else scope.sources.push({ alias: a.toLowerCase(), cols: renameByAlias(outs, d.alias) })
    return
  }
  if (isNode(rel.NestedJoin)) {
    const n = rel.NestedJoin as Node
    addTableWithJoins(n.table_with_joins, scope, outer, ctx, st, ons)
    return
  }
  scope.sources.push({ alias: alias?.toLowerCase() ?? '', unknownAll: true })
}

function addTableWithJoins(twj: unknown, scope: Scope, outer: Scope, ctx: AnalyzeContext, st: State, ons: { e: unknown }[]): void {
  if (!isNode(twj)) return
  addRelation(twj.relation, scope, outer, ctx, st, ons)
  for (const j of arr(twj.joins)) {
    if (!isNode(j)) continue
    addRelation(j.relation, scope, outer, ctx, st, ons)
    // the join operator holds the condition in a variant: `{Inner: {On: expr}}`, `{Join: {On: expr}}`, ...
    collectOn(j.join_operator, ons)
  }
}

function collectOn(op: unknown, ons: { e: unknown }[]): void {
  if (!isNode(op)) return
  for (const v of Object.values(op)) {
    if (!isNode(v)) continue
    if ('On' in v) ons.push({ e: (v as Node).On })
    else collectOn(v, ons)
  }
}

function analyzeSelect(sel: Node, scope0: Scope, ctx: AnalyzeContext, st: State): BodyResult {
  const scope = newScope(scope0)
  const ons: { e: unknown }[] = []
  for (const twj of arr(sel.from)) addTableWithJoins(twj, scope, scope0, ctx, st, ons)
  for (const o of ons) checkPredicate(o.e, scope, ctx, st)

  const outs: OutputColumn[] = []
  for (const [i, item] of arr(sel.projection).entries()) {
    step(st)
    if (!isNode(item)) {
      outs.push({ name: `col${i + 1}`, taint: 'unknown' })
      continue
    }
    if ('UnnamedExpr' in item) {
      outs.push({ name: exprName(item.UnnamedExpr, i), taint: exprTaint(item.UnnamedExpr, scope, ctx, st) })
    } else if (isNode(item.ExprWithAlias)) {
      const x = item.ExprWithAlias as Node
      outs.push({ name: partValue(x.alias) || exprName(x.expr, i), taint: exprTaint(x.expr, scope, ctx, st) })
    } else if ('Wildcard' in item) {
      for (const s of scope.sources) outs.push(...sourceOutputs(s))
      if (scope.sources.length === 0) outs.push({ name: '*', taint: 'unknown' })
    } else if (Array.isArray(item.QualifiedWildcard)) {
      const q = nameParts(item.QualifiedWildcard[0])
      const name = q.at(-1)?.toLowerCase()
      const hits = scope.sources.filter((s) => s.alias === name || (s.table === name && s.alias === s.table))
      if (hits.length === 0) outs.push({ name: '*', taint: 'unknown' })
      for (const s of hits) outs.push(...sourceOutputs(s))
    } else outs.push({ name: `col${i + 1}`, taint: 'unknown' })
  }

  checkPredicate(sel.selection, scope, ctx, st)
  checkPredicate(sel.having, scope, ctx, st)
  checkPredicate(sel.qualify, scope, ctx, st)
  const gb = isNode(sel.group_by) ? (sel.group_by as Node).Expressions : undefined
  for (const e of arr(gb).flat()) checkBareOrClean(e, scope, ctx, st, 'GROUP BY')
  return { outs, scope }
}

function outputSource(outs: OutputColumn[]): Source {
  return { alias: '', cols: outs }
}

function analyzeBody(body: unknown, scope0: Scope, ctx: AnalyzeContext, st: State): BodyResult | undefined {
  step(st)
  if (!isNode(body)) return undefined
  if (isNode(body.Select)) return analyzeSelect(body.Select as Node, scope0, ctx, st)
  if (isNode(body.Query)) {
    const outs = analyzeQuery(body.Query, scope0, ctx, st)
    if (!outs) return undefined
    const scope = newScope(scope0)
    scope.sources.push(outputSource(outs))
    return { outs, scope }
  }
  if (isNode(body.SetOperation)) {
    const op = body.SetOperation as Node
    const l = analyzeBody(op.left, scope0, ctx, st)
    const r = analyzeBody(op.right, scope0, ctx, st)
    if (!l || !r) return undefined
    const outs: OutputColumn[] =
      l.outs.length === r.outs.length
        ? l.outs.map((o, i) => ({ name: o.name, taint: join(o.taint, r.outs[i]!.taint) }))
        : l.outs.map((o) => ({ name: o.name, taint: 'unknown' as Taint }))
    const scope = newScope(scope0)
    scope.sources.push(outputSource(outs))
    return { outs, scope }
  }
  if (isNode(body.Values)) {
    const rows = arr((body.Values as Node).rows)
    const width = Math.max(0, ...rows.map((r) => arr(r).length))
    if (width === 0) return undefined
    const outs: OutputColumn[] = Array.from({ length: width }, (_, i) => ({
      name: `column${i + 1}`,
      taint: rows.reduce<Taint>((t, r) => join(t, exprTaint(arr(r)[i], scope0, ctx, st)), 'clean'),
    }))
    const scope = newScope(scope0)
    scope.sources.push(outputSource(outs))
    return { outs, scope }
  }
  return undefined
}

function orderExprs(v: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) {
    for (const x of v) orderExprs(x, out)
  } else if (isNode(v)) {
    if ('expr' in v && 'options' in v) out.push(v.expr)
    else for (const x of Object.values(v)) orderExprs(x, out)
  }
  return out
}

function analyzeQuery(q: unknown, outer: Scope, ctx: AnalyzeContext, st: State): OutputColumn[] | undefined {
  step(st)
  if (!isNode(q)) return undefined
  const scope0 = newScope(outer)
  if (isNode(q.with)) {
    const w = q.with as Node
    for (const cte of arr(w.cte_tables)) {
      if (!isNode(cte)) continue
      const name = partValue(isNode(cte.alias) ? (cte.alias as Node).name : undefined).toLowerCase()
      if (w.recursive === true) scope0.ctes.set(name, [{ name: '*', taint: 'unknown' }])
      const outs = analyzeQuery(cte.query, scope0, ctx, st)
      scope0.ctes.set(name, outs ? renameByAlias(outs, cte.alias) : [{ name: '*', taint: 'unknown' }])
    }
  }
  const body = analyzeBody(q.body, scope0, ctx, st)
  if (!body) return undefined
  const orderScope = newScope(body.scope)
  orderScope.sources.push(outputSource(body.outs))
  for (const e of orderExprs(q.order_by)) checkBareOrClean(e, orderScope, ctx, st, 'ORDER BY')
  return body.outs
}

// ---- Entry point ------------------------------------------------------------------------------------------

function analyzeWrite(ast: Node, ctx: AnalyzeContext, st: State): void {
  const root = newScope()
  if (isNode(ast.Update)) {
    const u = ast.Update as Node
    const scope = newScope(root)
    const ons: { e: unknown }[] = []
    addTableWithJoins(u.table, scope, root, ctx, st, ons)
    if (u.from !== undefined && u.from !== null) {
      const from = isNode(u.from) ? Object.values(u.from).flat() : []
      for (const f of from) addTableWithJoins(f, scope, root, ctx, st, ons)
    }
    for (const o of ons) checkPredicate(o.e, scope, ctx, st)
    for (const a of arr(u.assignments)) exprTaint(isNode(a) ? a.value : undefined, scope, ctx, st)
    checkPredicate(u.selection, scope, ctx, st)
    return
  }
  const ins = ast.Insert as Node
  const scope = newScope(root)
  const tname = isNode(ins.table) ? nameParts((ins.table as Node).TableName ?? (ins.table as Node).name) : []
  if (tname.length > 0) scope.sources.push(tableSource(tname, undefined, scope, ctx))
  if (ins.source) analyzeQuery(ins.source, root, ctx, st)
  exprTaint(ins.on, scope, ctx, st)
}

export function analyzeStatement(sql: string, ctx: AnalyzeContext): Analysis {
  const parsed = parseStatement(sql, ctx.product ?? 'mysql')
  if (!parsed.ok) return { kind: 'unsupported', reason: `parse-${parsed.reason}` }
  const ast = parsed.ast
  if (!isNode(ast)) return { kind: 'unsupported', reason: 'no-tree' }
  const st: State = { violations: new Map(), steps: 0 }
  try {
    if (isNode(ast.Query)) {
      const outs = analyzeQuery(ast.Query, newScope(), ctx, st)
      if (!outs) return { kind: 'unsupported', reason: 'query-shape' }
      return { kind: 'query', outputs: outs, violations: [...st.violations.values()] }
    }
    if (isNode(ast.Update) || isNode(ast.Insert)) {
      analyzeWrite(ast, ctx, st)
      return { kind: 'write', violations: [...st.violations.values()] }
    }
    return { kind: 'unsupported', reason: `statement-${Object.keys(ast)[0] ?? 'unknown'}` }
  } catch (error) {
    if (error instanceof TooComplex) return { kind: 'unsupported', reason: 'too-complex' }
    throw error
  }
}
