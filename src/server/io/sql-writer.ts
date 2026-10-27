/**
 * SQL dump writer of module `io` (FR-IO-004/005, spec 5.3). A pure transform from typed events to text; it never
 * builds object definitions, it emits the text the server returned for `SHOW CREATE ...` (with small, line-based
 * edits for the options that need them). Order of events is the caller's job (`orderByDependency` helps).
 */
import { quoteIdent as q } from '../db/identifiers'
import type { ColumnInfo, IoCell, SqlExportOptions } from './types'
import { sqlLiteral } from './values'

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event'

export type SqlEvent =
  | { type: 'header'; dbloomVersion: string; serverVersion: string; generatedAt: Date }
  | { type: 'database'; name: string; createText?: string }
  | {
      type: 'object'
      kind: ObjectKind
      database: string
      name: string
      /** Text returned by SHOW CREATE (the `Create Table`, `Create View`, ... column). */
      createText: string
      /** Referenced tables whose foreign keys must move to ALTER statements after all data (cycle members). */
      deferForeignKeysTo?: string[]
    }
  | { type: 'row-batch'; database: string; table: string; columns: ColumnInfo[]; rows: IoCell[][] }
  | { type: 'table-end' }
  | { type: 'footer' }

// ---- Small helpers ------------------------------------------------------------------------------------------

/** One-line, control-free text for use inside `--` comments (names and versions come from outside). */
export function commentSafe(s: string): string {
  return s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim()
}

function commentLines(text: string): string {
  return (
    text
      .split(/\r\n|\r|\n|\p{Zl}|\p{Zp}/u)
      .map((l) => '-- ' + l.replace(/\p{Cc}/gu, ' '))
      .join('\n') + '\n'
  )
}

function stamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

const KIND_SQL: Record<ObjectKind, string> = {
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  event: 'EVENT',
}

function delimiterFor(text: string): string {
  let d = '$$'
  while (text.includes(d)) d += '$'
  return d
}

const DEFINER = '(?:DEFINER\\s*=\\s*(?:`(?:[^`]|``)*`|[^\\s@]+)@(?:`(?:[^`]|``)*`|\\S+)\\s+)?'
const IF_NOT_EXISTS_AFTER: Partial<Record<ObjectKind, RegExp>> = {
  trigger: new RegExp(`^(CREATE\\s+${DEFINER}TRIGGER\\s+)(?!IF NOT EXISTS)`, 'i'),
  procedure: new RegExp(`^(CREATE\\s+${DEFINER}PROCEDURE\\s+)(?!IF NOT EXISTS)`, 'i'),
  function: new RegExp(`^(CREATE\\s+${DEFINER}(?:AGGREGATE\\s+)?FUNCTION\\s+)(?!IF NOT EXISTS)`, 'i'),
  event: new RegExp(`^(CREATE\\s+${DEFINER}EVENT\\s+)(?!IF NOT EXISTS)`, 'i'),
}

/** With "IF NOT EXISTS" a dump imports twice (DATA-ISS-106): views are replaced, programs get the clause (both products accept it). */
export function conditionalCreate(kind: ObjectKind, text: string): string {
  if (kind === 'view') return text.replace(/^CREATE\s+(?!OR REPLACE)/i, 'CREATE OR REPLACE ')
  const re = IF_NOT_EXISTS_AFTER[kind]
  return re ? text.replace(re, '$1IF NOT EXISTS ') : text
}

// ---- SHOW CREATE TABLE edits (line based: the server writes one definition per line) -----------------------------

export type TableParts = {
  head: string
  /** Definition lines without their trailing comma. */
  defs: string[]
  foot: string
}

