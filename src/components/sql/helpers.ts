/**
 * Pure helpers of the SQL tab (no React, no server imports), unit-tested in tests/sql-ui.test.ts.
 *
 * The browser only needs a light scan of the text: "statement at the cursor", a gate for read-only
 * connections, "single line" and error positions. The server always splits and classifies again from the
 * text (FR-SQL-001); nothing computed here is ever sent as a statement or a class.
 */
import type { QueryClient } from '@tanstack/react-query'
import { keys } from '~/components/structure/invalidate'
import type { Cell } from '~/server/db/rows'
import type { SqlChange } from '~/server/sql/types'

// ---- Run ids ---------------------------------------------------------------------------------------

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

/** 128-bit random id in the alphabet the server accepts (A-Za-z0-9_-, 8 to 64 chars), 22 characters. */
export function newRunId(random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(22)
  let out = ''
  for (const b of bytes) out += ID_ALPHABET[b & 63]
  return out
}

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

// ---- Light scanner ---------------------------------------------------------------------------------

export type LocalStatement = {
  /** Text as typed, without the delimiter. */
  text: string
  /** Offsets into the original text; `end` is exclusive and excludes the delimiter. */
  start: number
  end: number
  /** Upper-case first keyword after comments ('' when only comments or blanks). */
  firstKeyword: string
}

export type LocalSplit = { statements: LocalStatement[]; unterminated?: { at: number } }

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** Dash-dash starts a comment only when followed by whitespace or the end (MySQL and MariaDB). */
const isDashComment = (text: string, i: number) =>
  text[i] === '-' && text[i + 1] === '-' && (i + 2 >= text.length || isSpace(text[i + 2]))

const isExecutableComment = (text: string, i: number) => /^\/\*M?!/.test(text.slice(i, i + 4))

/**
 * Splits on the semicolon (or the delimiter set by a DELIMITER line) outside quotes and comments.
 * Executable comments stay inside their statement. Backslash escapes are honoured in quoted strings.
 */
export function splitLocal(text: string): LocalSplit {
  const statements: LocalStatement[] = []
  let delimiter = ';'
  let from = 0
  let i = 0
  let started = false
  let unterminated: { at: number } | undefined

  const push = (end: number) => {
    const raw = text.slice(from, end)
    const lead = raw.length - raw.trimStart().length
    const body = raw.trim()
    if (body !== '') {
      const s = from + lead
      statements.push({
        text: body,
        start: s,
        end: s + body.length,
        firstKeyword: firstKeywordOf(body),
      })
    }
    started = false
  }

  while (i < text.length) {
    const c = text[i] as string
    if (
      !started &&
      (i === 0 || text[i - 1] === '\n') &&
      /^delimiter[ \t]/i.test(text.slice(i, i + 10))
    ) {
      let eol = text.indexOf('\n', i)
      if (eol === -1) eol = text.length
      const arg = text
        .slice(i + 9, eol)
        .replace(/\r$/, '')
        .trim()
        .split(/\s+/)[0]
      if (arg) delimiter = arg
      i = eol + 1
      from = i
      continue
    }
    if (text.startsWith(delimiter, i)) {
      push(i)
      i += delimiter.length
      from = i
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const open = i
      i++
      let closed = false
      while (i < text.length) {
        const d = text[i]
        if (d === '\\' && c !== '`') {
          i += 2
          continue
        }
        if (d === c) {
          if (text[i + 1] === c) {
            i += 2
            continue
          }
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) {
        unterminated ??= { at: open }
        i = text.length
      }
      started = true
      continue
    }
    if (c === '#' || isDashComment(text, i)) {
      const eol = text.indexOf('\n', i)
      i = eol === -1 ? text.length : eol + 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const open = i
      const end = text.indexOf('*/', i + 2)
      if (end === -1) {
        unterminated ??= { at: open }
        i = text.length
      } else i = end + 2
      if (isExecutableComment(text, open)) started = true
      continue
    }
    if (!isSpace(c)) started = true
    i++
  }
  push(text.length)
  return { statements, unterminated }
}

/** First keyword after leading blanks, comments and opening parentheses, upper-cased; '' when none. */
export function firstKeywordOf(text: string): string {
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (isSpace(c) || c === '(') i++
    else if (c === '#' || isDashComment(text, i)) {
      const eol = text.indexOf('\n', i)
      i = eol === -1 ? text.length : eol + 1
    } else if (c === '/' && text[i + 1] === '*' && !isExecutableComment(text, i)) {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else break
  }
  const m = /^[A-Za-z_]+/.exec(text.slice(i))
  return m ? m[0].toUpperCase() : ''
}

/**
 * The statement the caret belongs to: the one that contains it (a caret right after its delimiter still
 * counts), else the one before, else the first one after.
 */
export function statementAt(statements: LocalStatement[], pos: number): LocalStatement | undefined {
  let before: LocalStatement | undefined
  for (const s of statements) {
    if (pos >= s.start && pos <= s.end + 1) return s
    if (s.end < pos) before = s
    else return before ?? s
  }
  return before
}

// ---- Gates the server repeats ------------------------------------------------------------------------

const READ_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'USE',
  'SET',
  'TABLE',
  'VALUES',
])

