/**
 * SQL import (FR-IO-016/017/020, spec 5.7): an incremental statement splitter that tracks byte offsets of the
 * decoded UTF-8 stream, the three-tier statement policy, and the runner. One dedicated connection is used and
 * destroyed at the end, so `USE`, `SET` and `foreign_key_checks` of the file cannot leak into the pool.
 * Statements run through `streamStatement` of the SQL tab (row and byte caps, `multipleStatements` off).
 */
import { createHash } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { codeTokens, scanToken, tokenError, type LexOptions } from '../../lib/sql/lexer'
import { atLineStart, parseDelimiterCommand } from '../../lib/sql/splitter'
import { killThreadQuery, startWatchdog } from '../guard/statement-timeout'
import { mapMysqlError } from '../structure/errors'
import type { Classification } from '../sql/types'
import { classifyStatement } from '../sql/classify'
import { readyClassifier } from '../sql/a-deps'
import { PARSE_MAX_BYTES } from '../sql/parser'
import * as fx from '../sql/fixed'
import { changesOf, streamStatement } from '../sql/run'
import { auditIo } from '../audit'
import { openDecoded, skipDecodedBytes, type ImportSource, IoFailure, asIoFailure } from './import-source'
import {
  ImportAccum,
  SET_NAMES,
  classCountsText,
  failResult,
  finishJob,
  resultOf,
  retainSource,
  type ImportRunEnv,
} from './import-job'
import type { ImportStatementClass, IoError, SqlImportOptions } from './types'

// ---- Incremental splitter ------------------------------------------------------------------------------------

export type StreamStatement = {
  text: string
  /** Offset (UTF-8 bytes of the decoded stream) of the first character, and just after the delimiter. */
  startByte: number
  endByte: number
  /** 1-based line of the first character. */
  line: number
  firstKeyword: string
  flags: { executableComment: boolean; empty: boolean }
  /** The text ended inside a string or comment (end of file). */
  unterminated: boolean
  /** Delimiter in force after this statement. */
  delimiter: string
}

export type StatementStreamOptions = {
  delimiter?: string
  lex?: LexOptions
  startByte?: number
  startLine?: number
}

const COMPACT_AT = 256 * 1024

/**
 * Pull-based splitter with the rules of `lib/sql/splitter.ts` (quotes, backticks, comments, executable comments, the
 * `DELIMITER` command), fed in chunks. A token that touches the end of the buffered text is held back until
 * more text arrives (or `final`), so a chunk boundary never changes the result. Lexer options can change
 * between statements (`SET sql_mode`).
 */
export class StatementStream {
  private buf = ''
  private i = 0
  /** Where the next statement search starts (after the last delimiter or DELIMITER command). */
  private pos = 0
  private start = -1
  private lastEnd = -1
  private codeSeen = false
  private firstKeyword = ''
  private exec = false
  private unterminated = false
  private delimiter: string
  private lex: LexOptions
  // accounting of bytes and lines up to `accIdx`
  private accIdx = 0
  private accBytes: number
  private accLine: number

  constructor(o: StatementStreamOptions = {}) {
    this.delimiter = o.delimiter && o.delimiter.length > 0 ? o.delimiter : ';'
    this.lex = o.lex ?? {}
    this.accBytes = o.startByte ?? 0
    this.accLine = o.startLine ?? 1
  }

  get currentDelimiter(): string {
    return this.delimiter
  }

  /** Decoded bytes before the unconsumed text (all statements returned so far). */
  push(text: string): void {
    if (this.accIdx > COMPACT_AT) {
      const shift = this.accIdx - 1
      this.buf = this.buf.slice(shift)
      this.i -= shift
      this.pos -= shift
      if (this.start >= 0) this.start -= shift
      if (this.lastEnd >= 0) this.lastEnd -= shift
      this.accIdx -= shift
    }
    this.buf += text
  }

  setLex(lex: LexOptions): void {
    this.lex = lex
    // Anything scanned ahead with the old options is scanned again.
    this.resetStatement()
    this.i = this.pos
  }

  private resetStatement(): void {
    this.start = -1
    this.lastEnd = -1
    this.codeSeen = false
    this.firstKeyword = ''
    this.exec = false
    this.unterminated = false
  }

