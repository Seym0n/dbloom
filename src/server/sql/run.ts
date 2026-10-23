/**
 * Runner of the SQL tab (FR-SQL-001..016, 029; spec 5.4, 5.5). Package B of module sql-tab.
 *
 * Verified on 2026-10-24 against MySQL 8.4 (127.0.0.1:33064) and MariaDB 10.11 (127.0.0.1:33061), mysql2 3.24.6,
 * scratch database `sql_b_scratch` (dropped afterwards). These are the "verify" cells of spec task 0b:
 *
 * (a) Streaming with the core connection (`conn.connection.query({sql, rowsAsArray: true})`, events):
 *     - A statement with rows: `fields` (array of field packets), then one `result(row, setIndex)` per row, `end`.
 *     - `CALL p()` with three SELECTs and an UPDATE: `fields, result* (setIndex 0)`, `fields, result* (1)`,
 *       `fields, result* (2)`, then `fields(undefined)` + `result(ResultSetHeader)` (the final OK, no index),
 *       then `end`. The `resultset` event is not emitted. Both products behave the same.
 *     - `fields` is `undefined` for an OK packet. A handler that maps over it throws inside the parser and the
 *       connection dies without `end` (found the hard way): the handler must test for it.
 *     - A statement without rows (UPDATE) gives `fields(undefined)` and `result(ResultSetHeader)`;
 *       `affectedRows`, `insertId`, `info`, `warningStatus` (the warning count), `serverStatus` (bit 1 = in
 *       transaction). A SELECT with zero rows gives `fields` and no `result`.
 *     - With `rowsAsArray` a duplicate column name (`SELECT 1 AS x, 2 AS x`) is kept; rows are positional.
 *     - Values: BIGINT/DECIMAL as strings (bigNumberStrings), temporals as strings (dateStrings), binary
 *       (charset 63) as Buffer, JSON as string, NULL as null. MySQL types a literal 1 as BIGINT (string "1"),
 *       MariaDB as INT (number 1): cells are converted with String().
 *     - `KILL QUERY <threadId>` from a second connection while rows stream: the query ends with error 1317
 *       (`Query execution was interrupted`) on both products; 150 to 900 more rows can still arrive before
 *       the error, so the reader keeps dropping rows until `end`. The connection answers the next query.
 *       A killed `SELECT SLEEP(10)` returns 1 without any error on MySQL (error 1317 on MariaDB), hence the
 *       watchdog's `timedOut` flag decides what is reported, not the error.
 *     - `SHOW WARNINGS` works after any statement; `SELECT @@warning_count` clears the list on MySQL, so
 *       it is not used. `SELECT 1; SELECT 2` in one `query` is error 1064 (multipleStatements false). A
 *       trailing `;` in the text is accepted by the server.
 *
 * (b) `SET SESSION TRANSACTION READ ONLY`: on both products INSERT, CREATE TABLE, CREATE TEMPORARY TABLE, `CALL`
 *     of a writing procedure and a `SELECT` of a writing function fail with errno 1792
 *     (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION; MySQL: "...READ ONLY transaction.", MariaDB without the period).
 *     The connection stays usable. BUT `SET SESSION TRANSACTION READ WRITE` and `START TRANSACTION READ WRITE`
 *     are accepted and lift the protection (writes work afterwards), so the classifier must refuse them on a
 *     read-only connection (FR-SQL-007). `@@transaction_read_only` exists on MySQL only (MariaDB: `@@tx_read_only`).
 *
 * (c) Timeouts: MySQL `SET SESSION max_execution_time = <ms>` applies to SELECT only: `SELECT SLEEP(5) FROM t`
 *     fails with 3024 after the limit, a table-less `SELECT SLEEP(5)` returns 1 (no error), UPDATE and DO are
 *     not limited. MariaDB `SET SESSION max_statement_time = <seconds, decimals allowed>` stops SELECT, UPDATE
 *     with error 1969; `DO SLEEP()` returns normally. The unknown variable is error 1193 on the other product.
 *     Because of the silent table-less case the watchdog (`startWatchdog`) is the first line and reports "time
 *     limit"; the server variable is set one second above the limit as a backstop (observed order: the
 *     watchdog fires first on both products). Server-side error 3024/1969 is mapped to the same text.
 *
 * (d) EXPLAIN: MySQL `EXPLAIN FORMAT=JSON`, `EXPLAIN FORMAT=TREE`, `EXPLAIN ANALYZE` (tree text);
 *     `EXPLAIN ANALYZE FORMAT=JSON` is error 1235. MariaDB `EXPLAIN FORMAT=JSON`, `ANALYZE FORMAT=JSON`,
 *     `ANALYZE` (table); `EXPLAIN ANALYZE` is error 1064, `FORMAT=TREE` error 1791.
 */
