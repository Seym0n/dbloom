import { createHash } from 'node:crypto'
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type { TargetPool } from '../db/target-pool'
import { startWatchdog } from '../guard/statement-timeout'
import { WriteGuardError } from '../guard/write-guard'
import { mapMysqlError } from '../structure/errors'
import type { SqlWarning } from '../sql/types'
import type { CellValue } from './codecs'
import type {
  BuiltStatement,
  Cell,
  FilterNode,
  GuardValue,
  Identity,
  LookupOption,
  PlanWarning,
  RowChange,
  RowClassReason,
  RowOutcome,
  RowsError,
  RowTable,
  RowTarget,
  SearchInput,
  SortEntry,
  StatementClass,
  WireValue,
} from './types'

/**
 * Execution layer of module rows: ports to package A (catalog model, builder, classes), prepared-statement
 * runner with a watchdog, the write executor (transaction, conflict check, re-read, warnings) and the chunked
 * cell reader. Everything here takes the pool and the ports explicitly, so tests can drive it without HTTP.
 */

// ---- Ports (the surface this package needs from package A) ------------------------------------------------------

/**
 * A read statement plus the decoder of its result rows. `decode` turns the raw rows (arrays, as the driver
 * returns them for the projection the builder chose) into grid cells and the digests of columns that are
 * compared by digest (FR-ROW-005); one entry of `digests` per row, by column name.
 */
export type ReadStatement = BuiltStatement & {
  columns: string[]
  kinds?: ('number' | 'temporal' | 'text')[]
  decode(rows: unknown[][]): { rows: Cell[][]; digests: Record<string, string>[] }
}

export type LookupStatement = {
  statement: BuiltStatement
  decode(rows: unknown[][]): { options: LookupOption[]; hasNext: boolean }
}

export type CellReadStatement = {
  statement: BuiltStatement
  /** `undefined` when the row does not exist. */
  decode(rows: unknown[][]): { value: CellValue; digest?: string } | undefined
}

export type CellSizeStatement = {
  statement: BuiltStatement
  /** Byte length of the stored value; `null` for NULL; `undefined` when the row does not exist. */
  decode(rows: unknown[][]): number | null | undefined
}

export type ClassResult = {
  maxClass: StatementClass
  reasons: RowClassReason[]
  warnings: PlanWarning[]
  cascadeTables: { db: string; table: string; fk: string }[]
}

/** Looks up the bytes of a staged upload (`{t:'bin'}` values); `undefined` for a miss. */
export type UploadBytes = (uploadId: string) => Buffer | undefined