  private advance(idx: number): void {
    if (idx <= this.accIdx) return
    const slice = this.buf.slice(this.accIdx, idx)
    this.accBytes += Buffer.byteLength(slice, 'utf8')
    for (let k = slice.indexOf('\n'); k !== -1; k = slice.indexOf('\n', k + 1)) this.accLine++
    this.accIdx = idx
  }

  private emit(endIdx: number): StreamStatement {
    this.advance(this.start)
    const startByte = this.accBytes
    const line = this.accLine
    const text = this.buf.slice(this.start, this.lastEnd)
    this.advance(endIdx)
    const out: StreamStatement = {
      text,
      startByte,
      endByte: this.accBytes,
      line,
      firstKeyword: this.firstKeyword,
      flags: { executableComment: this.exec, empty: !this.codeSeen },
      unterminated: this.unterminated,
      delimiter: this.delimiter,
    }
    this.resetStatement()
    this.pos = endIdx
    return out
  }

  /** The next complete statement, or `undefined` when more text is needed (or at the end with `final`). */
  next(final: boolean): StreamStatement | undefined {
    const buf = this.buf
    const n = buf.length
    while (this.i < n) {
      const t = scanToken(buf, this.i, this.lex, this.delimiter)
      if (!final && t.end >= n && t.type !== 'delimiter') return undefined
      if (t.type === 'ws') {
        this.i = t.end
        continue
      }
      if (t.type === 'delimiter') {
        this.i = t.end
        if (this.start < 0) {
          this.pos = t.end
          continue
        }
        return this.emit(t.end)
      }
      if (
        t.type === 'word' &&
        !this.codeSeen &&
        t.end - t.start === 9 &&
        buf.slice(t.start, t.end).toUpperCase() === 'DELIMITER' &&
        atLineStart(buf, t.start)
      ) {
        if (!final) {
          // The command needs its whole line.
          let e = t.end
          while (e < n && buf.charCodeAt(e) !== 10 && buf.charCodeAt(e) !== 13) e++
          if (e >= n) return undefined
        }
        const cmd = parseDelimiterCommand(buf, t.end)
        if (cmd) {
          this.resetStatement()
          this.delimiter = cmd.delimiter
          this.i = cmd.next
          this.pos = cmd.next
          continue
        }
      }
      if (this.start < 0) this.start = t.start
      this.lastEnd = t.end
      this.i = t.end
      if (tokenError(t)) this.unterminated = true
      if (t.type === 'lineComment' || t.type === 'blockComment') continue
      if (t.type === 'execComment') {
        this.exec = true
        const inner = t.inner as { start: number; end: number }
        const first = codeTokens(buf.slice(inner.start, inner.end), this.lex).tokens[0]
        if (first) {
          this.codeSeen = true
          if (this.firstKeyword === '') this.firstKeyword = first.upper.toUpperCase()
        }
        continue
      }
      this.codeSeen = true
      if (this.firstKeyword === '') this.firstKeyword = buf.slice(t.start, t.end).toUpperCase()
    }
    if (final && this.start >= 0) return this.emit(n)
    return undefined
  }
}

// ---- sql_mode as the analysis sees it (no connection state) ----------------------------------------------------

/**
 * Follows `SET sql_mode` of a script without a connection, only for the lexer options of the analysis (the
 * runner asks the server). Handles a literal, a saved variable and `CONCAT(@@sql_mode, ',X')`.
 */
export class SqlModeTracker {
  private vars = new Map<string, string>()
  constructor(public mode: string) {}

  /** Returns true when the lexer-relevant flags may have changed. */
  observe(text: string): boolean {
    if (!/sql_mode/i.test(text)) return false
    const before = this.lexOptions()
    for (const m of text.matchAll(/@([A-Za-z0-9_$]+)\s*:?=\s*@@(?:session\.|global\.|local\.)?sql_mode/gi)) {
      this.vars.set((m[1] as string).toLowerCase(), this.mode)
    }
    const lit = /sql_mode\s*:?=\s*(?:'((?:[^'\\]|\\.|'')*)'|"((?:[^"\\]|\\.|"")*)")/i.exec(text)
    const restore = /sql_mode\s*:?=\s*@([A-Za-z0-9_$]+)/i.exec(text)
    const concat = /sql_mode\s*:?=\s*CONCAT\s*\(\s*@@(?:session\.)?sql_mode\s*,\s*'([^']*)'/i.exec(text)
    if (concat) this.mode = `${this.mode},${concat[1] as string}`
    else if (lit) this.mode = (lit[1] ?? lit[2] ?? '').toString()
    else if (restore) this.mode = this.vars.get((restore[1] as string).toLowerCase()) ?? this.mode
    const after = this.lexOptions()
    return before.noBackslashEscapes !== after.noBackslashEscapes || before.ansiQuotes !== after.ansiQuotes
  }

  lexOptions(): LexOptions {
    return {
      noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(this.mode),
      ansiQuotes: /ANSI_QUOTES/i.test(this.mode),
    }
  }
}