import { createHash } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { auditSqlRun, auditSqlStatement } from '../audit'
import type { Cell } from '../db/rows'
import type { TargetPool } from '../db/target-pool'
import { assertWritable, WriteGuardError } from '../guard/write-guard'
import { hashStatements, type TokenIssuer } from '../guard/confirm-token'
import { startWatchdog, type Watchdog } from '../guard/statement-timeout'
import { parseServerInfo } from '../structure/capabilities'
import { structureEvents } from '../structure/execute'
import {
  mapMysqlError,
  positionOf,
  relativePosition,
  StructureRefusal,
  toClientError,
} from '../structure/errors'
import { planStore as defaultPlanStore, type PlanStore, type StoredPlan } from '../structure/plans'
import type {
  GuardContext,
  Product,
  ServerInfo,
  Statement,
  StatementClass,
  StructureError,
} from '../structure/types'
import type { TargetKey } from '../target'
import { classifyBatch, readyClassifier, splitSql } from './a-deps'
import * as fx from './fixed'
import { runRegistry, type RunHandle, type RunRegistry } from './registry'
import type {
  ClassifiedStatement,
  ConfirmSqlInput,
  HistorySource,
  RunSqlInput,
  SqlColumnMeta,
  SqlLimits,
  SqlChange,
  SqlPlanStatement,
  SqlRunOptions,
  SqlRunResponse,
  SqlStatementResult,
  SqlTruncation,
  SqlWarning,
} from './types'

// ---- Environment ---------------------------------------------------------------------------------------

/** What the runner reports once per run; the history sink turns it into a `NewHistoryEntry`. */
export type SqlHistoryRecord = {
  /** The text that was run, as typed (not yet redacted). Never contains a token. */
  text: string
  db: string | null
  statements: number
  executed: number
  failedIndex: number | null
  maxClass: StatementClass
  outcome: 'ok' | 'failed' | 'cancelled' | 'timeout' | 'refused'
  durationMs: number
  source?: HistorySource
}

export type SqlRunEnv = {
  session: {
    idHash: string
    target: TargetKey
    pool: TargetPool
    readOnly?: boolean
  }
  guard: GuardContext
  tokens: TokenIssuer
  limits: SqlLimits
  plans?: PlanStore
  registry?: RunRegistry
  /** Aborts when the HTTP request ends early (page closed, connection dropped): the run is cancelled (FR-SQL-013). */
  signal?: AbortSignal
  now?: () => number
  /** Called after each run that reached the guard; a failure here never fails the run. */
  recordHistory?: (record: SqlHistoryRecord) => void
}

export const targetLabel = (t: TargetKey): string => `${t.host}${t.zone ?? ''}:${t.port}`

const isReadOnly = (g: GuardContext): boolean => g.forcedReadOnly || g.sessionReadOnly

/** Marker of the plan payload; plans of other modules are never accepted here. */
type RunPayload = {
  v: 1
  type: 'sql-run'
  text: string
  range?: { from: number; to: number }
  db?: string
  options: SqlRunOptions
  maxClass: StatementClass
}

// ---- Small helpers -------------------------------------------------------------------------------------

const MAX_DISPLAY_SQL = 4000
const MAX_WARNINGS = 50
const MAX_FULL_SQL = 64 * 1024

export const display = (sql: string): string =>
  sql.length > MAX_DISPLAY_SQL ? `${sql.slice(0, MAX_DISPLAY_SQL)}...` : sql

export const sqlHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

const rank: Record<StatementClass, number> = { none: 0, soft: 1, hard: 2 }
const maxOf = (a: StatementClass, b: StatementClass): StatementClass => (rank[a] >= rank[b] ? a : b)

const asStatements = (list: ClassifiedStatement[]): Statement[] =>
  list.map((s) => ({
    sql: s.text,
    kind: 'userSql',
    class: s.classification.class,
    effect: s.classification.kind,
  }))

type Row = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

const infoCache = new WeakMap<object, Promise<ServerInfo>>()

/** Product and version of the target (cached per pool). */
export function serverInfoOf(pool: TargetPool): Promise<ServerInfo> {
  let p = infoCache.get(pool)
  if (!p) {
    p = pool.query(fx.SELECT_VERSION).then(([rows]) => {
      const r = (rows as Row[])[0] ?? {}
      return parseServerInfo(str(r.v), str(r.c))
    })
    p.catch(() => infoCache.delete(pool))
    infoCache.set(pool, p)
  }
  return p
}