export type RowsPorts = {
  /** The catalog model, or `undefined` when the table does not exist (FR-ROW-002). */
  loadRowTable(pool: TargetPool, db: string, table: string): Promise<RowTable | undefined>
  /** Advisory privileges written into the model's columns (FR-ROW-022); `delete` is the table-level DELETE. */
  readPrivileges?(pool: TargetPool, table: RowTable): Promise<{ table: RowTable; delete: boolean }>
  identityFor(table: RowTable): Identity
  /** Up to `pageSize + 1` rows of page `page`, ordered by the sort list plus the identity tie-break. */
  buildPage(
    table: RowTable,
    identity: Identity,
    q: {
      page: number
      pageSize: number
      sort: SortEntry[]
      filter?: FilterNode
      search?: SearchInput
      cellBytes: number
    },
  ): ReadStatement
  /** `COUNT(*)` of the filtered rows; with `cap` the capped form `COUNT(*) FROM (SELECT 1 ... LIMIT cap+1)`. */
  buildCount(
    table: RowTable,
    q: { filter?: FilterNode; search?: SearchInput; cap?: number },
  ): BuiltStatement
  buildRow(
    table: RowTable,
    identity: Identity,
    key: Record<string, GuardValue>,
    q: { cellBytes: number; includeInvisible?: boolean },
  ): ReadStatement
  buildCellRead(
    table: RowTable,
    identity: Identity,
    key: Record<string, GuardValue>,
    column: string,
    maxBytes: number,
  ): CellReadStatement
  buildCellSize(
    table: RowTable,
    identity: Identity,
    key: Record<string, GuardValue>,
    column: string,
  ): CellSizeStatement
  /** `length` bytes from byte offset `offset` (0-based) of the stored value, one raw Buffer column. */
  buildCellChunk(
    table: RowTable,
    identity: Identity,
    key: Record<string, GuardValue>,
    column: string,
    offset: number,
    length: number,
  ): BuiltStatement
  buildLookup(
    refTable: RowTable,
    q: {
      keyColumns: string[]
      displayColumns: string[]
      query?: string
      page: number
      pageSize: number
      keys?: Record<string, GuardValue>[]
    },
  ): LookupStatement
  buildInsert(
    table: RowTable,
    row: Record<string, WireValue>,
    ignore: boolean,
    bytes: UploadBytes,
  ): BuiltStatement
  buildUpdate(
    table: RowTable,
    identity: Identity,
    target: RowTarget,
    set: Record<string, WireValue>,
    bytes: UploadBytes,
  ): BuiltStatement
  buildDelete(
    table: RowTable,
    identity: Identity,
    target: RowTarget,
    bytes: UploadBytes,
  ): BuiltStatement
  /** `SELECT COUNT(*)` of the rows an `all-columns` target would match (G1). */
  buildMatchCount(table: RowTable, identity: Identity, target: RowTarget): BuiltStatement
  classify(table: RowTable, change: RowChange, identity: Identity): ClassResult
}

// ---- Prepared statements with a watchdog -----------------------------------------------------------------------

export type Raw = { rows: unknown[][] } | { header: ResultSetHeader }

/**
 * Runs one built statement on a dedicated connection as a server-side prepared statement (`execute`, Q1),
 * under the statement timeout: the watchdog sends `KILL QUERY` from a second connection; a late answer after
 * the limit is still reported as a timeout. The values are never interpolated by the driver.
 */
export async function runPrepared(
  pool: TargetPool,
  connection: PoolConnection,
  timeoutMs: number,
  stmt: { sql: string; params: unknown[] },
): Promise<Raw> {
  const wd = startWatchdog(pool, connection, timeoutMs)
  let outcome: Raw | undefined
  let failure: unknown
  try {
    const [result] = await connection.execute({
      sql: stmt.sql,
      values: stmt.params as never,
      rowsAsArray: true,
    })
    outcome = Array.isArray(result)
      ? { rows: result as unknown as unknown[][] }
      : { header: result as ResultSetHeader }
  } catch (error) {
    failure = error
  }
  await wd.stop()
  if (wd.timedOut) {
    const err = new WriteGuardError(
      'timeout',
      'The statement exceeded the time limit and was cancelled.',
    )
    err.connectionUsable = await connection.query('SELECT 1').then(
      () => true,
      () => false,
    )
    throw err
  }
  if (failure !== undefined) throw failure
  return outcome!
}

/** One read on its own connection (released afterwards, destroyed when the limit fired or it dropped). */
export async function readPrepared(
  pool: TargetPool,
  timeoutMs: number,
  stmt: { sql: string; params: unknown[] },
  hook?: (connection: PoolConnection) => void,
): Promise<unknown[][]> {
  const connection = await pool.getConnection()
  hook?.(connection)
  let destroy = false
  try {
    const raw = await runPrepared(pool, connection, timeoutMs, stmt)
    return 'rows' in raw ? raw.rows : []
  } catch (error) {
    if (isConnectionLost(error)) destroy = true
    throw error
  } finally {
    if (destroy) connection.destroy()
    else connection.release()
  }
}

export function isConnectionLost(error: unknown): boolean {
  const e = error as { fatal?: unknown; connectionUsable?: unknown }
  return e?.fatal === true || e?.connectionUsable === false
}