// ---- Statement policy (spec 5.7) --------------------------------------------------------------------------------

export type ImportVerdict = {
  tier: ImportStatementClass
  /** Short kind for lists: `DROP TABLE`, `GRANT`, `SET GLOBAL`. */
  label: string
  classification: Classification
}

const REFUSED_ADMIN = new Set(['SHUTDOWN', 'FLUSH', 'RESET', 'INSTALL', 'UNINSTALL', 'CHANGE', 'START', 'STOP'])
const OBJECT_WORDS = new Set([
  'TABLE', 'VIEW', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT', 'USER', 'ROLE', 'DATABASE', 'SCHEMA',
  'INDEX', 'SEQUENCE', 'SERVER', 'TABLESPACE',
])

export type PolicyContext = {
  product: 'mysql' | 'mariadb'
  lex?: LexOptions
  /** false: the parser could not be loaded (every verdict that needs it is hard). */
  parser?: boolean
}

function labelOf(kind: Classification['kind'], reasons: Classification['reasons'], text: string, lex?: LexOptions): string {
  if (kind === 'setGlobal') return 'SET GLOBAL'
  if (kind === 'kill') return 'KILL'
  if (kind === 'loadData') return 'LOAD DATA'
  if (kind === 'selectInto' && reasons.includes('into-outfile')) return 'SELECT INTO OUTFILE'
  const toks = codeTokens(text, lex).tokens.slice(0, 14)
  const w = (i: number) => (toks[i]?.type === 'word' ? toks[i]!.upper : '')
  const first = w(0)
  if (first === '') return 'STATEMENT'
  if (first === 'CREATE' || first === 'ALTER' || first === 'DROP' || first === 'RENAME') {
    for (let i = 1; i < toks.length; i++) if (OBJECT_WORDS.has(w(i))) return `${first} ${w(i)}`
    return first
  }
  if (['START', 'STOP', 'CHANGE', 'INSTALL', 'UNINSTALL'].includes(first) && w(1) !== '') return `${first} ${w(1)}`
  if (first === 'SET' && w(1) === 'PASSWORD') return 'SET PASSWORD'
  if (first === 'SET' && (w(1) === 'PERSIST' || w(1) === 'PERSIST_ONLY')) return `SET ${w(1)}`
  return first
}

/**
 * Classifies one statement of an uploaded file. Refused (guard rail, not a boundary), hard (token), soft and
 * none as in `sql-tab`. A statement over `PARSE_MAX_BYTES` cannot be parsed and is hard, except a plain
 * INSERT or REPLACE without an executable comment, which the lexer alone decides (a 1 MiB extended INSERT of
 * the DBLoom dump must not need a confirmation).
 */
export function classifyImportStatement(
  st: { text: string; firstKeyword: string; flags: { executableComment: boolean } },
  ctx: PolicyContext,
): ImportVerdict {
  let c: Classification
  const oversize = st.text.length > PARSE_MAX_BYTES
  if (oversize && !st.flags.executableComment && (st.firstKeyword === 'INSERT' || st.firstKeyword === 'REPLACE')) {
    const replace = st.firstKeyword === 'REPLACE'
    c = {
      kind: replace ? 'replace' : 'insert',
      class: replace ? 'soft' : 'none',
      readOnlySafe: false,
      commitsImplicitly: false,
      reasons: [],
    }
  } else {
    c = classifyStatement(
      { text: st.text, start: 0, end: st.text.length, firstKeyword: st.firstKeyword, flags: { executableComment: st.flags.executableComment, empty: false } },
      { product: ctx.product, lex: ctx.lex, ...(ctx.parser === false ? { parser: null } : {}) },
    )
  }
  const refused =
    c.kind === 'setGlobal' ||
    c.kind === 'kill' ||
    c.kind === 'loadData' ||
    (c.kind === 'selectInto' && c.reasons.includes('into-outfile')) ||
    (c.kind === 'admin' && REFUSED_ADMIN.has(st.firstKeyword))
  if (refused) return { tier: 'refused', label: labelOf(c.kind, c.reasons, st.text, ctx.lex), classification: c }
  return {
    tier: c.class,
    label: c.class === 'hard' ? labelOf(c.kind, c.reasons, st.text, ctx.lex) : '',
    classification: c,
  }
}

export const parserReady = (): Promise<boolean> => readyClassifier()

// ---- Resume state ---------------------------------------------------------------------------------------------------

export type SqlResume = {
  sourceId: string
  charset?: string
  db?: string
  options: SqlImportOptions
  fkOff: boolean
  hardAllowed: boolean
  totalBytes?: number
  decodedOffset: number
  statementNumber: number
  line: number
  delimiter: string
  /** Session-setting statements that ran (replayed on the next segment). */
  session: string[]
  acc: ImportAccum
}

/** In memory only, like the jobs (Q5). */
export const sqlResumes = new Map<string, SqlResume>()

// ---- Runner -----------------------------------------------------------------------------------------------------------

export type SqlRunArgs = {
  env: ImportRunEnv
  source: ImportSource
  charset?: string
  db?: string
  options: SqlImportOptions
  /** Resolved `foreignKeyChecksOff` (ST-160). */
  fkOff: boolean
  hardAllowed: boolean
  totalBytes?: number
  resume?: SqlResume
}

const MAX_SESSION_STATEMENTS = 500
const RUN_LIMITS = { rowCap: 1, responseBytes: 1024 * 1024, cellBytes: 1024 }
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

async function modeOf(c: PoolConnection): Promise<string> {
  const [rows] = await c.query(fx.SELECT_SQL_MODE)
  return str(((rows as Row[])[0] ?? {}).m)
}

function ioErrorFrom(e: unknown, extra: Partial<IoError> = {}): IoError {
  const m = mapMysqlError(e)
  return {
    code: 'statement_failed',
    message: m.errno != null ? `Error ${m.errno}: ${m.message}` : m.message,
    ...(m.errno != null ? { errno: m.errno } : {}),
    serverMessage: m.message,
    ...extra,
  }
}