export function splitCreateTable(text: string): TableParts | null {
  const lines = text.split('\n')
  if (lines.length < 3) return null
  const head = lines[0] as string
  const foot = lines[lines.length - 1] as string
  if (!/^CREATE\b.*\($/i.test(head) || !foot.startsWith(')')) return null
  const defs = lines.slice(1, -1).map((l) => l.replace(/,$/, ''))
  if (defs.some((d) => !d.startsWith('  '))) return null
  return { head, defs, foot }
}

const joinParts = (p: TableParts) => [p.head, ...p.defs.map((d, i) => (i < p.defs.length - 1 ? d + ',' : d)), p.foot].join('\n')

const PRIMARY = /^ {2}PRIMARY KEY /
const OTHER_KEY = /^ {2}(UNIQUE KEY|FULLTEXT KEY|SPATIAL KEY|KEY) /
const FOREIGN = /^ {2}CONSTRAINT `(?:[^`]|``)+` FOREIGN KEY /
const FK_TARGET = /REFERENCES (?:`(?:[^`]|``)+`\.)?`((?:[^`]|``)+)`/

/** Referenced table of a foreign-key definition line (backquote doubling undone), or null. */
export function foreignKeyTarget(def: string): string | null {
  if (!FOREIGN.test(def)) return null
  const m = FK_TARGET.exec(def)
  return m ? (m[1] as string).replaceAll('``', '`') : null
}

/** Referenced tables of a CREATE TABLE text, for dependency ordering when the catalog is not at hand. */
export function foreignKeyTargets(createText: string): string[] {
  const parts = splitCreateTable(createText)
  if (!parts) return []
  return [...new Set(parts.defs.map(foreignKeyTarget).filter((t): t is string => t !== null))]
}

// ---- Dependency order -----------------------------------------------------------------------------------------

export type DependencyNode = { name: string; deps: string[] }
export type DependencyOrder = {
  order: string[]
  /** For nodes emitted before something they depend on (cycle members): the dependencies that come later. */
  deferred: Record<string, string[]>
  /** Strongly connected groups of more than one node (self references are not cycles), names sorted. */
  cycles: string[][]
}

/**
 * Dependencies first, ties and cycles resolved by name so identical schemas give identical order.
 * Unknown dependencies and self references are ignored. In a cycle the smallest remaining name goes first and
 * its dependencies that come later are reported in `deferred`.
 */
export function orderByDependency(nodes: DependencyNode[]): DependencyOrder {
  const names = new Set(nodes.map((n) => n.name))
  const deps = new Map<string, Set<string>>()
  for (const n of nodes) deps.set(n.name, new Set(n.deps.filter((d) => d !== n.name && names.has(d))))
  const remaining = new Set(names)
  const cycles = stronglyConnected(nodes.map((x) => x.name), deps)
  const cyclic = new Set(cycles.flat())
  const order: string[] = []
  const deferred: Record<string, string[]> = {}
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  while (remaining.size > 0) {
    const ready = [...remaining].filter((n) => [...(deps.get(n) as Set<string>)].every((d) => !remaining.has(d))).sort(byName)
    if (ready.length > 0) {
      const n = ready[0] as string
      order.push(n)
      remaining.delete(n)
      continue
    }
    const stuck = [...remaining].filter((x) => cyclic.has(x)).sort(byName)
    const n = (stuck[0] ?? [...remaining].sort(byName)[0]) as string
    deferred[n] = [...(deps.get(n) as Set<string>)].filter((d) => remaining.has(d)).sort(byName)
    order.push(n)
    remaining.delete(n)
  }
  return { order, deferred, cycles }
}

function stronglyConnected(names: string[], deps: Map<string, Set<string>>): string[][] {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  const visit = (v: string) => {
    idx.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of [...(deps.get(v) as Set<string>)].sort()) {
      if (!idx.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number))
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number))
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop() as string
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length > 1) out.push(comp.sort())
    }
  }
  for (const n of [...names].sort()) if (!idx.has(n)) visit(n)
  return out.sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1))
}

// ---- Writer ---------------------------------------------------------------------------------------------------

export class SqlWriter {
  private o: SqlExportOptions
  private db: string | null = null
  private alters: string[] = []
  private pending: { table: string; head: string; tuples: string[]; bytes: number } | null = null
  private inTableData: string | null = null

  constructor(options: SqlExportOptions) {
    this.o = options
  }

  private get wantsStructure() {
    return this.o.content !== 'data'
  }
  private get wantsData() {
    return this.o.content !== 'structure'
  }

  write(ev: SqlEvent): string {
    switch (ev.type) {
      case 'header':
        return this.header(ev)
      case 'database':
        return this.database(ev)
      case 'object':
        return this.object(ev)
      case 'row-batch':
        return this.rows(ev)
      case 'table-end':
        return this.tableEnd()
      case 'footer':
        return this.footer()
    }
  }

