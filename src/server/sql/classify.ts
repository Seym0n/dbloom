/**
 * Statement classifier (FR-SQL-005, 006, 007, spec 5.3). Pure and synchronous once `initParser()` ran.
 *
 * The hand-written keyword classifier on the lexer's tokens is the floor and decides every fact it can
 * decide alone (kind, drops, accounts, global SET, INTO OUTFILE, locks, read-only bypass attempts). The
 * parser only refines the few verdicts that need the shape of the statement (restricting WHERE, ALTER
 * operations, the INSERT / CREATE / CALL family) and can never lower a verdict the floor made. A statement
 * the parser rejects is never silently allowed: plain reads from the keyword allow-list stay class none,
 * everything else that needs the parser is hard with reason `unparsed` (`parser-off`, `budget`).
 *
 * Guard rail, not a boundary: the target's privileges are the boundary (SEC-TGT-050). Known limits:
 * the WHERE test is a heuristic (`id >= 0` is accepted as restricting); the effect of `CALL` and of
 * functions inside a `SELECT` is unknown (the read-only transaction of the runner covers them); the
 * lexer reads strings with the escape mode it is given, so a wrong `noBackslashEscapes` can mislead it.
 */
import type {
  Classification,
  ClassificationReason,
  ClassifiedStatement,
  SqlKind,
  SqlStatementText,
} from './types'
import type { StatementClass } from '../structure/types'
import { codeTokens, type CodeToken, type LexOptions } from '../../lib/sql/lexer'
import { splitStatements } from '../../lib/sql/splitter'
import {
  PARSE_MAX_BYTES,
  parseStatement,
  parserDisabled,
  type ParseResult,
  type ParsedFacts,
  type SqlProduct,
  type StatementParser,
} from './parser'

export type ClassifyContext = {
  product: SqlProduct
  /** undefined: the module's parser; null: no parser (every verdict that needs one is `parser-off`). */
  parser?: StatementParser | null
  /** Lexer options as read from the session (`@@sql_mode`). */
  lex?: LexOptions
  /** Internal: set by `classifyBatch` once the time budget is spent. */
  budgetSpent?: boolean
  depth?: number
}

export const BATCH_BUDGET_MS = 2000
const MAX_DEPTH = 3

const RANK: Record<StatementClass, number> = { none: 0, soft: 1, hard: 2 }

export function maxClass(classes: Iterable<StatementClass>): StatementClass {
  let m: StatementClass = 'none'
  for (const c of classes) if (RANK[c] > RANK[m]) m = c
  return m
}

// ---- keyword tables ---------------------------------------------------------------------------------

const ACCOUNT_OBJECTS = new Set(['USER', 'ROLE'])
const ADMIN_COMMON = new Set([
  'INSTALL',
  'UNINSTALL',
  'SHUTDOWN',
  'RESET',
  'CHANGE',
  'PURGE',
  'BINLOG',
  'CACHE',
  'STOP',
])
const ADMIN_MYSQL = new Set(['CLONE', 'RESTART', 'IMPORT'])
const ADMIN_MARIADB = new Set(['BACKUP'])
const CREATE_OBJECTS = new Set([
  'TABLE',
  'DATABASE',
  'SCHEMA',
  'VIEW',
  'INDEX',
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'EVENT',
  'USER',
  'ROLE',
  'SEQUENCE',
  'SERVER',
  'TABLESPACE',
  'LOGFILE',
  'RESOURCE',
  'SPATIAL',
  'UNDO',
  'AGGREGATE',
])
const ALTER_OBJECTS = new Set([
  'TABLE',
  'DATABASE',
  'SCHEMA',
  'VIEW',
  'USER',
  'ROLE',
  'EVENT',
  'PROCEDURE',
  'FUNCTION',
  'SERVER',
  'INSTANCE',
  'TABLESPACE',
  'SEQUENCE',
  'LOGFILE',
  'RESOURCE',
])
const ALTER_DROPS = new Set(['DROP', 'TRUNCATE', 'DISCARD', 'EXCHANGE', 'REMOVE', 'COALESCE'])
const STMT_STARTERS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'TABLE',
  'WITH',
  'VALUES',
])
const FLUSH_SOFT_FIRST = new Set([
  'TABLES',
  'TABLE',
  'LOGS',
  'BINARY',
  'ENGINE',
  'ERROR',
  'GENERAL',
  'RELAY',
  'SLOW',
  'STATUS',
  'OPTIMIZER_COSTS',
  'NO_WRITE_TO_BINLOG',
  'LOCAL',
  'QUERY',
])
const FLUSH_DENY = new Set([
  'PRIVILEGES',
  'USER_RESOURCES',
  'USER',
  'READ',
  'LOCK',
  'FOR',
  'MASTER',
  'SLAVE',
  'REPLICA',
  'HOSTS',
  'SSL',
  'DES_KEY_FILE',
  'CLIENT_STATISTICS',
  'INDEX_STATISTICS',
  'TABLE_STATISTICS',
  'USER_STATISTICS',
])
const TX_WORDS = new Set([
  'WORK',
  'AND',
  'NO',
  'CHAIN',
  'RELEASE',
  'TO',
  'SAVEPOINT',
  'READ',
  'WRITE',
  'ONLY',
  'WITH',
  'CONSISTENT',
  'SNAPSHOT',
  'TRANSACTION',
])