/** Runs the job body. Ends the job itself (done, failed, cancelled by the registry, or paused). */
export async function runSqlImport(a: SqlRunArgs): Promise<void> {
  const { env } = a
  const now = env.now ?? Date.now
  const acc = a.resume?.acc ?? new ImportAccum()
  const segStart = now()
  const elapsed = () => acc.elapsedMs + (now() - segStart)
  const signal = env.jobs.signal(env.jobId)
  const session: string[] = a.resume ? [...a.resume.session] : []
  let offset = a.resume?.decodedOffset ?? 0
  let number = a.resume?.statementNumber ?? 0
  const startRun = acc.run + acc.failed
  let line = a.resume?.line ?? 1
  let delimiter = a.resume?.delimiter ?? ';'
  let currentDb = a.db
  let inTx = false
  let lastProgress = 0
  let conn: PoolConnection | undefined
  let txOpen = false
  const parser = await parserReady()
  let lastStatementHash: string | undefined

  const endAudit = () => ({
    statements: acc.run,
    classCounts: classCountsText(acc.classCounts),
    ...(lastStatementHash ? { statementHash: lastStatementHash } : {}),
    statementNumber: number,
    bytes: offset,
  })

  try {
    retainSource(env, a.source.id, a.source.kind)
    conn = await env.pool.getConnection()
    const c = conn
    env.jobs.setCancelHook(env.jobId, async () => {
      await killThreadQuery(env.pool, c.threadId)
      c.destroy()
    })
    await c.query(SET_NAMES)
    if (a.fkOff) await c.query(fx.SET_FK_CHECKS_OFF)
    if (a.db !== undefined) await c.query(fx.useDatabase(a.db))
    for (const s of session) await c.query(s)
    let mode = await modeOf(c)
    if (a.options.rollbackOnError) {
      await c.query(fx.START_TRANSACTION)
      txOpen = true
    }

    const decoded = await openDecoded(a.source, env, a.charset)
    const text = a.resume ? skipDecodedBytes(decoded.text, offset) : decoded.text
    const lexOf = (m: string): LexOptions => ({
      noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(m),
      ansiQuotes: /ANSI_QUOTES/i.test(m),
    })
    const stream = new StatementStream({ delimiter, lex: lexOf(mode), startByte: offset, startLine: line })

    const ctl: { stop: 'none' | 'fail' | 'pause' | 'cancel'; failed?: IoError } = { stop: 'none' }

    const readNotes = async () => {
      try {
        const [rows] = await c.query(fx.SHOW_WARNINGS)
        for (const r of (rows as Row[]).slice(0, 20)) {
          acc.note(`${str(r.Level)} ${Number(r.Code) || 0}: ${str(r.Message)}`)
        }
      } catch {
        // notes are best effort
      }
    }

    const handle = async (st: StreamStatement): Promise<void> => {
      if (st.flags.empty) {
        offset = st.endByte
        line = st.line
        delimiter = st.delimiter
        return
      }
      if (signal.aborted) {
        ctl.stop = 'cancel'
        return
      }
      if (number + 1 <= a.options.skipStatements) {
        number++
        acc.skipped++
        offset = st.endByte
        delimiter = st.delimiter
        return
      }
      // Time limit: stop cleanly between statements, not inside a transaction of the file.
      // (at least one statement per segment, so a resume always makes progress)
      if (!inTx && elapsed() >= env.jobMs && acc.run + acc.failed > startRun) {
        ctl.stop = 'pause'
        return
      }
      number++
      line = st.line
      const verdict = classifyImportStatement(st, { product: env.product, lex: lexOf(mode), parser })
      acc.classCounts[verdict.tier] = (acc.classCounts[verdict.tier] ?? 0) + 1
      const hash = sha(st.text)
      const here = { statementNumber: number, byteOffset: st.startByte, line: st.line }
      if (st.unterminated) {
        lastStatementHash = hash
        ctl.stop = 'fail'
        ctl.failed = {
          code: 'statement_failed',
          message: 'The statement ends inside a string or comment',
          ...here,
          statementText: st.text.slice(0, 2000),
        }
        acc.failed++
        return
      }
      if (verdict.tier === 'refused') {
        if (!a.options.skipRefused) {
          lastStatementHash = hash
          ctl.stop = 'fail'
          ctl.failed = {
            code: 'refused_statement',
            message: `Statement ${number} (${verdict.label}) is not allowed in an import`,
            ...here,
          }
          return
        }
        acc.skipped++
        acc.skippedObjects.push({ object: `statement ${number}`, message: `${verdict.label} (refused)` })
        offset = st.endByte
        delimiter = st.delimiter
        return
      }
      if (verdict.tier === 'hard' && !a.hardAllowed) {
        lastStatementHash = hash
        ctl.stop = 'fail'
        ctl.failed = {
          code: 'confirm_required',
          message: `Statement ${number} (${verdict.label}) needs a confirmation`,
          ...here,
        }
        return
      }
      // The kill timer is per statement; it is never shorter than 30 s so that a short segment limit only pauses.
      const wd = startWatchdog(env.pool, c, Math.max(env.jobMs, 30_000))
      let out
      try {
        out = await streamStatement(c, st.text, RUN_LIMITS, { used: 0 }, wd)
      } finally {
        await wd.stop()
      }
      if (signal.aborted) {
        ctl.stop = 'cancel'
        return
      }
      const fatal = (out.error as { fatal?: unknown } | undefined)?.fatal === true
      if (wd.timedOut) {
        lastStatementHash = hash
        ctl.stop = 'fail'
        ctl.failed = { code: 'time_limit', message: 'The statement ran longer than the time limit', ...here }
        return
      }
      if (out.error && !out.capKilled) {
        lastStatementHash = hash
        acc.failed++
        const err = ioErrorFrom(out.error, { ...here, statementText: st.text.slice(0, 2000) })
        if (fatal) {
          ctl.stop = 'fail'
          ctl.failed = { ...err, message: `Connection lost: ${err.message}` }
          return
        }
        const keepGoing = a.options.ignoreErrors && !a.options.rollbackOnError
        if (!keepGoing) {
          ctl.stop = 'fail'
          ctl.failed = err
          return
        }
        acc.reject({ row: number, code: String(err.errno ?? 'error'), message: err.serverMessage ?? err.message })
        offset = st.endByte
        delimiter = st.delimiter
        return
      }
      acc.run++
      offset = st.endByte
      delimiter = st.delimiter
      if (out.ok) {
        inTx = (out.ok.serverStatus & 1) !== 0
        if (out.ok.warningCount > 0) await readNotes()
      }
      const kind = verdict.classification.kind
      if (kind === 'setSession' || kind === 'use') {
        session.push(st.text)
        if (session.length > MAX_SESSION_STATEMENTS) session.shift()
        if (kind === 'use') {
          try {
            const [rows] = await c.query(fx.SELECT_DATABASE)
            const d = ((rows as Row[])[0] ?? {}).d
            currentDb = typeof d === 'string' ? d : currentDb
          } catch {
            // keep the last known name
          }
        }
        if (/sql_mode/i.test(st.text)) {
          mode = await modeOf(c)
          stream.setLex(lexOf(mode))
        }
      }
      if (['createObject', 'dropObject', 'alterObject', 'renameObject', 'truncate'].includes(kind)) {
        for (const ch of changesOf(verdict.classification, currentDb)) acc.changes.add(ch.db, ch.table)
      }
      const t = now()
      if (t - lastProgress > 250) {
        lastProgress = t
        env.jobs.progress(env.jobId, {
          bytes: offset,
          ...(a.totalBytes !== undefined ? { totalBytes: a.totalBytes } : {}),
          statements: number,
        })
      }
    }

    outer: for await (const chunk of text) {
      stream.push(chunk)
      for (;;) {
        const st = stream.next(false)
        if (!st) break
        await handle(st)
        if (ctl.stop !== 'none') break outer
      }
    }
    if (ctl.stop === 'none') {
      for (;;) {
        const st = stream.next(true)
        if (!st) break
        await handle(st)
        if (ctl.stop !== 'none') break
      }
    }

    // ---- End of this segment
    if (ctl.stop === 'cancel') return
    env.jobs.progress(env.jobId, { bytes: offset, statements: number })
    acc.elapsedMs = elapsed()
    if (ctl.stop === 'fail' && ctl.failed) {
      if (txOpen) {
        await c.query(fx.ROLLBACK).catch(() => undefined)
        txOpen = false
        acc.note('The transaction was rolled back; DDL and tables without transactions are not rolled back.')
      }
      acc.changes.emit()
      finishJob(env, 'failed', failResult(acc, env, ctl.failed), endAudit())
      sqlResumes.delete(env.jobId)
      return
    }
    if (txOpen) {
      // Commit before pausing or ending: a destroyed connection would drop the work.
      await c.query(fx.COMMIT)
      txOpen = false
      if (a.options.rollbackOnError) {
        acc.note('Rollback on error only covers tables with transactions; DDL commits at once.')
      }
    }
    if (ctl.stop === 'pause') {
      acc.changes.emit()
      const result = resultOf(acc, {
        statements: { run: acc.run, skipped: acc.skipped, failed: acc.failed },
        resume: { decodedOffset: offset, statementNumber: number },
      })
      sqlResumes.set(env.jobId, {
        sourceId: a.source.id,
        charset: a.charset,
        db: currentDb ?? a.db,
        options: a.options,
        fkOff: a.fkOff,
        hardAllowed: a.hardAllowed,
        totalBytes: a.totalBytes,
        decodedOffset: offset,
        statementNumber: number,
        line,
        delimiter,
        session,
        acc,
      })
      env.jobs.pause(env.jobId, result)
      auditIo('io.import.end', { user: env.user, target: env.targetLabel, jobId: env.jobId, kind: 'import', state: 'paused', ...endAudit(), durationMs: acc.elapsedMs })
      return
    }
    acc.changes.emit()
    const result = resultOf(acc, {
      statements: { run: acc.run, skipped: acc.skipped, failed: acc.failed },
    })
    const state = acc.failed > 0 ? 'done_with_rejects' : acc.skippedObjects.length > 0 ? 'done_with_skips' : 'done'
    finishJob(env, state, result, endAudit())
    sqlResumes.delete(env.jobId)
  } catch (e) {
    if (signal.aborted) return
    acc.elapsedMs = elapsed()
    const f = asIoFailure(e)
    const error: IoError =
      f instanceof IoFailure
        ? { ...f.error, statementNumber: number, byteOffset: f.error.byteOffset ?? offset }
        : ioErrorFrom(e, { statementNumber: number })
    if (conn && txOpen) await conn.query(fx.ROLLBACK).catch(() => undefined)
    acc.changes.emit()
    finishJob(env, 'failed', failResult(acc, env, error), endAudit())
    sqlResumes.delete(env.jobId)
  } finally {
    conn?.destroy()
  }
}