async function sqlModeOf(pool: TargetPool): Promise<string> {
  const [rows] = await pool.query(fx.SELECT_SQL_MODE)
  return str(((rows as Row[])[0] ?? {}).m)
}

// ---- Split and classify (FR-SQL-003..006) --------------------------------------------------------------

export type Prepared = {
  /** Non-empty statements with offsets into the full input text. */
  statements: ClassifiedStatement[]
  /** The text that is run (the selection or the whole text). */
  runText: string
  maxClass: StatementClass
  info: ServerInfo
}

function analyse(
  slice: string,
  base: number,
  opts: { noBackslashEscapes?: boolean; ansiQuotes?: boolean },
  info: ServerInfo,
  parserOk: boolean,
): ClassifiedStatement[] {
  const split = splitSql(slice, opts)
  const err = split.errors[0]
  if (err) {
    throw new StructureRefusal(
      err.code,
      `${err.code === 'unterminated-string' ? 'Unterminated string' : 'Unterminated comment'}; nothing was run`,
      err.at + base,
    )
  }
  const shifted = split.statements
    .filter((s) => !s.flags.empty)
    .map((s) => ({ ...s, start: s.start + base, end: s.end + base }))
  return classifyBatch(shifted, { server: info, lex: opts }, parserOk)
}

function guardStatements(env: SqlRunEnv, list: ClassifiedStatement[]): void {
  // Layer 1 of FR-SQL-007: every statement that is not a safe read needs a writable connection.
  if (list.some((s) => !s.classification.readOnlySafe)) assertWritable(env.guard)
}

/**
 * Splits and classifies on the server from the text (FR-SQL-001). On a read-only connection the refusal comes
 * first, before the pool is touched; the text is then analysed again with the session's `sql_mode`.
 */
export async function prepareText(
  env: SqlRunEnv,
  text: string,
  range: { from: number; to: number } | undefined,
  opts: { requireWritable?: boolean; limits?: SqlLimits; skipGuard?: boolean } = {},
): Promise<Prepared> {
  const from = range?.from ?? 0
  const to = range?.to ?? text.length
  if (from > to || to > text.length) throw new StructureRefusal('invalid_request', 'Invalid range')
  const slice = text.slice(from, to)
  const pool = env.session.pool
  const readOnly = isReadOnly(env.guard)
  const parserOk = await readyClassifier()
  if (opts.requireWritable) assertWritable(env.guard)
  if (readOnly && !opts.skipGuard) {
    // Before any connection: a default-split pass is enough to refuse (no pool access).
    const pre = analyse(slice, from, {}, { product: 'mysql', version: '' }, parserOk)
    guardStatements(env, pre)
  }
  const info = await serverInfoOf(pool)
  const mode = await sqlModeOf(pool)
  const statements = analyse(
    slice,
    from,
    {
      noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(mode),
      ansiQuotes: /ANSI_QUOTES/i.test(mode),
    },
    info,
    parserOk,
  )
  if (statements.length === 0) throw new StructureRefusal('empty', 'There is nothing to run')
  const max = (opts.limits ?? env.limits).maxStatements
  if (statements.length > max) {
    throw new StructureRefusal('too_many_statements', `A run may have at most ${max} statements`)
  }
  if (readOnly && !opts.skipGuard) guardStatements(env, statements)
  let maxClass: StatementClass = 'none'
  for (const s of statements) maxClass = maxOf(maxClass, s.classification.class)
  return { statements, runText: slice, maxClass, info }
}

// ---- Entry points (FR-SQL-008) --------------------------------------------------------------------------

/** The full text for the confirm dialog (affected-rows estimate); absent above 64 KiB. */
export const fullOf = (text: string): { fullSql?: string } =>
  text.length <= MAX_FULL_SQL ? { fullSql: text } : {}

function planStatements(p: Prepared, options: SqlRunOptions): SqlPlanStatement[] {
  const out: SqlPlanStatement[] = p.statements
    .map((s, index) => ({
      index,
      sql: display(s.text),
      ...fullOf(s.text),
      class: s.classification.class,
      reasons: s.classification.reasons,
    }))
    .filter((s) => s.class !== 'none')
  if (options.disableForeignKeyChecks) {
    out.push({ index: -1, sql: fx.SET_FK_CHECKS_OFF, class: 'hard', reasons: [] })
  }
  return out
}

function refusalOutcome(env: SqlRunEnv, runId: string, count: number, code: string, text: string) {
  auditSqlRun({
    user: env.session.target.username,
    target: targetLabel(env.session.target),
    runId,
    statements: count,
    maxClass: 'none',
    outcome: 'refused',
    code,
  })
  safeHistory(env, {
    text,
    db: null,
    statements: count,
    executed: 0,
    failedIndex: null,
    maxClass: 'none',
    outcome: 'refused',
    durationMs: 0,
  })
}