// ---- Values that guard rows ------------------------------------------------------------------------------------

/** Replaces large Buffers by their size and SHA-256, so the plan hash stays small and still binds the bytes. */
export function hashableParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (Buffer.isBuffer(p) && p.length > 1024) {
      return { $buffer: { size: p.length, sha256: sha256Hex(p) } }
    }
    return p
  })
}

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}

/** Names of the columns whose old value no longer matches the current row (FR-ROW-005). */
export function changedColumns(
  old: Record<string, GuardValue>,
  columns: string[],
  cells: Cell[],
  digests: Record<string, string>,
): string[] {
  const out: string[] = []
  for (const [name, guard] of Object.entries(old)) {
    const i = columns.indexOf(name)
    if (i < 0) continue
    const cell = cells[i] ?? null
    if (guard.t === 'digest') {
      if (digests[name] !== guard.v) out.push(name)
    } else if (guard.t === 'null') {
      if (cell !== null) out.push(name)
    } else if (typeof cell === 'string') {
      if (cell !== guard.v) out.push(name)
    } else if (cell === null) {
      out.push(name)
    } else if (digests[name] === undefined) {
      // a cut or binary cell cannot be compared in full without a digest; the server's refusal stands
      continue
    }
  }
  return out
}

/** Column named by a server message such as `Column 'x' cannot be null` or `... for column 'x' at row 1`. */
export function fieldOf(message: string, table: RowTable): string | undefined {
  const m = /column '((?:[^']|'')+)'/i.exec(message)
  if (!m) return undefined
  const name = m[1]!.replaceAll("''", "'")
  return table.columns.find((c) => c.name === name)?.name
}

// ---- Write executor --------------------------------------------------------------------------------------------

export type ExecItem = {
  /** Index into `targets` / `rows` of the request. */
  index: number
  op: 'insert' | 'update' | 'delete'
  statement: BuiltStatement
  /** Key and old values of an update or delete target (for the conflict answer). */
  target?: RowTarget
  /** Key of the row after the write, for the re-read (FR-ISS-110); `undefined` when it cannot be known. */
  afterKey?: (header: ResultSetHeader) => Record<string, GuardValue> | undefined
}

export type ExecEnv = {
  pool: TargetPool
  ports: RowsPorts
  table: RowTable
  identity: Identity
  statementTimeoutMs: number
  cellBytes: number
}

export type ExecOutput =
  | {
      kind: 'done'
      outcomes: RowOutcome[]
      affectedRows: number
      warnings: SqlWarning[]
      columns: string[]
      rows: Cell[][]
      durationMs: number
    }
  | {
      kind: 'conflict'
      index: number
      columns: string[]
      current: Cell[]
      digests: Record<string, string>
      changed: string[]
      outcomes: RowOutcome[]
      durationMs: number
    }
  | { kind: 'gone'; index: number; outcomes: RowOutcome[]; durationMs: number }
  | {
      kind: 'error'
      error: RowsError
      outcomes: RowOutcome[]
      known: boolean
      durationMs: number
    }

const MAX_WARNINGS = 50

/**
 * Runs the statements of one change on one connection (FR-ROW-023): `START TRANSACTION` when there is more than
 * one statement, a found-rows check on every update and delete, a re-read to tell `conflict` from `gone`, a
 * rollback on any failure (transactional engines), warnings after each statement and a re-read of the written
 * rows by identity. A connection whose state is unknown is destroyed, never returned to the pool.
 */
export async function runChange(env: ExecEnv, items: ExecItem[]): Promise<ExecOutput> {
  const started = Date.now()
  const { pool, ports, table, identity } = env
  const connection = await pool.getConnection()
  const outcomes: RowOutcome[] = []
  const warnings: SqlWarning[] = []
  const keys: { index: number; key: Record<string, GuardValue> }[] = []
  const transactional = items.length > 1
  let inTransaction = false
  let destroy = false
  let affectedTotal = 0

  const markBefore = (status: RowOutcome['status']) => {
    for (const o of outcomes) if (o.status === 'applied') o.status = status
  }
  const rest = (from: number) => {
    for (let i = from; i < items.length; i++) {
      outcomes.push({ index: items[i]!.index, status: 'not-run' })
    }
  }
  const finishTx = async (commit: boolean): Promise<void> => {
    if (!inTransaction) return
    inTransaction = false
    try {
      await connection.query(commit ? 'COMMIT' : 'ROLLBACK')
    } catch {
      destroy = true
    }
  }

  try {
    if (transactional) {
      await connection.query('START TRANSACTION')
      inTransaction = true
    }
    for (const [position, item] of items.entries()) {
      let raw: Raw
      try {
        raw = await runPrepared(pool, connection, env.statementTimeoutMs, item.statement)
      } catch (error) {
        if (isConnectionLost(error)) destroy = true
        const mapped = mapMysqlError(error)
        const field = fieldOf(mapped.message, table)
        const known = !(error as { fatal?: unknown }).fatal
        if (table.transactional) markBefore('rolled-back')
        await finishTx(false)
        outcomes.push({
          index: item.index,
          status: 'failed',
          error: { ...mapped, ...(field ? { field } : {}), rowIndex: item.index },
        })
        rest(position + 1)
        return {
          kind: 'error',
          error: { ...mapped, ...(field ? { field } : {}), rowIndex: item.index },
          outcomes,
          known: known && !destroy,
          durationMs: Date.now() - started,
        }
      }
      const header = 'header' in raw ? raw.header : undefined
      const affected = Number(header?.affectedRows ?? 0)
      if (item.op !== 'insert' && affected === 0) {
        // Found-rows is zero: the row changed or vanished since the user saw it (G2).
        const lookup = await rereadForConflict(env, connection, item)
        if (table.transactional) markBefore('rolled-back')
        await finishTx(false)
        outcomes.push({ index: item.index, status: lookup.found ? 'conflict' : 'gone' })
        rest(position + 1)
        if (lookup.found) {
          const changed = changedColumns(
            item.target?.old ?? {},
            lookup.columns,
            lookup.cells,
            lookup.digests,
          )
          return {
            kind: 'conflict',
            index: item.index,
            columns: lookup.columns,
            current: lookup.cells,
            digests: lookup.digests,
            changed,
            outcomes,
            durationMs: Date.now() - started,
          }
        }
        return { kind: 'gone', index: item.index, outcomes, durationMs: Date.now() - started }
      }
      affectedTotal += affected
      const insertId =
        item.op === 'insert' && header && Number(header.insertId) > 0
          ? String(header.insertId)
          : undefined
      outcomes.push({
        index: item.index,
        status: 'applied',
        affectedRows: affected,
        ...(insertId !== undefined ? { insertId } : {}),
      })
      if (header && header.warningStatus > 0 && warnings.length < MAX_WARNINGS) {
        warnings.push(...(await readWarnings(connection, MAX_WARNINGS - warnings.length)))
      }
      const key = header ? item.afterKey?.(header) : undefined
      if (key) keys.push({ index: item.index, key })
    }
    await finishTx(true)
    if (destroy) {
      // COMMIT failed: it is not known whether the batch applied (G5).
      markBefore('rolled-back')
      return {
        kind: 'error',
        error: { errno: null, code: 'COMMIT_FAILED', message: 'Could not confirm the change' },
        outcomes,
        known: false,
        durationMs: Date.now() - started,
      }
    }

    // Re-read the written rows (FR-ISS-110); a failure here never turns a done write into an error.
    let columns: string[] = []
    const rows: Cell[][] = []
    for (const k of keys) {
      try {
        const read = ports.buildRow(table, identity, k.key, { cellBytes: env.cellBytes })
        const raw = await runPrepared(pool, connection, env.statementTimeoutMs, read)
        if ('rows' in raw && raw.rows.length > 0) {
          const decoded = read.decode(raw.rows)
          columns = read.columns
          if (decoded.rows[0]) rows.push(decoded.rows[0])
        }
      } catch (error) {
        if (isConnectionLost(error)) {
          destroy = true
          break
        }
      }
    }
    return {
      kind: 'done',
      outcomes,
      affectedRows: affectedTotal,
      warnings,
      columns,
      rows,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    // Failure outside a statement (START TRANSACTION, connection loss): nothing is known to have applied.
    destroy = true
    const mapped = mapMysqlError(error)
    return {
      kind: 'error',
      error: mapped,
      outcomes,
      known: false,
      durationMs: Date.now() - started,
    }
  } finally {
    if (inTransaction) await finishTx(false)
    if (destroy) connection.destroy()
    else connection.release()
  }
}

async function readWarnings(connection: PoolConnection, limit: number): Promise<SqlWarning[]> {
  try {
    const [rows] = await connection.query({ sql: 'SHOW WARNINGS', rowsAsArray: true })
    return (rows as unknown as unknown[][]).slice(0, limit).map((r) => ({
      level: String(r[0] ?? ''),
      code: Number(r[1] ?? 0),
      message: String(r[2] ?? ''),
    }))
  } catch {
    return []
  }
}

type ConflictRead =
  | { found: false }
  | { found: true; columns: string[]; cells: Cell[]; digests: Record<string, string> }

async function rereadForConflict(
  env: ExecEnv,
  connection: PoolConnection,
  item: ExecItem,
): Promise<ConflictRead> {
  if (!item.target) return { found: false }
  const read = env.ports.buildRow(env.table, env.identity, item.target.key, {
    cellBytes: env.cellBytes,
  })
  try {
    const raw = await runPrepared(env.pool, connection, env.statementTimeoutMs, read)
    const rows = 'rows' in raw ? raw.rows : []
    if (rows.length === 0) return { found: false }
    const decoded = read.decode(rows)
    return {
      found: true,
      columns: read.columns,
      cells: decoded.rows[0] ?? [],
      digests: decoded.digests[0] ?? {},
    }
  } catch {
    return { found: false }
  }
}

// ---- Chunked cell reads (FR-ROW-012: memory stays flat) ----------------------------------------------------------

export const CELL_CHUNK_BYTES = 1024 * 1024

/**
 * Yields the bytes of one stored value in chunks of at most `chunkBytes`, from one consistent snapshot, with
 * the statement timeout on every chunk. At most one chunk is held at a time; a consumer that stops early ends
 * the generator and the connection goes back to the pool.
 */
export async function* streamCell(
  env: Pick<ExecEnv, 'pool' | 'ports' | 'table' | 'identity' | 'statementTimeoutMs'>,
  key: Record<string, GuardValue>,
  column: string,
  size: number,
  chunkBytes: number = CELL_CHUNK_BYTES,
): AsyncGenerator<Buffer> {
  const { pool, ports, table, identity } = env
  const connection = await pool.getConnection()
  let destroy = false
  let open = false
  try {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
    open = true
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const want = Math.min(chunkBytes, size - offset)
      const stmt = ports.buildCellChunk(table, identity, key, column, offset, want)
      const raw = await runPrepared(pool, connection, env.statementTimeoutMs, stmt)
      const value = 'rows' in raw ? raw.rows[0]?.[0] : undefined
      if (!Buffer.isBuffer(value)) {
        throw new Error('The value changed or disappeared while it was read')
      }
      if (value.length === 0) break
      yield value
    }
  } catch (error) {
    if (isConnectionLost(error)) destroy = true
    throw error
  } finally {
    if (open && !destroy) {
      await connection.query('ROLLBACK').catch(() => {
        destroy = true
      })
    }
    if (destroy) connection.destroy()
    else connection.release()
  }
}