/**
 * Convenience gate for read-only connections: true when some statement of `text` starts with a keyword
 * that is not an allow-listed read. The server decides (FR-SQL-007); this only avoids a pointless call.
 */
export function readOnlyBlocked(text: string): boolean {
  return splitLocal(text).statements.some((s) => !READ_KEYWORDS.has(s.firstKeyword))
}

const IMPLICIT_COMMIT = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'LOCK',
  'UNLOCK',
  'START',
  'BEGIN',
  'GRANT',
  'REVOKE',
  'ANALYZE',
  'OPTIMIZE',
  'REPAIR',
  'FLUSH',
])

/** True when a statement of `text` ends an open transaction by itself (DDL, LOCK TABLES, START ...). */
export function commitsImplicitly(text: string): boolean {
  return splitLocal(text).statements.some(
    (s) =>
      IMPLICIT_COMMIT.has(s.firstKeyword) ||
      (s.firstKeyword === 'SET' &&
        /^\s*set\s+(session\s+|@@(session\.)?)?autocommit\b/i.test(s.text)),
  )
}

export function countStatements(text: string): number {
  return splitLocal(text).statements.length
}

// ---- Single line -----------------------------------------------------------------------------------

/**
 * Puts a text on one line without changing its meaning: line comments become block comments (a dash
 * comment would swallow the rest), runs of blanks outside quotes become one space. Returns the text
 * unchanged when it has an unterminated string or comment.
 */
export function toSingleLine(text: string): string {
  if (splitLocal(text).unterminated) return text
  let out = ''
  let i = 0
  let pendingSpace = false
  const emit = (s: string) => {
    if (pendingSpace && out !== '') out += ' '
    pendingSpace = false
    out += s
  }
  while (i < text.length) {
    const c = text[i] as string
    if (isSpace(c)) {
      pendingSpace = true
      i++
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length) {
        const d = text[j]
        if (d === '\\' && c !== '`') j += 2
        else if (d === c) {
          if (text[j + 1] === c) j += 2
          else {
            j++
            break
          }
        } else j++
      }
      emit(text.slice(i, j))
      i = j
    } else if (c === '#' || isDashComment(text, i)) {
      const eol = text.indexOf('\n', i)
      const end = eol === -1 ? text.length : eol
      const body = text
        .slice(i + (c === '#' ? 1 : 2), end)
        .replace(/\r$/, '')
        .trim()
        .replace(/\*\//g, '* /')
      if (body !== '') emit(`/* ${body} */`)
      i = end
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      emit(text.slice(i, stop).replace(/\s*\r?\n\s*/g, ' '))
      i = stop
    } else {
      emit(c)
      i++
    }
  }
  return out
}

// ---- Error positions -----------------------------------------------------------------------------------

/** Absolute offset of a 1-based line and column relative to `statementText`, clamped to the statement. */
export function offsetOfPosition(
  statementText: string,
  statementStart: number,
  position: { line: number; column: number },
): number {
  const lines = statementText.split('\n')
  const line = Math.min(Math.max(position.line, 1), lines.length)
  let offset = 0
  for (let k = 0; k < line - 1; k++) offset += (lines[k] as string).length + 1
  const col = Math.min(Math.max(position.column - 1, 0), (lines[line - 1] as string).length)
  return statementStart + offset + col
}

/**
 * Where a result's statement sits in the editor text. The run covered `base` (the range or the whole
 * text); the result carries the statement text (maybe shortened for display) and its index.
 */
export function locateStatement(
  text: string,
  base: { from: number; to: number } | undefined,
  index: number,
  sql: string,
): { from: number; to: number } | undefined {
  const from = base?.from ?? 0
  const slice = text.slice(from, base?.to ?? text.length)
  const { statements } = splitLocal(slice)
  const byIndex = statements[index]
  const shown = sql.replace(/…$/, '')
  if (byIndex && (shown === '' || byIndex.text.startsWith(shown.slice(0, 64)))) {
    return { from: from + byIndex.start, to: from + byIndex.end }
  }
  const found = shown ? slice.indexOf(shown) : -1
  if (found >= 0) return { from: from + found, to: from + found + shown.length }
  return byIndex ? { from: from + byIndex.start, to: from + byIndex.end } : undefined
}