function safeHistory(env: SqlRunEnv, record: SqlHistoryRecord): void {
  try {
    env.recordHistory?.(record)
  } catch {
    // a history failure never fails the run (FR-SQL-017)
  }
}

/**
 * Plain function behind `runSql`: split and classify, guard, then run (class none, or soft without the user
 * preference) or answer `confirm` with a stored plan (and a token for hard).
 */
export async function runSqlText(env: SqlRunEnv, input: RunSqlInput): Promise<SqlRunResponse> {
  const plans = env.plans ?? defaultPlanStore
  const options = input.options
  try {
    let prepared: Prepared
    try {
      prepared = await prepareText(env, input.text, input.range, {
        // The FK option is a write intent of its own.
        requireWritable: options.disableForeignKeyChecks,
      })
    } catch (error) {
      if (error instanceof WriteGuardError) {
        refusalOutcome(env, input.runId, 0, error.code, '')
      }
      throw error
    }
    let maxClass = prepared.maxClass
    if (options.disableForeignKeyChecks) maxClass = 'hard'

    const needsConfirm = maxClass === 'hard' || (maxClass === 'soft' && options.confirmSoft)
    if (!needsConfirm) {
      return await executeRun(env, {
        runId: input.runId,
        source: 'user',
        prepared,
        fullText: input.text,
        db: input.db,
        options,
        maxClass,
      })
    }

    const statements = asStatements(prepared.statements)
    const statementsHash = hashStatements(statements)
    const payload: RunPayload = {
      v: 1,
      type: 'sql-run',
      text: input.text,
      ...(input.range ? { range: input.range } : {}),
      ...(input.db !== undefined ? { db: input.db } : {}),
      options,
      maxClass,
    }
    const stored = plans.create(env.session.idHash, {
      statements,
      warnings: [],
      statementsHash,
      ...(input.db !== undefined ? { db: input.db } : {}),
      payload,
    })
    const response: SqlRunResponse = {
      kind: 'confirm',
      runId: input.runId,
      planId: stored.planId,
      statements: planStatements(prepared, options),
      totalStatements: prepared.statements.length,
      maxClass,
      confirmRequired: maxClass === 'hard',
      expiresAt: stored.expiresAt,
    }
    if (maxClass === 'hard') {
      response.confirmToken = env.tokens.issue({
        sessionId: env.session.idHash,
        target: targetLabel(env.session.target),
        planId: stored.planId,
        statementsHash,
        expiresAt: stored.expiresAt,
      })
    }
    return response
  } catch (error) {
    throw toClientError(error)
  }
}

/** Second call: runs a stored plan after the checks (token for hard, same text, writable). */
export async function confirmSqlRun(
  env: SqlRunEnv,
  input: ConfirmSqlInput,
): Promise<SqlRunResponse> {
  const plans = env.plans ?? defaultPlanStore
  const { session } = env
  const target = targetLabel(session.target)
  const plan = plans.get(session.idHash, input.planId)
  const payload = plan ? asPayload(plan) : undefined
  const refuse = (code: string): void => {
    auditSqlRun({
      user: session.target.username,
      target,
      runId: input.runId,
      statements: plan?.statements.length ?? 0,
      maxClass: payload?.maxClass ?? 'none',
      outcome: 'refused',
      code,
    })
  }
  try {
    let prepared: Prepared
    try {
      if (!plan || !payload) {
        throw new StructureRefusal('plan_expired', 'The plan has expired or does not exist')
      }
      prepared = await prepareText(env, payload.text, payload.range, {
        requireWritable: payload.options.disableForeignKeyChecks,
      })
      // The text must still split into exactly the statements that were shown (SEC-TGT-052).
      if (hashStatements(asStatements(prepared.statements)) !== plan.statementsHash) {
        throw new StructureRefusal('plan_stale', 'The statements changed; review again')
      }
      if (payload.maxClass === 'hard') {
        env.tokens.verifyAndConsume(input.confirmToken, {
          sessionId: session.idHash,
          target,
          planId: plan.planId,
          statementsHash: plan.statementsHash,
        })
      }
    } catch (error) {
      refuse(
        error instanceof WriteGuardError || error instanceof StructureRefusal
          ? error.code
          : 'error',
      )
      throw error
    }
    plans.consume(plan!.planId) // spent from here on, whatever happens
    return await executeRun(env, {
      runId: input.runId,
      source: 'user',
      prepared,
      fullText: payload!.text,
      db: payload!.db,
      options: payload!.options,
      maxClass: payload!.maxClass,
    })
  } catch (error) {
    throw toClientError(error)
  }
}