// ---- small token helpers ----------------------------------------------------------------------------

type Tok = CodeToken

function word(t: Tok[], i: number): string {
  const x = t[i]
  return x !== undefined && x.type === 'word' ? x.upper : ''
}

function isOp(t: Tok[], i: number, s: string): boolean {
  const x = t[i]
  return x !== undefined && x.type === 'op' && x.text === s
}

function hasWord(t: Tok[], w: string, from = 0): boolean {
  for (let i = from; i < t.length; i++) if (word(t, i) === w) return true
  return false
}

function seq(t: Tok[], i: number, ...ws: string[]): boolean {
  return ws.every((w, k) => word(t, i + k) === w)
}

function hasSeq(t: Tok[], ...ws: string[]): boolean {
  for (let i = 0; i + ws.length <= t.length; i++) if (seq(t, i, ...ws)) return true
  return false
}

/** Index after the balanced paren group starting at `i` (which must be `(`), or -1. */
function skipGroup(t: Tok[], i: number): number {
  let d = 0
  for (let j = i; j < t.length; j++) {
    if (isOp(t, j, '(')) d++
    else if (isOp(t, j, ')')) {
      d--
      if (d === 0) return j + 1
    }
  }
  return -1
}

// ---- verdict ----------------------------------------------------------------------------------------

type Verdict = Classification

function v(
  kind: SqlKind,
  cls: StatementClass,
  o: {
    safe?: boolean
    commits?: boolean
    reasons?: ClassificationReason[]
    tables?: { db?: string; table: string }[]
    databases?: string[]
  } = {},
): Verdict {
  const out: Verdict = {
    kind,
    class: cls,
    readOnlySafe: (o.safe ?? false) && cls === 'none',
    commitsImplicitly: o.commits ?? false,
    reasons: o.reasons ?? [],
  }
  if (o.tables && o.tables.length > 0) out.tables = o.tables
  if (o.databases && o.databases.length > 0) out.databases = o.databases
  return out
}

function unparsedReason(r: ParseResult | undefined, ctx: ClassifyContext): ClassificationReason {
  if (ctx.parser === null) return 'parser-off'
  if (ctx.budgetSpent) return 'budget'
  if (r && !r.ok) {
    if (r.reason === 'off') return 'parser-off'
    if (r.reason === 'too-large' || r.reason === 'timeout') return 'budget'
  }
  return 'unparsed'
}

function runParse(text: string, ctx: ClassifyContext): ParseResult {
  if (ctx.budgetSpent) return { ok: false, reason: 'timeout' }
  if (ctx.parser === null) return { ok: false, reason: 'off' }
  if (text.length > PARSE_MAX_BYTES) return { ok: false, reason: 'too-large' }
  if (ctx.parser === undefined) return parseStatement(text, ctx.product)
  if (parserDisabled()) return { ok: false, reason: 'off' }
  return ctx.parser.parse(text, ctx.product)
}

// ---- per-family analysis ----------------------------------------------------------------------------

function hard(
  kind: SqlKind,
  reasons: ClassificationReason[],
  o: { commits?: boolean } = {},
): Verdict {
  return v(kind, 'hard', { reasons, commits: o.commits ?? false })
}

function readVerdict(t: Tok[]): Verdict {
  // INTO anywhere in a read statement: OUTFILE / DUMPFILE write files, a variable target is not a pure read
  for (let i = 0; i < t.length; i++) {
    if (word(t, i) !== 'INTO') continue
    const n = word(t, i + 1)
    if (n === 'OUTFILE' || n === 'DUMPFILE') return hard('selectInto', ['into-outfile'])
    return v('selectInto', 'none')
  }
  if (hasSeq(t, 'FOR', 'UPDATE') || hasSeq(t, 'FOR', 'SHARE') || hasSeq(t, 'LOCK', 'IN', 'SHARE')) {
    return v('select', 'soft')
  }
  return v('select', 'none', { safe: true })
}

type DmlKind = 'insert' | 'replace' | 'update' | 'delete'

function dmlVerdict(kind: DmlKind, text: string, t: Tok[], ctx: ClassifyContext): Verdict {
  const r = runParse(text, ctx)
  if (!r.ok) return hard(kind, [unparsedReason(r, ctx)])
  const f = r.facts
  if (f.family !== kind) return hard(kind, ['unparsed'])
  const tables = f.tables
  if (kind === 'insert') return v('insert', 'none', { tables })
  if (kind === 'replace') return v('replace', 'soft', { tables })
  const d = f.dml
  if (!d) return hard(kind, ['unparsed'])
  // the parser and the lexer must agree that a WHERE exists
  if (d.hasWhere && !hasWord(t, 'WHERE')) return hard(kind, ['unparsed'])
  if (!d.hasWhere)
    return v(kind, 'hard', { reasons: [d.hasLimit ? 'limit-only' : 'no-where'], tables })
  if (d.whereNonRestricting) return v(kind, 'hard', { reasons: ['constant-where'], tables })
  return v(kind, 'none', { tables })
}

/** Index of the main verb after a WITH clause, or -1. */
function withMain(t: Tok[], li: number): number {
  let i = li + 1
  if (word(t, i) === 'RECURSIVE') i++
  for (;;) {
    const x = t[i]
    if (x === undefined || (x.type !== 'word' && x.type !== 'quotedIdent')) return -1
    i++
    if (isOp(t, i, '(')) {
      i = skipGroup(t, i)
      if (i < 0) return -1
    }
    if (word(t, i) !== 'AS') return -1
    i++
    if (!isOp(t, i, '(')) return -1
    i = skipGroup(t, i)
    if (i < 0) return -1
    if (isOp(t, i, ',')) {
      i++
      continue
    }
    return i
  }
}

/** The identifier at `t[i]` without its quotes, or undefined when it is not a plain name. */
function identAt(t: Tok[], i: number): string | undefined {
  const x = t[i]
  if (x === undefined) return undefined
  if (x.type === 'word') return x.text
  if (x.type === 'quotedIdent' && x.text.length >= 3) {
    const q = x.text[0]!
    if (x.text[x.text.length - 1] !== q) return undefined
    return x.text
      .slice(1, -1)
      .split(q + q)
      .join(q)
  }
  return undefined
}

/** Name after `DATABASE|SCHEMA [IF [NOT] EXISTS]` starting at `from` (the object word). */
function databaseNameAfter(t: Tok[], from: number): string[] {
  let i = from + 1
  if (word(t, i) === 'IF') i += word(t, i + 1) === 'NOT' ? 3 : 2
  const name = identAt(t, i)
  return name !== undefined ? [name] : []
}