/** Best-effort offset from a refusal message such as "unterminated string at 14"; undefined when absent. */
export function offsetFromMessage(message: string): number | undefined {
  const m = /(?:position|offset|\bat)\s*:?\s*(\d+)/i.exec(message)
  return m ? Number(m[1]) : undefined
}

// ---- Grid helpers -------------------------------------------------------------------------------------------

export type SortState = { column: number; direction: 'asc' | 'desc' } | undefined

export function cellText(cell: Cell): string {
  if (cell === null) return 'NULL'
  if (typeof cell === 'string') return cell
  if ('binary' in cell) return `0x${cell.binary}`
  return cell.cut
}

const NUMERIC = /^-?\d+(\.\d+)?$/

function compareCells(a: Cell, b: Cell): number {
  const x = cellText(a)
  const y = cellText(b)
  if (NUMERIC.test(x) && NUMERIC.test(y)) return Number(x) - Number(y)
  return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
}

/** Sorted copy of the loaded rows (the query text never changes, FR-ISS-144); NULL sorts last either way. */
export function sortRows(rows: Cell[][], sort: SortState): Cell[][] {
  if (!sort) return rows
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((r1, r2) => {
    const a = r1[sort.column] ?? null
    const b = r2[sort.column] ?? null
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return sign * compareCells(a, b)
  })
}

export function nextSort(current: SortState, column: number): SortState {
  if (current?.column !== column) return { column, direction: 'asc' }
  return current.direction === 'asc' ? { column, direction: 'desc' } : undefined
}

/** Column widths in px from the header and a sample of rows; clamped so one long cell cannot take the grid. */
export function columnWidths(names: string[], rows: Cell[][], sample = 200): number[] {
  return names.map((name, c) => {
    let longest = name.length + 3
    for (let r = 0; r < Math.min(rows.length, sample); r++) {
      const len = cellText(rows[r]?.[c] ?? null).length
      if (len > longest) longest = len
    }
    return Math.round(Math.min(Math.max(longest * 7.6 + 28, 96), 360))
  })
}

/** Numeric column types are right-aligned. */
export function isNumericColumn(type: string): boolean {
  return /^(tiny|small|medium|big)?int|^(decimal|numeric|float|double|real|bit|year)/i.test(type)
}

// ---- Responses ----------------------------------------------------------------------------------------------

/** Plan expiry arrives in seconds or milliseconds; returns milliseconds. */
export const expiryMs = (value: number) => (value < 1e12 ? value * 1000 : value)

/** List responses may be a bare array or an object; picks the array under `key` either way. */
export function pickList<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

/** True when a response says the data lasts for the session only (stateless mode, FR-SQL-019). */
export function isSessionOnly(value: unknown): boolean {
  return Boolean(
    value && typeof value === 'object' && (value as Record<string, unknown>).stateless === true,
  )
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)} min ${s % 60} s`
}

/** Whole seconds for the status line when the limit is a whole number, else one decimal. */
export function formatSeconds(ms: number): string {
  const s = ms / 1000
  return Number.isInteger(s) ? `${s}` : s.toFixed(1)
}

/**
 * Refreshes what a run made stale (FR-SQL-025): the database list, the table list of each affected database
 * and the rows and definition of each affected table. A change without a known database, or a USE, falls back
 * to all table lists.
 */
export function refreshAfterSql(
  client: Pick<QueryClient, 'invalidateQueries'>,
  response: { changed?: SqlChange[]; db?: string },
): void {
  const changed = response.changed ?? []
  if (changed.length === 0 && response.db === undefined) return
  const inv = (queryKey: readonly unknown[]) => void client.invalidateQueries({ queryKey })
  if (changed.length > 0) {
    inv(keys.databases)
    inv(['structure'])
  }
  for (const c of changed) {
    if (!c.db) {
      inv(['tables'])
      continue
    }
    inv(keys.tables(c.db))
    if (c.database) inv(keys.rows(c.db))
    else if (c.table) inv(keys.rows(c.db, c.table))
  }
  if (response.db !== undefined) inv(['tables'])
}

/**
 * Position shown in the confirmation: the statement's place in the whole batch, not in the list of
 * statements that need confirmation. `null` for entries outside the batch (the foreign-key switch, index -1).
 */
export function confirmPosition(
  index: number,
  shown: number,
  totalStatements?: number,
): { n: number; total: number } | null {
  if (index < 0) return null
  return { n: index + 1, total: Math.max(totalStatements ?? shown, index + 1) }
}