function asPayload(plan: StoredPlan): RunPayload | undefined {
  const p = plan.payload as Partial<RunPayload> | undefined
  if (!p || p.v !== 1 || p.type !== 'sql-run' || typeof p.text !== 'string' || !p.options)
    return undefined
  return p as RunPayload
}

// ---- Connection setup (FR-SQL-014) -----------------------------------------------------------------------

export type SetupOptions = {
  readOnly: boolean
  timeoutMs: number
  product: Product
  db?: string
  disableForeignKeyChecks?: boolean
  singleTransaction?: boolean
}

/** Setup order of FR-SQL-014, from fixed templates only. A failure here is a refusal (`setup_failed`). */
export async function setupConnection(conn: PoolConnection, o: SetupOptions): Promise<void> {
  try {
    if (o.readOnly) await conn.query(fx.SET_READ_ONLY)
    await conn.query(fx.setTimeoutVariable(o.product, o.timeoutMs))
    if (o.db !== undefined) {
      const [rows] = await conn.query(fx.SCHEMA_EXISTS, [o.db])
      if ((rows as unknown[]).length === 0) {
        throw new StructureRefusal('not_found', 'The selected database does not exist')
      }
      await conn.query(fx.useDatabase(o.db))
    }
    if (o.disableForeignKeyChecks) await conn.query(fx.SET_FK_CHECKS_OFF)
    if (o.singleTransaction) await conn.query(fx.START_TRANSACTION)
  } catch (error) {
    if (error instanceof StructureRefusal) throw error
    const mapped = mapMysqlError(error)
    throw new StructureRefusal('setup_failed', mapped.message)
  }
}

// ---- Streaming --------------------------------------------------------------------------------------------

type CoreQuery = {
  on(event: string, handler: (...args: never[]) => void): CoreQuery
}
type CoreConnection = { query(options: { sql: string; rowsAsArray: boolean }): CoreQuery }
type FieldPacket = { name: string; columnType: number; characterSet: number; table?: string }
type OkPacket = {
  affectedRows?: unknown
  insertId?: unknown
  info?: unknown
  warningStatus?: unknown
  serverStatus?: unknown
}

const TYPE_NAMES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
}

function columnMeta(f: FieldPacket): SqlColumnMeta {
  let type = TYPE_NAMES[f.columnType] ?? 'unknown'
  const binary = f.characterSet === 63
  if (f.columnType >= 249 && f.columnType <= 252 && !binary) type = type.replace('blob', 'text')
  else if (f.columnType === 253 && binary) type = 'varbinary'
  else if (f.columnType === 254 && binary) type = 'binary'
  return { name: f.name, type, ...(f.table ? { table: f.table } : {}) }
}

/** One cell as the browser may see it: text, cut text with its length, or a binary summary (SEC-TGT-070). */
export function toCell(value: unknown, cellBytes: number): { cell: Cell; bytes: number } {
  if (value === null || value === undefined) return { cell: null, bytes: 4 }
  if (Buffer.isBuffer(value)) {
    return {
      cell: { binary: value.subarray(0, 32).toString('hex'), size: value.length },
      bytes: 80,
    }
  }
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as number | boolean | bigint)
  // Cheap bound first: UTF-8 needs at most 4 bytes per UTF-16 unit.
  if (text.length * 4 <= cellBytes || Buffer.byteLength(text, 'utf8') <= cellBytes) {
    return {
      cell: text,
      bytes: text.length * 4 <= cellBytes ? text.length + 4 : Buffer.byteLength(text, 'utf8') + 4,
    }
  }
  let cut = text.slice(0, cellBytes)
  while (Buffer.byteLength(cut, 'utf8') > cellBytes)
    cut = cut.slice(0, Math.floor(cut.length * 0.9))
  return { cell: { cut, length: text.length }, bytes: Buffer.byteLength(cut, 'utf8') + 16 }
}

type SetAcc = { columns: SqlColumnMeta[]; rows: Cell[][]; truncated?: SqlTruncation }
type OkInfo = {
  affectedRows: number
  insertId?: string
  info?: string
  warningCount: number
  serverStatus: number
}
export type StreamOutcome = {
  sets: SetAcc[]
  ok?: OkInfo
  error?: unknown
  /** True when the reader ended the statement with `KILL QUERY` because of a cap. */
  capKilled: boolean
}

/** Bytes used so far in a run (the byte cap is shared by all result sets, FR-SQL-010). */
export type ByteBudget = { used: number }