function createVerdict(text: string, t: Tok[], li: number, ctx: ClassifyContext): Verdict {
  let obj = ''
  let objIndex = -1
  for (let i = li + 1; i < Math.min(t.length, li + 16); i++) {
    const w = word(t, i)
    if (CREATE_OBJECTS.has(w)) {
      obj = w
      objIndex = i
      break
    }
  }
  if (ACCOUNT_OBJECTS.has(obj)) return hard('account', ['account'], { commits: true })
  const orReplace = hasSeq(t, 'OR', 'REPLACE')
  const temporary = word(t, li + 1) === 'TEMPORARY' || hasSeq(t, 'TEMPORARY', 'TABLE')
  const commits = !(temporary && obj === 'TABLE')
  const r = runParse(text, ctx)
  if (!r.ok) {
    return v('createObject', 'hard', { reasons: [unparsedReason(r, ctx)], commits })
  }
  if (!r.facts.statement.startsWith('Create')) {
    return v('createObject', 'hard', { reasons: ['unparsed'], commits })
  }
  const databases = obj === 'DATABASE' || obj === 'SCHEMA' ? databaseNameAfter(t, objIndex) : []
  return v('createObject', orReplace ? 'soft' : 'none', {
    commits,
    tables: r.facts.tables,
    databases,
  })
}

function alterVerdict(text: string, t: Tok[], li: number, ctx: ClassifyContext): Verdict {
  let obj = ''
  for (let i = li + 1; i < Math.min(t.length, li + 12); i++) {
    const w = word(t, i)
    if (ALTER_OBJECTS.has(w)) {
      obj = w
      break
    }
  }
  if (ACCOUNT_OBJECTS.has(obj)) return hard('account', ['account'], { commits: true })
  if (obj === 'TABLE') {
    for (let i = li + 1; i < t.length; i++) {
      if (ALTER_DROPS.has(word(t, i))) return hard('alterObject', ['alter-drop'], { commits: true })
    }
  }
  const r = runParse(text, ctx)
  if (!r.ok) return hard('alterObject', [unparsedReason(r, ctx)], { commits: true })
  const f = r.facts
  if (obj === 'TABLE') {
    if (f.family !== 'alterTable' || !f.alter)
      return hard('alterObject', ['unparsed'], { commits: true })
    if (f.alter.drops)
      return v('alterObject', 'hard', { reasons: ['alter-drop'], commits: true, tables: f.tables })
    if (f.alter.narrowing)
      return v('alterObject', 'hard', { reasons: ['narrowing'], commits: true, tables: f.tables })
    return v('alterObject', 'soft', { commits: true, tables: f.tables })
  }
  if (!f.statement.startsWith('Alter')) return hard('alterObject', ['unparsed'], { commits: true })
  return v('alterObject', 'soft', { commits: true })
}

function setVerdict(t: Tok[], li: number): Verdict {
  const second = word(t, li + 1)
  if (second === 'PASSWORD' || second === 'ROLE' || seq(t, li + 1, 'DEFAULT', 'ROLE')) {
    return hard('account', ['account'])
  }
  if (second === 'STATEMENT') return hard('setSession', ['unparsed'])
  if (t.some((x) => x.type === 'quotedIdent')) return hard('setSession', ['unparsed'])
  for (const x of t) {
    if (
      x.type === 'word' &&
      (x.upper === 'GLOBAL' || x.upper === 'PERSIST' || x.upper === 'PERSIST_ONLY')
    ) {
      return hard('setGlobal', ['global-set'])
    }
    if (x.type === 'variable' && /^@@(GLOBAL|PERSIST|PERSIST_ONLY)(\.|$)/.test(x.upper)) {
      return hard('setGlobal', ['global-set'])
    }
  }
  let safe = true
  let commits = false
  for (let i = li + 1; i < t.length; i++) {
    const x = t[i] as Tok
    if (x.type !== 'word' && x.type !== 'variable') continue
    if (/(^|[@.])(TX_READ_ONLY|TRANSACTION_READ_ONLY)$/.test(x.upper)) safe = false
    if (/(^|[@.])AUTOCOMMIT$/.test(x.upper)) commits = true
    if (x.upper === 'READ' && word(t, i + 1) === 'WRITE') safe = false
  }
  return v('setSession', 'none', { safe, commits })
}

function explainVerdict(text: string, t: Tok[], li: number, ctx: ClassifyContext): Verdict {
  let i = li + 1
  let analyze = word(t, li) === 'ANALYZE'
  for (;;) {
    const w = word(t, i)
    if (w === 'ANALYZE' || w === 'ANALYSE') {
      analyze = true
      i++
    } else if (w === 'EXTENDED' || w === 'PARTITIONS') i++
    else if (w === 'FORMAT' && isOp(t, i + 1, '=')) i += 3
    else if (seq(t, i, 'FOR', 'CONNECTION')) return v('explain', 'none', { safe: true })
    else break
  }
  const x = t[i]
  const innerWord = isOp(t, i, '(') ? 'SELECT' : word(t, i)
  if (x === undefined || !STMT_STARTERS.has(innerWord)) {
    // EXPLAIN tbl [col]: a DESCRIBE
    return analyze ? hard('explain', ['unparsed']) : v('describe', 'none', { safe: true })
  }
  if (!analyze) return v('explain', 'none', { safe: true })
  // EXPLAIN ANALYZE executes the statement: it takes the class of the statement
  if (x.fromExec) return hard('explain', ['unparsed'])
  const inner = classifyTokens(text.slice(x.start), t.slice(i), ctx)
  return { ...inner, kind: 'explain' }
}

const PREFIX_UNESCAPE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  b: '\b',
  Z: '\x1a',
}

function stringValue(raw: string, noBackslash: boolean): string {
  const q = raw[0] as string
  let body = raw.slice(1, raw.length - 1)
  body = body.split(q + q).join(q)
  if (noBackslash) return body
  return body.replace(/\\([\s\S])/g, (_m, c: string) => PREFIX_UNESCAPE[c] ?? c)
}

function prepareVerdict(
  t: Tok[],
  li: number,
  ctx: ClassifyContext,
  strIdx: number,
  extra: number,
): Verdict {
  const s = t[strIdx]
  const depth = ctx.depth ?? 0
  if (
    s === undefined ||
    s.type !== 'string' ||
    t.length !== strIdx + 1 + extra ||
    depth >= MAX_DEPTH
  ) {
    return hard('prepare', ['unparsed'])
  }
  const inner = stringValue(s.text, ctx.lex?.noBackslashEscapes === true)
  const parts = splitStatements(inner, { ...ctx.lex })
  if (parts.errors.length > 0 || parts.statements.length !== 1) return hard('prepare', ['unparsed'])
  const st = parts.statements[0] as SqlStatementText
  const c = classifyStatement(st, { ...ctx, depth: depth + 1 })
  const cls: StatementClass = RANK[c.class] > RANK.soft ? c.class : 'soft'
  return v('prepare', cls, { reasons: c.reasons, commits: c.commitsImplicitly, tables: c.tables })
}

/** Analyse the significant tokens of one statement. `text` is the statement text the tokens came from. */
function classifyTokens(text: string, t: Tok[], ctx: ClassifyContext): Verdict {
  if (t.length === 0) return v('unknown', 'none', { safe: true })
  let li = 0
  while (isOp(t, li, '(')) li++
  const lw = word(t, li)
  if (lw === '') return hard('unknown', ['unknown-keyword', 'unparsed'])
  const isMy = ctx.product === 'mysql'

  switch (lw) {
    case 'SELECT':
    case 'VALUES':
      return readVerdict(t)
    case 'TABLE':
      return isMy ? readVerdict(t) : hard('unknown', ['unknown-keyword', 'unparsed'])
    case 'WITH': {
      const m = withMain(t, li)
      if (m < 0) return hard('unknown', ['unparsed'])
      if (isOp(t, m, '(')) return readVerdict(t)
      const mw = word(t, m)
      if (mw === 'SELECT' || mw === 'TABLE' || mw === 'VALUES') return readVerdict(t)
      if (mw === 'UPDATE' || mw === 'DELETE' || mw === 'INSERT' || mw === 'REPLACE') {
        return dmlVerdict(mw.toLowerCase() as DmlKind, text, t, ctx)
      }
      return hard('unknown', ['unparsed'])
    }
    case 'INSERT':
    case 'REPLACE':
    case 'UPDATE':
    case 'DELETE':
      return dmlVerdict(lw.toLowerCase() as DmlKind, text, t, ctx)
    case 'SHOW':
      return v('show', 'none', { safe: true })
    case 'DESCRIBE':
    case 'DESC':
    case 'EXPLAIN':
      return explainVerdict(text, t, li, ctx)
    case 'ANALYZE': {
      let i = li + 1
      if (word(t, i) === 'FORMAT' && isOp(t, i + 1, '=')) i += 3
      if (!isMy && (STMT_STARTERS.has(word(t, i)) || isOp(t, i, '('))) {
        return explainVerdict(text, t, li, ctx)
      }
      const n = word(t, li + 1)
      if (n === 'TABLE' || n === 'NO_WRITE_TO_BINLOG' || n === 'LOCAL') {
        return v('admin', 'soft', { commits: true })
      }
      return hard('unknown', ['unknown-keyword', 'unparsed'])
    }
    case 'OPTIMIZE':
    case 'REPAIR':
    case 'CHECK':
    case 'CHECKSUM': {
      const n = word(t, li + 1)
      if (n === 'TABLE' || n === 'TABLES' || n === 'NO_WRITE_TO_BINLOG' || n === 'LOCAL') {
        return v('admin', 'soft', { commits: lw !== 'CHECKSUM' })
      }
      return hard('unknown', ['unknown-keyword', 'unparsed'])
    }
    case 'USE':
      return t.length === 2 && (t[1]?.type === 'word' || t[1]?.type === 'quotedIdent')
        ? v('use', 'none', { safe: true })
        : hard('use', ['unparsed'])
    case 'SET':
      return setVerdict(t, li)
    case 'START':
      if (word(t, li + 1) === 'TRANSACTION') return txVerdict(t, li + 2, true)
      return hard('admin', ['admin'])
    case 'BEGIN':
      return txVerdict(t, li + 1, true)
    case 'COMMIT':
    case 'ROLLBACK':
      return txVerdict(t, li + 1, false)
    case 'SAVEPOINT':
      return t.length === 2
        ? v('txControl', 'none', { safe: true })
        : hard('txControl', ['unparsed'])
    case 'RELEASE':
      return word(t, li + 1) === 'SAVEPOINT' && t.length === 3
        ? v('txControl', 'none', { safe: true })
        : hard('txControl', ['unparsed'])
    case 'CREATE':
      return createVerdict(text, t, li, ctx)
    case 'ALTER':
      return alterVerdict(text, t, li, ctx)
    case 'DROP': {
      if (word(t, li + 1) === 'PREPARE') return v('prepare', 'none')
      const reasons: ClassificationReason[] = ['drop']
      for (let i = li + 1; i < Math.min(t.length, li + 6); i++) {
        if (ACCOUNT_OBJECTS.has(word(t, i))) {
          reasons.push('account')
          break
        }
      }
      const temp = word(t, li + 1) === 'TEMPORARY'
      const r = runParse(text, ctx)
      const isDb = word(t, li + 1) === 'DATABASE' || word(t, li + 1) === 'SCHEMA'
      return v('dropObject', 'hard', {
        reasons,
        commits: !temp,
        // DROP DATABASE: the parser reports the name as a table; it is a database.
        tables: !isDb && r.ok && r.facts.family === 'drop' ? r.facts.tables : undefined,
        databases: isDb ? databaseNameAfter(t, li + 1) : undefined,
      })
    }
    case 'TRUNCATE': {
      const r = runParse(text, ctx)
      return v('truncate', 'hard', {
        reasons: ['truncate'],
        commits: true,
        tables: r.ok && r.facts.family === 'truncate' ? r.facts.tables : undefined,
      })
    }
    case 'RENAME': {
      if (ACCOUNT_OBJECTS.has(word(t, li + 1)))
        return hard('account', ['account'], { commits: true })
      const r = runParse(text, ctx)
      return v('renameObject', 'soft', {
        commits: true,
        tables: r.ok && r.facts.family === 'renameTable' ? r.facts.tables : undefined,
      })
    }
    case 'CALL': {
      const r = runParse(text, ctx)
      if (!r.ok) return hard('call', [unparsedReason(r, ctx)])
      if (r.facts.family !== 'call') return hard('call', ['unparsed'])
      return v('call', 'soft')
    }
    case 'LOCK': {
      const n = word(t, li + 1)
      if (n === 'TABLES' || n === 'TABLE' || n === 'INSTANCE')
        return v('lock', 'soft', { commits: true })
      return hard('lock', ['unparsed'])
    }
    case 'UNLOCK': {
      const n = word(t, li + 1)
      if (n === 'TABLES' || n === 'TABLE' || n === 'INSTANCE')
        return v('lock', 'soft', { commits: true })
      return hard('lock', ['unparsed'])
    }
    case 'KILL':
      return v('kill', 'soft')
    case 'FLUSH': {
      const first = word(t, li + 1)
      const denied = t.some((x, i) => i > li && x.type === 'word' && FLUSH_DENY.has(x.upper))
      if (FLUSH_SOFT_FIRST.has(first) && !denied) return v('admin', 'soft', { commits: true })
      return hard('admin', ['admin'], { commits: true })
    }
    case 'LOAD': {
      const n = word(t, li + 1)
      if (n === 'DATA' || n === 'XML') return hard('loadData', ['load-data'])
      return hard('admin', ['admin'])
    }
    case 'GRANT':
    case 'REVOKE':
      return hard('account', ['account'], { commits: true })
    case 'PREPARE':
      if (t.length >= 4 && word(t, li + 2) === 'FROM') return prepareVerdict(t, li, ctx, li + 3, 0)
      return hard('prepare', ['unparsed'])
    case 'EXECUTE': {
      if (!isMy && word(t, li + 1) === 'IMMEDIATE') {
        const extra = word(t, li + 3) === 'USING' ? t.length - li - 3 : 0
        return prepareVerdict(t, li, ctx, li + 2, extra)
      }
      return v('prepare', 'soft')
    }
    case 'DEALLOCATE':
      return v('prepare', 'none')
    default:
      if (ADMIN_COMMON.has(lw) || (isMy ? ADMIN_MYSQL : ADMIN_MARIADB).has(lw)) {
        return hard('admin', ['admin'])
      }
      return hard('unknown', ['unknown-keyword', 'unparsed'])
  }
}

function txVerdict(t: Tok[], from: number, commits: boolean): Verdict {
  let safe = true
  for (let i = from; i < t.length; i++) {
    const x = t[i] as Tok
    if (x.type === 'word' && TX_WORDS.has(x.upper)) {
      if (x.upper === 'READ' && word(t, i + 1) === 'WRITE') safe = false
      continue
    }
    if ((x.type === 'word' || x.type === 'quotedIdent') && word(t, from - 1) === 'ROLLBACK')
      continue
    if (isOp(t, i, ',')) continue
    return hard('txControl', ['unparsed'])
  }
  return v('txControl', 'none', { safe, commits })
}

// ---- entry points -----------------------------------------------------------------------------------

function raise(c: Verdict, extra: ClassificationReason): Verdict {
  const reasons = c.reasons.includes(extra) ? c.reasons : [...c.reasons, extra]
  return { ...c, class: 'hard', readOnlySafe: false, reasons }
}

export function classifyStatement(stmt: SqlStatementText, ctx: ClassifyContext): Classification {
  const ct = codeTokens(stmt.text, { ...ctx.lex })
  let c = classifyTokens(stmt.text, ct.tokens, ctx)
  // stray delimiters (custom DELIMITER), disagreeing views of an executable comment, lexical errors:
  // never relax, ask more often
  if (ct.tokens.some((x) => x.type === 'op' && x.text === ';')) c = raise(c, 'unparsed')
  if (ct.execNested || ct.errors.length > 0) c = raise(c, 'unparsed')
  return { ...c, readOnlySafe: c.readOnlySafe && c.class === 'none' }
}

/** Classify a split statement list. After `budgetMs` (default 2 s) the rest is classified by the lexer only. */
export function classifyBatch(
  stmts: SqlStatementText[],
  ctx: ClassifyContext & { budgetMs?: number },
): ClassifiedStatement[] {
  const t0 = performance.now()
  const budget = ctx.budgetMs ?? BATCH_BUDGET_MS
  const out: ClassifiedStatement[] = []
  for (const s of stmts) {
    const spent = performance.now() - t0 > budget
    const c = classifyStatement(s, spent ? { ...ctx, budgetSpent: true } : ctx)
    out.push({ ...s, classification: c })
  }
  return out
}

export type { ParsedFacts }