  private header(ev: Extract<SqlEvent, { type: 'header' }>): string {
    let s = ''
    if (this.o.comments) {
      s += `-- DBLoom SQL dump ${commentSafe(ev.dbloomVersion)}\n`
      s += `-- Server version: ${commentSafe(ev.serverVersion)}\n`
      s += `-- Generated: ${stamp(ev.generatedAt)}\n`
      if (this.o.customComment !== '') s += '--\n' + commentLines(this.o.customComment)
      s += '\n'
    }
    s +=
      'SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT, @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS, ' +
      '@OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION, @OLD_TIME_ZONE=@@TIME_ZONE, @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, ' +
      '@OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, @OLD_SQL_MODE=@@SQL_MODE;\n'
    s += 'SET NAMES utf8mb4;\n'
    s += "SET time_zone = '+00:00';\n"
    if (this.o.foreignKeyChecksOff) s += 'SET unique_checks = 0;\nSET foreign_key_checks = 0;\n'
    s += "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO';\n\n"
    return s
  }

  private database(ev: Extract<SqlEvent, { type: 'database' }>): string {
    this.db = ev.name
    if (!this.o.createDatabase) return ''
    let s = ''
    if (this.o.comments) s += `-- Database ${commentSafe(ev.name)}\n`
    if (this.o.dropDatabase) s += `DROP DATABASE IF EXISTS ${q(ev.name)};\n`
    let create = ev.createText ?? `CREATE DATABASE ${q(ev.name)}`
    if (this.o.ifNotExists && !/^CREATE DATABASE IF NOT EXISTS/i.test(create) && !/IF NOT EXISTS/i.test(create.slice(0, 60)))
      create = create.replace(/^CREATE DATABASE /i, 'CREATE DATABASE IF NOT EXISTS ')
    s += create.replace(/;\s*$/, '') + ';\n'
    s += `USE ${q(ev.name)};\n\n`
    return s
  }

  private wanted(kind: ObjectKind): boolean {
    switch (kind) {
      case 'table':
        return true
      case 'view':
        return this.o.views
      case 'procedure':
      case 'function':
        return this.o.routines
      case 'trigger':
        return this.o.triggers
      case 'event':
        return this.o.events
    }
  }

  private object(ev: Extract<SqlEvent, { type: 'object' }>): string {
    if (!this.wantsStructure || !this.wanted(ev.kind)) return ''
    let s = this.flush()
    s += this.endTableData()
    if (this.o.comments) s += `-- ${ev.kind === 'table' ? 'Table structure for table' : `${KIND_SQL[ev.kind]}`} ${commentSafe(ev.name)}\n`
    if (this.o.dropObjects) s += `DROP ${KIND_SQL[ev.kind]} IF EXISTS ${q(ev.name)};\n`
    let text = ev.createText.replace(/;\s*$/, '')
    if (ev.kind === 'table') text = this.tableText(ev, text)
    else if (this.o.ifNotExists) text = conditionalCreate(ev.kind, text)
    if (ev.kind === 'table' || ev.kind === 'view') s += text + ';\n\n'
    else {
      const d = delimiterFor(text)
      s += `DELIMITER ${d}\n${text}${d}\nDELIMITER ;\n\n`
    }
    return s
  }

  private tableText(ev: Extract<SqlEvent, { type: 'object' }>, text: string): string {
    if (this.o.ifNotExists) text = text.replace(/^CREATE TABLE (?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
    const parts = splitCreateTable(text)
    if (!parts) return text
    const defer = new Set(ev.deferForeignKeysTo ?? [])
    const hasAuto = parts.defs.some((d) => /\bAUTO_INCREMENT\b/i.test(d) && !/^ {2}(PRIMARY|UNIQUE|FULLTEXT|SPATIAL|KEY|CONSTRAINT)/.test(d))
    const keepKeys = this.o.keysInCreateTable || hasAuto
    const kept: string[] = []
    const adds: string[] = []
    for (const d of parts.defs) {
      const target = foreignKeyTarget(d)
      if (target !== null && defer.has(target)) {
        adds.push(d.trim().replace(/^CONSTRAINT/, 'ADD CONSTRAINT'))
        continue
      }
      if (!keepKeys && (PRIMARY.test(d) || OTHER_KEY.test(d))) {
        adds.push('ADD ' + d.trim())
        continue
      }
      kept.push(d)
    }
    if (adds.length > 0) this.alters.push(`ALTER TABLE ${q(ev.name)}\n  ${adds.join(',\n  ')};\n`)
    let foot = parts.foot
    if (!this.o.autoIncrementValue) foot = foot.replace(/ AUTO_INCREMENT=\d+/, '')
    return joinParts({ head: parts.head, defs: kept, foot })
  }

  private rows(ev: Extract<SqlEvent, { type: 'row-batch' }>): string {
    if (!this.wantsData) return ''
    let s = ''
    if (this.pending && this.pending.table !== ev.table) s += this.flush()
    if (this.inTableData !== ev.table) {
      s += this.endTableData()
      this.inTableData = ev.table
      if (this.o.comments) s += `-- Dumping data for table ${commentSafe(ev.table)}\n`
      if (this.o.transaction) s += 'START TRANSACTION;\n'
    }
    const cols = ev.columns.filter((c) => !c.generated)
    if (cols.length === 0) return s
    const keep = ev.columns.map((c) => !c.generated)
    const verb = this.o.statement === 'replace' ? 'REPLACE INTO' : this.o.statement === 'insertIgnore' ? 'INSERT IGNORE INTO' : 'INSERT INTO'
    const head = `${verb} ${q(ev.table)} (${cols.map((c) => q(c.name)).join(',')}) VALUES `
    for (const row of ev.rows) {
      const tuple = '(' + ev.columns.flatMap((c, i) => (keep[i] ? [sqlLiteral(row[i] ?? null, c)] : [])).join(',') + ')'
      s += this.addTuple(ev.table, head, tuple)
    }
    return s
  }

  private addTuple(table: string, head: string, tuple: string): string {
    const size = Buffer.byteLength(tuple)
    if (!this.o.extendedInserts) return head + tuple + ';\n'
    let out = ''
    const p = this.pending
    if (p && p.bytes + size + 1 > this.o.extendedInsertBytes) out += this.flush()
    if (!this.pending) this.pending = { table, head, tuples: [], bytes: Buffer.byteLength(head) + 1 }
    this.pending.tuples.push(tuple)
    this.pending.bytes += size + 1
    return out
  }

  private flush(): string {
    const p = this.pending
    this.pending = null
    if (!p || p.tuples.length === 0) return ''
    return p.head + p.tuples.join(',') + ';\n'
  }

  private endTableData(): string {
    if (this.inTableData === null) return ''
    this.inTableData = null
    return (this.o.transaction ? 'COMMIT;\n' : '') + '\n'
  }

  private tableEnd(): string {
    return this.flush() + this.endTableData()
  }

  private footer(): string {
    let s = this.flush() + this.endTableData()
    if (this.alters.length > 0) {
      if (this.o.comments) s += '-- Foreign keys of tables in a dependency cycle, added after all data\n'
      s += this.alters.join('\n') + '\n'
      this.alters = []
    }
    s +=
      'SET sql_mode = @OLD_SQL_MODE;\nSET foreign_key_checks = @OLD_FOREIGN_KEY_CHECKS;\nSET unique_checks = @OLD_UNIQUE_CHECKS;\n' +
      'SET time_zone = @OLD_TIME_ZONE;\nSET character_set_client = @OLD_CHARACTER_SET_CLIENT;\n' +
      'SET character_set_results = @OLD_CHARACTER_SET_RESULTS;\nSET collation_connection = @OLD_COLLATION_CONNECTION;\n'
    return s
  }
}

/** Convenience: text chunks for a whole event sequence. */
export async function* writeSql(options: SqlExportOptions, events: AsyncIterable<SqlEvent> | Iterable<SqlEvent>): AsyncGenerator<string> {
  const w = new SqlWriter(options)
  for await (const ev of events) {
    const t = w.write(ev)
    if (t !== '') yield t
  }
}