/**
 * Reads one statement with the core connection's events. Rows are converted one by one; rows after a cap are
 * dropped (the kill needs a moment to land). Never buffers more than the caps allow.
 */
export function streamStatement(
  conn: PoolConnection,
  sql: string,
  limits: Pick<SqlLimits, 'rowCap' | 'responseBytes' | 'cellBytes'>,
  budget: ByteBudget,
  watchdog: Watchdog,
): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    const out: StreamOutcome = { sets: [], capKilled: false }
    let current: SetAcc | undefined
    let capped = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(out)
    }
    const cap = (reason: 'rows' | 'bytes', limit: number) => {
      if (current) current.truncated = { reason, limit }
      capped = true
      out.capKilled = true
      void watchdog.kill()
    }
    const core = (conn as unknown as { connection: CoreConnection }).connection
    const q = core.query({ sql, rowsAsArray: true })
    q.on('fields', ((fields: FieldPacket[] | undefined) => {
      if (capped || !fields) {
        current = undefined
        return
      }
      current = { columns: fields.map(columnMeta), rows: [] }
      out.sets.push(current)
    }) as never)
    q.on('result', ((row: unknown) => {
      if (!Array.isArray(row)) {
        const ok = (row ?? {}) as OkPacket
        const insertId = ok.insertId == null ? '' : String(ok.insertId)
        const info = ok.info == null ? '' : String(ok.info)
        out.ok = {
          affectedRows: Number(ok.affectedRows ?? 0),
          ...(insertId !== '' && insertId !== '0' ? { insertId } : {}),
          ...(info !== '' ? { info } : {}),
          warningCount: Number(ok.warningStatus ?? 0),
          serverStatus: Number(ok.serverStatus ?? 0),
        }
        return
      }
      if (capped || !current) return
      if (current.rows.length >= limits.rowCap) {
        cap('rows', limits.rowCap)
        return
      }
      const cells: Cell[] = new Array<Cell>(row.length)
      let bytes = 8
      for (let i = 0; i < row.length; i++) {
        const c = toCell(row[i], limits.cellBytes)
        cells[i] = c.cell
        bytes += c.bytes
      }
      if (budget.used + bytes > limits.responseBytes) {
        cap('bytes', limits.responseBytes)
        return
      }
      budget.used += bytes
      current.rows.push(cells)
    }) as never)
    q.on('error', ((error: unknown) => {
      out.error = error
      if ((error as { fatal?: unknown })?.fatal === true) finish()
    }) as never)
    q.on('end', finish as never)
  })
}

async function readWarnings(conn: PoolConnection): Promise<SqlWarning[]> {
  try {
    const [rows] = await conn.query(fx.SHOW_WARNINGS)
    return (rows as Row[]).slice(0, MAX_WARNINGS).map((r) => ({
      level: str(r.Level),
      code: Number(r.Code) || 0,
      message: str(r.Message),
    }))
  } catch {
    return []
  }
}

// ---- The run -----------------------------------------------------------------------------------------------

export type ExecArgs = {
  runId: string
  source: 'user' | 'assistant'
  prepared: Prepared
  fullText: string
  db?: string
  options: SqlRunOptions
  maxClass: StatementClass
  /** Read-only is forced for this run regardless of the session (assistant, export). */
  forceReadOnly?: boolean
  /** Lower caps for this run (assistant inline cap). */
  limits?: Partial<SqlLimits>
}

type DoneResponse = Extract<SqlRunResponse, { kind: 'done' }>

const timeoutError = (ms: number): StructureError => ({
  errno: 3024,
  code: 'timeout',
  message: `Stopped after ${ms >= 1000 ? Math.round(ms / 100) / 10 : ms / 1000} s (time limit)`,
  hint: 'The statement ran longer than the time limit and was stopped.',
})
const cancelledError = (): StructureError => ({
  errno: 1317,
  code: 'cancelled',
  message: 'Cancelled by you',
})

const STRUCTURE_KINDS = new Set(['createObject', 'dropObject', 'alterObject', 'renameObject'])

/** Changes a statement made, from the classifier's facts (the connection's database is the default). */
export function changesOf(
  c: ClassifiedStatement['classification'],
  defaultDb?: string,
): SqlChange[] {
  const out: SqlChange[] = []
  for (const name of c.databases ?? []) out.push({ db: name, database: true })
  for (const t of c.tables ?? []) {
    const db = t.db ?? defaultDb
    out.push({ ...(db ? { db } : {}), table: t.table })
  }
  if (out.length === 0 && defaultDb) out.push({ db: defaultDb })
  return out
}

export async function executeRun(env: SqlRunEnv, a: ExecArgs): Promise<DoneResponse> {
  const { pool } = env.session
  const limits: SqlLimits = { ...env.limits, ...a.limits }
  const registry = env.registry ?? runRegistry
  const user = env.session.target.username
  const target = targetLabel(env.session.target)
  const statements = a.prepared.statements
  const readOnly = isReadOnly(env.guard) || a.forceReadOnly === true
  const continueOnError = a.options.continueOnError && !a.options.singleTransaction
  const runStarted = Date.now()

  const handle: RunHandle = registry.begin(env.session.idHash, a.runId, limits.maxConcurrentRuns)
  // Client gone: same path as the Cancel button (flag for the loop, KILL QUERY when the thread is known).
  const onAbort = (): void => {
    void registry.cancel(pool, env.session.idHash, a.runId)
  }
  if (env.signal?.aborted) onAbort()
  else env.signal?.addEventListener('abort', onAbort, { once: true })
  let conn: PoolConnection | undefined
  const results: SqlStatementResult[] = []
  const notes: string[] = []
  const changed: SqlChange[] = []
  let outcome: SqlHistoryRecord['outcome'] = 'ok'
  let failedIndex: number | null = null
  let executed = 0
  let stop = false
  let usedDb: string | undefined
  let useRan = false
  let lastServerStatus = 0
  let anyFailure = false

  try {
    conn = await pool.getConnection()
    handle.threadId = conn.threadId
    await setupConnection(conn, {
      readOnly,
      timeoutMs: limits.timeoutMs,
      product: a.prepared.info.product,
      db: a.db,
      disableForeignKeyChecks: a.options.disableForeignKeyChecks,
      singleTransaction: a.options.singleTransaction,
    })
    if (a.options.disableForeignKeyChecks) notes.push('Foreign key checks were off for this run.')

    const budget: ByteBudget = { used: 0 }
    for (const [index, stmt] of statements.entries()) {
      const c = stmt.classification
      if (!stop && handle.cancelRequested) {
        stop = true
        outcome = 'cancelled'
      }
      if (stop) {
        results.push({ status: 'not-run', index, sql: display(stmt.text) })
        audit(index, stmt, 'not-run')
        continue
      }
      const started = Date.now()
      const wd = startWatchdog(pool, conn, limits.timeoutMs)
      let out: StreamOutcome
      try {
        out = await streamStatement(conn, stmt.text, limits, budget, wd)
      } finally {
        await wd.stop()
      }
      const durationMs = Date.now() - started
      const fatal = (out.error as { fatal?: unknown } | undefined)?.fatal === true

      let failure: StructureError | undefined
      let kind: 'timeout' | 'cancelled' | 'error' | undefined
      if (wd.timedOut) {
        failure = timeoutError(limits.timeoutMs)
        kind = 'timeout'
      } else if (handle.cancelRequested) {
        failure = cancelledError()
        kind = 'cancelled'
      } else if (out.error && !out.capKilled) {
        failure = mapMysqlError(out.error, index)
        const message = (out.error as { sqlMessage?: unknown }).sqlMessage
        if (typeof message === 'string' && /\bat line \d+\s*$/.test(message)) {
          const pos = positionOf(message, stmt.start, a.fullText)
          failure = {
            ...failure,
            position: relativePosition(a.fullText, stmt.start, pos.offset),
          } as StructureError
        }
        kind = 'error'
      }

      if (failure && kind) {
        anyFailure = true
        failedIndex ??= index
        if (kind === 'timeout' && outcome !== 'cancelled') outcome = 'timeout'
        else if (kind === 'cancelled') outcome = 'cancelled'
        else if (outcome === 'ok') outcome = 'failed'
        results.push({
          status: 'failed',
          index,
          sql: display(stmt.text),
          error: failure,
          durationMs,
        })
        audit(
          index,
          stmt,
          kind === 'error' ? 'failed' : kind,
          failure.errno ?? undefined,
          durationMs,
        )
        let usable = !fatal
        if (usable && kind === 'timeout') {
          usable = await conn.query('SELECT 1').then(
            () => true,
            () => false,
          )
        }
        if (!usable || kind === 'cancelled' || !continueOnError) stop = true
        if (!usable) {
          conn.destroy()
          conn = undefined
          notes.push('The connection was lost; the remaining statements were not run.')
        }
        if (!conn) {
          // Nothing more can run.
          for (let j = index + 1; j < statements.length; j++) {
            results.push({ status: 'not-run', index: j, sql: display(statements[j]!.text) })
            audit(j, statements[j]!, 'not-run')
          }
          break
        }
        continue
      }

      // Success (possibly cut by a cap).
      executed++
      if (out.ok) lastServerStatus = out.ok.serverStatus
      const warningsWanted =
        !out.capKilled &&
        c.kind !== 'show' &&
        (out.sets.length > 0 || (out.ok?.warningCount ?? 0) > 0)
      const warnings = warningsWanted ? await readWarnings(conn) : []
      const entries: SqlStatementResult[] = []
      for (const set of out.sets) {
        entries.push({
          status: 'rows',
          index,
          sql: display(stmt.text),
          columns: set.columns,
          rows: set.rows,
          rowCount: set.rows.length,
          ...(set.truncated ? { truncated: set.truncated } : {}),
          warnings: [],
          durationMs,
        })
      }
      if (out.ok || entries.length === 0) {
        entries.push({
          status: 'ok',
          index,
          sql: display(stmt.text),
          affectedRows: out.ok?.affectedRows ?? 0,
          ...(out.ok?.insertId ? { insertId: out.ok.insertId } : {}),
          ...(out.ok?.info ? { info: out.ok.info } : {}),
          warnings: [],
          durationMs,
        })
      }
      const lastEntry = entries[entries.length - 1]
      if (lastEntry && (lastEntry.status === 'rows' || lastEntry.status === 'ok')) {
        lastEntry.warnings = warnings
      }
      results.push(...entries)
      audit(index, stmt, 'executed', undefined, durationMs, out.ok?.affectedRows)
      if (c.kind === 'use') useRan = true
      if (STRUCTURE_KINDS.has(c.kind) || c.kind === 'truncate') {
        const list = changesOf(c, a.db)
        changed.push(...list)
        if (c.kind !== 'truncate') {
          for (const ch of list) {
            structureEvents.emit('changed', {
              ...(ch.db ? { db: ch.db } : {}),
              ...(ch.table ? { table: ch.table } : {}),
            })
          }
        }
      }
    }

    if (conn) {
      if (a.options.singleTransaction) {
        const commit = !anyFailure && !stop
        try {
          await conn.query(commit ? fx.COMMIT : fx.ROLLBACK)
          notes.push(commit ? 'The transaction was committed.' : 'The transaction was rolled back.')
        } catch {
          notes.push('The transaction could not be finished; it ends with the connection.')
        }
        if (statements.some((s) => s.classification.commitsImplicitly)) {
          notes.push(
            'Some statements end a transaction implicitly (DDL, LOCK TABLES); earlier changes stay.',
          )
        }
      } else if ((lastServerStatus & 1) !== 0) {
        notes.push(
          'A transaction was left open by the text; it was rolled back when the connection closed.',
        )
      }
      if (useRan) {
        try {
          const [rows] = await conn.query(fx.SELECT_DATABASE)
          const d = ((rows as Row[])[0] ?? {}).d
          usedDb = typeof d === 'string' ? d : undefined
        } catch {
          usedDb = undefined
        }
      }
    }
  } finally {
    // Never returned to the pool: no state, lock or open transaction can leak (FR-SQL-014).
    env.signal?.removeEventListener('abort', onAbort)
    conn?.destroy()
    registry.finish(handle)
    auditSqlRun({
      user,
      target,
      runId: a.runId,
      statements: statements.length,
      maxClass: a.maxClass,
      outcome,
      source: a.source,
      durationMs: Date.now() - runStarted,
    })
    safeHistory(env, {
      text: a.prepared.runText,
      db: a.db ?? null,
      statements: statements.length,
      executed,
      failedIndex,
      maxClass: a.maxClass,
      outcome,
      durationMs: Date.now() - runStarted,
      source: a.source,
    })
  }
  return {
    kind: 'done',
    runId: a.runId,
    ok: !anyFailure,
    results,
    ...(useRan ? { db: usedDb } : {}),
    notes,
    ...(changed.length > 0 ? { changed } : {}),
  }

  function audit(
    index: number,
    stmt: ClassifiedStatement,
    result: 'executed' | 'failed' | 'cancelled' | 'timeout' | 'not-run',
    errno?: number,
    durationMs?: number,
    affectedRows?: number,
  ): void {
    const c = stmt.classification
    if (c.class === 'none' && c.readOnlySafe) return
    auditSqlStatement({
      user,
      target,
      runId: a.runId,
      index,
      kind: c.kind,
      class: c.class,
      statementHash: sqlHash(stmt.text),
      outcome: result,
      ...(errno !== undefined ? { errno } : {}),
      ...(affectedRows !== undefined ? { affectedRows } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    })
  }
}

export const asRows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : []
