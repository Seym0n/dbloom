import type { RowDataPacket } from 'mysql2/promise'
import { defaultPorts as boundPorts } from './default-ports'
import { audit, auditRowsChange, auditRowsRefused } from '../audit'
import type { TargetPool } from '../db/target-pool'
import {
  assertWritable,
  createTokenIssuer,
  hashStatements,
  type TokenIssuer,
} from '../structure/deps'
import { WriteGuardError } from '../guard/write-guard'
import { getRuntime } from '../runtime'
import type { LiveSession } from '../sessions'
import { isStateless, ownerKeyFor } from '../sql/state'
import { RunRegistry } from '../sql/registry'
import { mapMysqlError, StructureRefusal, toClientError } from '../structure/errors'
import { planStore as defaultPlans, type PlanStore, type StoredPlan } from '../structure/plans'
import { BuildRefusal, type GuardContext, type Statement } from '../structure/types'
import { RowValueError } from './codecs'
import {
  cellHandles as defaultHandles,
  CONTENT_TYPES,
  PREVIEW_MAX_BYTES,
  safeFileName,
  sniffPreviewType,
  uploads as defaultUploads,
  UploadRefusal,
  type CellHandleStore,
  type UploadStore,
} from './blob'
import {
  hashableParams,
  readPrepared,
  runChange,
  streamCell,
  type ExecEnv,
  type ExecItem,
  type RowsPorts,
} from './execute'
import { boundsFromEnv, resolveRowLimits, type RowLimitBounds } from './limits'
import {
  MemoryPrefs,
  parsePrefValue,
  PrefsError,
  pruneLayout,
  pruneSort,
  type PrefScope,
  type PrefsStore,
} from './prefs'
import {
  cancelCountInput,
  changeRowsInput,
  confirmRowsInput,
  countRowsInput,
  getPrefsInput,
  getRowsInput,
  lookupInput,
  openCellInput,
  previewRowsInput,
  readCellInput,
  readRowInput,
  referencingRowsInput,
  setPrefInput,
  type CancelCountInput,
  type ChangeRowsInput,
  type ChangeRowsResponse,
  type ConfirmRowsInput,
  type CountRowsInput,
  type CountRowsResponse,
  type FilterNode,
  type GetPrefsInput,
  type GetRowsInput,
  type GetRowsResponse,
  type GuardValue,
  type Identity,
  type LookupInput,
  type LookupResponse,
  type OpenCellInput,
  type OpenCellResponse,
  type PrefsResponse,
  type PreviewRowsInput,
  type PreviewRowsResponse,
  type ReadCellInput,
  type ReadCellResponse,
  type ReadRowInput,
  type ReadRowResponse,
  type ReferencingRowsInput,
  type ReferencingRowsResponse,
  type RowChange,
  type RowLimitsResponse,
  type RowPermissions,
  type RowPlanInfo,
  type RowRefusalCode,
  type RowsTotal,
  type RowTable,
  type RowTarget,
  type SetPrefInput,
  type StatementClass,
  type WireValue,
} from './types'

// Plain functions, testable without HTTP. Server functions are in ../rows.functions.ts.

// ---- Environment --------------------------------------------------------------------------------------------------

export type RowsEnv = {
  session: Pick<LiveSession, 'idHash' | 'target'> & { pool: TargetPool }
  guard: GuardContext
  tokens: TokenIssuer
  statementTimeoutMs: number
  ports: RowsPorts
  prefs: PrefsStore
  /** Direct mode `host[zone]:port|username`; stateless mode the session id hash (section 5.9). */
  ownerKey: string
  targetKey: string
  stateless: boolean
  bounds?: RowLimitBounds
  plans?: PlanStore
  handles?: CellHandleStore
  uploads?: UploadStore
  counts?: RunRegistry
  now?: () => number
}

const tokens = createTokenIssuer()
export const memoryPrefs = new MemoryPrefs()
/** Running exact counts of all sessions (cancel by request id, same session only). */
export const countRegistry = new RunRegistry()

let wiredPorts: RowsPorts | undefined = boundPorts

/** Wires the default ports of package A (`model.ts`, `builder.ts`, `classes.ts`); tests pass their own. */
export function setDefaultRowsPorts(ports: RowsPorts): void {
  wiredPorts = ports
}

function defaultPorts(): RowsPorts {
  if (!wiredPorts) throw new Error('rows_not_ready')
  return wiredPorts
}

export const targetLabel = (t: RowsEnv['session']['target']) => `${t.host}${t.zone ?? ''}:${t.port}`

export function rowsEnvOf(session: LiveSession & { ownerKey?: string }): RowsEnv {
  const runtime = getRuntime()
  const stateless = isStateless()
  return {
    session,
    guard: { forcedReadOnly: runtime.config.readOnly, sessionReadOnly: session.readOnly },
    tokens,
    statementTimeoutMs: runtime.config.statementTimeoutMs,
    ports: defaultPorts(),
    prefs: stateless ? (runtime.statelessPrefs?.rows ?? memoryPrefs) : runtime.store.prefs,
    ownerKey: ownerKeyFor(session),
    targetKey: targetLabel(session.target),
    stateless,
  }
}

const nowOf = (env: RowsEnv) => (env.now ?? Date.now)()

// ---- Errors -------------------------------------------------------------------------------------------------------

const refuse = (code: RowRefusalCode, message: string): StructureRefusal =>
  new StructureRefusal(code, message)

/** What the client may see: refusals and guard errors by code, server errors mapped, the rest neutral. */
export function clientError(error: unknown): Error {
  if (error instanceof StructureRefusal) return toClientError(error)
  if (error instanceof BuildRefusal) return new Error(`${error.code}: ${error.message}`)
  if (error instanceof WriteGuardError) return new Error(`${error.code}: ${error.message}`)
  if (error instanceof PrefsError) return new Error(`${error.code}: ${error.message}`)
  if (error instanceof UploadRefusal) return new Error(`${error.code}: ${error.message}`)
  const e = error as { errno?: unknown; sqlMessage?: unknown; code?: unknown } | null
  if (
    e &&
    typeof e === 'object' &&
    typeof e.errno === 'number' &&
    typeof e.sqlMessage === 'string'
  ) {
    const m = mapMysqlError(error)
    return new Error(`server_error: ${m.errno} ${m.message}${m.hint ? ` (${m.hint})` : ''}`)
  }
  if (e && typeof e === 'object' && e.code === 'timeout') {
    return new Error('timeout: The statement exceeded the time limit and was cancelled.')
  }
  if (error instanceof Error && error.message === 'rows_not_ready') return error
  return new Error('unexpected_error')
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw clientError(error)
  }
}

// ---- Shared helpers -----------------------------------------------------------------------------------------------

async function loadTable(env: RowsEnv, db: string, table: string): Promise<RowTable> {
  const found = await env.ports.loadRowTable(env.session.pool, db, table)
  if (!found) throw refuse('unknown-table', 'Not found')
  return found
}

function limitsOf(env: RowsEnv, table?: { db: string; table: string }) {
  const values = env.prefs.get(env.ownerKey, env.targetKey, table)
  return resolveRowLimits(values, env.bounds ?? boundsFromEnv())
}

const isReadOnly = (g: GuardContext) => g.forcedReadOnly || g.sessionReadOnly

/** Row identity key: exactly the identity columns, nothing else (FR-ROW-004). */
function checkKey(
  table: RowTable,
  identity: Identity,
  key: Record<string, GuardValue>,
): asserts identity is Exclude<Identity, { kind: 'none' }> {
  if (identity.kind === 'none') throw refuse('no-identity', 'This row cannot be addressed')
  const names = Object.keys(key)
  const known = new Set(table.columns.map((c) => c.name))
  for (const n of names) if (!known.has(n)) throw refuse('unknown-column', 'Unknown column')
  if (names.length !== identity.columns.length || !identity.columns.every((c) => c in key)) {
    throw refuse('no-identity', 'The key does not match the row identity')
  }
}

function requireColumn(table: RowTable, name: string) {
  const column = table.columns.find((c) => c.name === name)
  if (!column) throw refuse('unknown-column', 'Unknown column')
  return column
}

const timeZones = new WeakMap<object, string>()

async function sessionTimeZone(pool: TargetPool): Promise<string> {
  const cached = timeZones.get(pool)
  if (cached) return cached
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT @@session.time_zone AS tz, @@system_time_zone AS sys',
    )
    const tz = String(rows[0]?.tz ?? 'SYSTEM')
    const zone = tz === 'SYSTEM' ? String(rows[0]?.sys ?? 'SYSTEM') : tz
    timeZones.set(pool, zone)
    return zone
  } catch {
    return 'SYSTEM'
  }
}

/**
 * `TABLE_ROWS` read on a dedicated connection with MySQL's statistics cache bypassed for this one read
 * (`information_schema_stats_expiry`, observed in spike 0b); MariaDB has no such variable (error 1193), the
 * read then runs as it is. The variable is put back to its default before the connection returns to the pool.
 */
export async function readEstimate(
  pool: TargetPool,
  db: string,
  table: string,
): Promise<number | null> {
  const connection = await pool.getConnection()
  let bypassed = false
  let destroy = false
  try {
    try {
      await connection.query('SET SESSION information_schema_stats_expiry = 0')
      bypassed = true
    } catch {
      // MariaDB, or an older MySQL: no such variable
    }
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [db, table],
    )
    const n = rows[0]?.n
    return n === null || n === undefined ? null : Number(n)
  } catch {
    return null
  } finally {
    if (bypassed) {
      await connection.query('SET SESSION information_schema_stats_expiry = DEFAULT').catch(() => {
        destroy = true
      })
    }
    if (destroy) connection.destroy()
    else connection.release()
  }
}

function permissionsOf(
  env: RowsEnv,
  table: RowTable,
  identity: Identity,
  deleteAllowed = true,
): RowPermissions {
  const readOnly = isReadOnly(env.guard)
  const view = table.kind === 'view'
  const writable = table.columns.filter((c) => !c.generated && c.kind !== 'unknown')
  const anyPriv = (k: 'insert' | 'update') =>
    writable.some((c) => c.privileges === undefined || c.privileges[k])
  const restricted =
    writable.length > 0 && writable.some((c) => c.privileges && c.privileges.update === false)
  const noIdentity = identity.kind === 'none'
  const insert = !readOnly && !view && anyPriv('insert')
  const update = !readOnly && !view && !noIdentity && anyPriv('update')
  const del = !readOnly && !view && !noIdentity && deleteAllowed
  const reason = readOnly
    ? 'read-only'
    : view
      ? 'view'
      : noIdentity
        ? 'no-identity'
        : !insert || !update
          ? 'privilege'
          : undefined
  return {
    readOnly,
    insert,
    update,
    delete: del,
    ...(restricted && update
      ? {
          updateColumns: writable
            .filter((c) => c.privileges === undefined || c.privileges.update)
            .map((c) => c.name),
        }
      : {}),
    ...(reason ? { reason } : {}),
  }
}

// ---- getRows, countRows ---------------------------------------------------------------------------------------------

const DEEP_OFFSET = 100_000

type CountOutcome =
  | { status: 'done'; total: RowsTotal; durationMs: number }
  | { status: 'timeout'; durationMs: number }
  | { status: 'cancelled' }

/** Runs a count under the statement timeout; `handle` lets another request cancel it. */
async function runCount(
  env: RowsEnv,
  table: RowTable,
  q: { filter?: FilterNode; search?: CountRowsInput['search'] },
  requestId?: string,
): Promise<CountOutcome> {
  const limits = limitsOf(env, table)
  const view = table.kind === 'view'
  const cap = view ? limits.viewCountCap : undefined
  const stmt = env.ports.buildCount(table, { ...q, ...(cap ? { cap } : {}) })
  const registry = env.counts ?? countRegistry
  const handle = requestId
    ? registry.begin(env.session.idHash, `${env.session.idHash}:${requestId}`, 4)
    : undefined
  const started = Date.now()
  try {
    const rows = await readPrepared(
      env.session.pool,
      env.statementTimeoutMs,
      stmt,
      handle ? (c) => void (handle.threadId = c.threadId) : undefined,
    )
    const n = Number(rows[0]?.[0] ?? 0)
    const total: RowsTotal =
      cap !== undefined && n > cap
        ? { kind: 'lowerBound', value: cap }
        : { kind: 'exact', value: n }
    return { status: 'done', total, durationMs: Date.now() - started }
  } catch (error) {
    if (handle?.cancelRequested) return { status: 'cancelled' }
    const e = error as { code?: unknown; errno?: unknown }
    if (e?.code === 'timeout' || e?.errno === 3024 || e?.errno === 1969) {
      return { status: 'timeout', durationMs: Date.now() - started }
    }
    if (e?.errno === 1317) return { status: 'cancelled' }
    throw error
  } finally {
    if (handle) registry.finish(handle)
  }
}

export async function getRowsImpl(env: RowsEnv, raw: GetRowsInput): Promise<GetRowsResponse> {
  return guarded(async () => {
    const input = getRowsInput.parse(raw)
    const loaded = await loadTable(env, input.db, input.table)
    const advisory = env.ports.readPrivileges
      ? await env.ports.readPrivileges(env.session.pool, loaded)
      : { table: loaded, delete: true }
    const table = advisory.table
    const identity = env.ports.identityFor(table)
    const limits = limitsOf(env, table)
    const pageSize = Math.min(input.pageSize, limits.maxPageSize)
    for (const s of input.sort) requireColumn(table, s.column)
    prunePrefs(env, table)

    const read = async (page: number) => {
      const stmt = env.ports.buildPage(table, identity, {
        page,
        pageSize,
        sort: input.sort,
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.search ? { search: input.search } : {}),
        cellBytes: limits.cellBytes,
      })
      const t0 = Date.now()
      const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, stmt)
      return { stmt, rows, ms: Date.now() - t0 }
    }

    const filtered = input.filter !== undefined || input.search !== undefined
    const view = table.kind === 'view'
    let page = input.page
    let first = await read(page)
    let pageMs = first.ms
    let countMs: number | undefined
    let total: RowsTotal = { kind: 'unknown', value: null }

    /** The total when it is cheap enough to compute without being asked (FR-ROW-007). */
    const cheapTotal = async (): Promise<RowsTotal> => {
      if (view) {
        if (filtered) return { kind: 'unknown', value: null }
        const c = await runCount(env, table, {})
        if (c.status === 'done') {
          countMs = (countMs ?? 0) + c.durationMs
          return c.total
        }
        return { kind: 'unknown', value: null }
      }
      if (filtered) return { kind: 'unknown', value: null }
      const estimate = await readEstimate(env.session.pool, input.db, input.table)
      if (estimate !== null && estimate <= limits.exactCountThreshold) {
        const c = await runCount(env, table, {})
        if (c.status === 'done') {
          countMs = (countMs ?? 0) + c.durationMs
          return c.total
        }
      }
      return estimate === null
        ? { kind: 'unknown', value: null }
        : { kind: 'estimate', value: estimate }
    }

    if (first.rows.length === 0 && page > 0) {
      // A page past the end: the last page when the count is known, else the empty page (FR-DTB-006).
      const known = await cheapTotal()
      if (known.kind === 'exact' || known.kind === 'lowerBound') {
        const value = known.value ?? 0
        page = Math.max(0, Math.ceil(value / pageSize) - 1)
        first = await read(page)
        pageMs += first.ms
        total = known
      } else {
        total = known
      }
    } else if (first.rows.length <= pageSize) {
      total = { kind: 'exact', value: page * pageSize + first.rows.length }
    } else {
      total = await cheapTotal()
    }

    const hasNext = first.rows.length > pageSize
    const decoded = first.stmt.decode(first.rows.slice(0, pageSize))
    audit('table.open', {
      user: env.session.target.username,
      db: input.db,
      table: input.table,
    })
    return {
      table,
      columns: first.stmt.columns,
      kinds: first.stmt.kinds ?? first.stmt.columns.map(() => 'text' as const),
      rows: decoded.rows,
      page,
      hasNext,
      hasPrev: page > 0,
      sqlShown: first.stmt.preview,
      total,
      timings: { pageMs, ...(countMs !== undefined ? { countMs } : {}) },
      identity,
      permissions: permissionsOf(env, table, identity, advisory.delete),
      timeZone: await sessionTimeZone(env.session.pool),
      ...(page * pageSize > DEEP_OFFSET ? { deepOffset: true } : {}),
    }
  })
}

export async function countRowsImpl(env: RowsEnv, raw: CountRowsInput): Promise<CountRowsResponse> {
  return guarded(async () => {
    const input = countRowsInput.parse(raw)
    const table = await loadTable(env, input.db, input.table)
    const estimate = table.kind === 'view' ? null : table.estimatedRows
    const fallback: RowsTotal =
      estimate === null ? { kind: 'unknown', value: null } : { kind: 'estimate', value: estimate }
    const outcome = await runCount(
      env,
      table,
      {
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.search ? { search: input.search } : {}),
      },
      input.requestId,
    )
    audit('table.count', { user: env.session.target.username, db: input.db, table: input.table })
    if (outcome.status === 'done') {
      return { status: 'done', total: outcome.total, durationMs: outcome.durationMs }
    }
    if (outcome.status === 'timeout') {
      return { status: 'timeout', total: fallback, durationMs: outcome.durationMs }
    }
    return { status: 'cancelled', total: fallback }
  })
}

export async function cancelCountImpl(env: RowsEnv, raw: CancelCountInput): Promise<{ ok: true }> {
  return guarded(async () => {
    const input = cancelCountInput.parse(raw)
    await (env.counts ?? countRegistry).cancel(
      env.session.pool,
      env.session.idHash,
      `${env.session.idHash}:${input.requestId}`,
    )
    return { ok: true as const }
  })
}

export async function getRowLimitsImpl(env: RowsEnv): Promise<RowLimitsResponse> {
  return { ...limitsOf(env), stateless: env.stateless }
}

// ---- readRow, readCell, openCell ----------------------------------------------------------------------------------------

export async function readRowImpl(env: RowsEnv, raw: ReadRowInput): Promise<ReadRowResponse> {
  return guarded(async () => {
    const input = readRowInput.parse(raw)
    const table = await loadTable(env, input.db, input.table)
    const identity = env.ports.identityFor(table)
    checkKey(table, identity, input.key)
    const limits = limitsOf(env, table)
    const stmt = env.ports.buildRow(table, identity, input.key, {
      cellBytes: limits.cellBytes,
      ...(input.includeInvisible ? { includeInvisible: true } : {}),
    })
    const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, stmt)
    if (rows.length === 0) return { found: false as const }
    const decoded = stmt.decode(rows)
    return {
      found: true as const,
      columns: stmt.columns,
      cells: decoded.rows[0] ?? [],
      digests: decoded.digests[0] ?? {},
    }
  })
}

export async function readCellImpl(env: RowsEnv, raw: ReadCellInput): Promise<ReadCellResponse> {
  return guarded(async () => {
    const input = readCellInput.parse(raw)
    const table = await loadTable(env, input.db, input.table)
    const identity = env.ports.identityFor(table)
    checkKey(table, identity, input.key)
    requireColumn(table, input.column)
    const maxBytes = input.maxBytes ?? limitsOf(env, table).cellBytes
    const read = env.ports.buildCellRead(table, identity, input.key, input.column, maxBytes)
    const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, read.statement)
    const decoded = read.decode(rows)
    if (!decoded) return { found: false as const }
    return {
      found: true as const,
      value: decoded.value,
      ...(decoded.digest !== undefined ? { digest: decoded.digest } : {}),
    }
  })
}

export async function openCellImpl(env: RowsEnv, raw: OpenCellInput): Promise<OpenCellResponse> {
  return guarded(async () => {
    const input = openCellInput.parse(raw)
    const table = await loadTable(env, input.db, input.table)
    const identity = env.ports.identityFor(table)
    checkKey(table, identity, input.key)
    const column = requireColumn(table, input.column)
    // Only stored bytes are streamed; every other kind is read through readCell.
    if (column.kind !== 'binary' && column.kind !== 'blob') {
      throw refuse('not-editable', 'This value cannot be downloaded')
    }
    const sized = env.ports.buildCellSize(table, identity, input.key, input.column)
    const sizeRows = await readPrepared(env.session.pool, env.statementTimeoutMs, sized.statement)
    const size = sized.decode(sizeRows)
    if (size === undefined || size === null) return { found: false as const }
    let previewType = undefined as ReturnType<typeof sniffPreviewType>
    if (input.disposition === 'preview' && size <= PREVIEW_MAX_BYTES) {
      const take = Math.min(16, size)
      if (take > 0) {
        const stmt = env.ports.buildCellChunk(table, identity, input.key, input.column, 0, take)
        const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, stmt)
        const head = rows[0]?.[0]
        if (Buffer.isBuffer(head)) previewType = sniffPreviewType(head)
      }
    }
    const store = env.handles ?? defaultHandles
    const handle = store.create(env.session.idHash, {
      db: input.db,
      table: input.table,
      key: input.key,
      column: input.column,
      size,
      disposition: input.disposition,
      ...(previewType ? { previewType } : {}),
      fileName: safeFileName(input.table, input.column, previewType),
    })
    return {
      found: true as const,
      id: handle.id,
      expiresAt: handle.expiresAt,
      size,
      fileName: handle.fileName,
      ...(previewType ? { previewType } : {}),
    }
  })
}

/**
 * The download route (`GET /api/rows/cell/<id>`): takes the one-time handle of this session and streams the
 * bytes in chunks. Every failure is the same neutral 404. Headers follow FR-ROW-012 and FR-ROW-030.
 */
export async function cellDownloadResponse(env: RowsEnv, id: string): Promise<Response> {
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  const handle = (env.handles ?? defaultHandles).take(env.session.idHash, id)
  if (!handle) return notFound()
  let table: RowTable | undefined
  try {
    table = await env.ports.loadRowTable(env.session.pool, handle.db, handle.table)
  } catch {
    return notFound()
  }
  if (!table) return notFound()
  const identity = env.ports.identityFor(table)
  if (identity.kind === 'none') return notFound()
  const source = streamCell(
    {
      pool: env.session.pool,
      ports: env.ports,
      table,
      identity,
      statementTimeoutMs: env.statementTimeoutMs,
    },
    handle.key as Record<string, GuardValue>,
    handle.column,
    handle.size,
  )
  const iterator = source[Symbol.asyncIterator]()
  // Pull the first chunk now, so a vanished row becomes a 404 instead of a broken body.
  let first: IteratorResult<Buffer>
  try {
    first = await iterator.next()
  } catch {
    await iterator.return?.(undefined).catch(() => undefined)
    return notFound()
  }
  let pending: IteratorResult<Buffer> | undefined = first
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await iterator.next())
        pending = undefined
        if (next.done) controller.close()
        else controller.enqueue(new Uint8Array(next.value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.(undefined).catch(() => undefined)
    },
  })
  const inline = handle.disposition === 'preview' && handle.previewType !== undefined
  const headers: Record<string, string> = {
    'content-type': inline ? CONTENT_TYPES[handle.previewType!] : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${handle.fileName}"`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'no-store',
  }
  return new Response(body, { status: 200, headers })
}

/** Response of the upload route and the plain function behind it (FR-ROW-012). */
export function stageUpload(
  env: RowsEnv,
  bytes: Buffer,
  fileName?: string,
): {
  uploadId: string
  sha256: string
  size: number
  fileName?: string
  previewType?: NonNullable<ReturnType<typeof sniffPreviewType>>
} {
  const staged = (env.uploads ?? defaultUploads).put(env.session.idHash, bytes, fileName)
  return {
    uploadId: staged.uploadId,
    sha256: staged.sha256,
    size: bytes.length,
    ...(fileName !== undefined ? { fileName } : {}),
    ...(staged.previewType ? { previewType: staged.previewType } : {}),
  }
}

/** Largest upload: the lower of the setting and `@@max_allowed_packet` minus room for the statement. */
export async function uploadLimit(env: RowsEnv): Promise<number> {
  const configured = limitsOf(env).uploadBytes
  try {
    const [rows] = await env.session.pool.query<RowDataPacket[]>('SELECT @@max_allowed_packet AS m')
    const packet = Number(rows[0]?.m)
    if (Number.isFinite(packet) && packet > 0) return Math.min(configured, packet - 64 * 1024)
  } catch {
    // keep the configured limit; the server answers 1153 if the packet is too small
  }
  return configured
}

// ---- Lookup and referencing rows (FR-ROW-014) ----------------------------------------------------------------------------

const LOOKUP_PAGE = 50
const REFERENCING_CAP = 1000

export async function lookupImpl(env: RowsEnv, raw: LookupInput): Promise<LookupResponse> {
  return guarded(async () => {
    const input = lookupInput.parse(raw)
    const table = await loadTable(env, input.db, input.table)
    const fk = table.outgoing.find((f) => f.name === input.fk)
    if (!fk) throw refuse('unknown-column', 'Unknown foreign key')
    const ref = await loadTable(env, fk.refDb, fk.refTable)
    const preferred = (
      env.prefs.get(env.ownerKey, env.targetKey)['rows.fkDisplay'] as
        Record<string, string[]> | undefined
    )?.[`${fk.refDb}.${fk.refTable}`]
    const known = new Set(ref.columns.map((c) => c.name))
    let displayColumns = (preferred ?? []).filter((c) => known.has(c))
    if (displayColumns.length === 0) {
      // default: the first character column that is not part of the key (UI-ISS-103)
      const first = ref.columns.find((c) => c.kind === 'char' && !fk.refColumns.includes(c.name))
      displayColumns = first ? [first.name] : []
    }
    const read = env.ports.buildLookup(ref, {
      keyColumns: fk.refColumns,
      displayColumns,
      page: input.page,
      pageSize: LOOKUP_PAGE,
      ...(input.query ? { query: input.query } : {}),
      ...(input.keys ? { keys: input.keys } : {}),
    })
    const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, read.statement)
    return read.decode(rows)
  })
}

export async function referencingRowsImpl(
  env: RowsEnv,
  raw: ReferencingRowsInput,
): Promise<ReferencingRowsResponse> {
  return guarded(async () => {
    const input = referencingRowsInput.parse(raw)
    const table = await loadTable(env, input.db, input.table)
    const identity = env.ports.identityFor(table)
    checkKey(table, identity, input.key)
    const limits = limitsOf(env, table)
    const readStmt = env.ports.buildRow(table, identity, input.key, { cellBytes: limits.cellBytes })
    const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, readStmt)
    if (rows.length === 0) return { groups: [] }
    const decoded = readStmt.decode(rows)
    const cells = decoded.rows[0] ?? []
    const groups: ReferencingRowsResponse['groups'] = []
    for (const fk of table.incoming.slice(0, 50)) {
      // `fk.columns` are the columns of the referencing table, `fk.refColumns` those of this table.
      const values = fk.refColumns.map((c) => cells[readStmt.columns.indexOf(c)])
      if (values.some((v) => typeof v !== 'string')) continue
      const other = await env.ports.loadRowTable(env.session.pool, fk.refDb, fk.refTable)
      if (!other) continue
      const filter: FilterNode = {
        type: 'group',
        op: 'and',
        children: fk.columns.map((column, i) => ({
          type: 'condition' as const,
          column,
          op: '=' as const,
          values: [values[i] as string],
        })),
      }
      const stmt = env.ports.buildCount(other, { filter, cap: REFERENCING_CAP })
      const counted = await readPrepared(env.session.pool, env.statementTimeoutMs, stmt)
      const n = Number(counted[0]?.[0] ?? 0)
      if (n === 0) continue
      groups.push({
        db: fk.refDb,
        table: fk.refTable,
        fk: fk.name,
        columns: fk.columns,
        count: Math.min(n, REFERENCING_CAP),
        atLeast: n > REFERENCING_CAP,
      })
    }
    return { groups }
  })
}

// ---- Preferences -----------------------------------------------------------------------------------------------------------

function scopeOf(input: { db?: string | undefined; table?: string | undefined }): PrefScope {
  if ((input.db === undefined) !== (input.table === undefined)) {
    throw new PrefsError('scope-forbidden', 'Give both database and table, or neither')
  }
  return input.db !== undefined && input.table !== undefined
    ? { kind: 'table', db: input.db, table: input.table }
    : { kind: 'global' }
}

export async function getPrefsImpl(env: RowsEnv, raw: GetPrefsInput): Promise<PrefsResponse> {
  return guarded(async () => {
    const input = getPrefsInput.parse(raw)
    const scope = scopeOf(input)
    const values = env.prefs.get(
      env.ownerKey,
      env.targetKey,
      scope.kind === 'table' ? { db: scope.db, table: scope.table } : undefined,
    )
    return { values, stateless: env.stateless }
  })
}

export async function setPrefImpl(env: RowsEnv, raw: SetPrefInput): Promise<{ ok: true }> {
  return guarded(async () => {
    const input = setPrefInput.parse(raw)
    const scope = scopeOf(input)
    const value = parsePrefValue(input.key, input.value, scope)
    if (scope.kind === 'table') {
      // Only tables that exist get a scope (SEC-TGT-116); the 500-scope cap prunes the oldest.
      await loadTable(env, scope.db, scope.table)
    }
    env.prefs.set(env.ownerKey, env.targetKey, scope, input.key, value)
    return { ok: true as const }
  })
}

/** Removes names of dropped columns from the stored layout and sort of a table (DATA-ISS-114). */
function prunePrefs(env: RowsEnv, table: RowTable): void {
  const scope: PrefScope = { kind: 'table', db: table.db, table: table.table }
  const values = env.prefs.get(env.ownerKey, env.targetKey, { db: table.db, table: table.table })
  const names = table.columns.map((c) => c.name)
  try {
    if (values['rows.columns'] !== undefined) {
      const pruned = pruneLayout(values['rows.columns'], names)
      if (pruned && JSON.stringify(pruned) !== JSON.stringify(values['rows.columns'])) {
        env.prefs.set(env.ownerKey, env.targetKey, scope, 'rows.columns', pruned)
      }
    }
    if (values['rows.sort'] !== undefined) {
      const pruned = pruneSort(values['rows.sort'], names)
      if (pruned && JSON.stringify(pruned) !== JSON.stringify(values['rows.sort'])) {
        env.prefs.set(env.ownerKey, env.targetKey, scope, 'rows.sort', pruned)
      }
    }
  } catch {
    // preferences never fail a read
  }
}

// ---- Writes: plan, preview, change, confirm ----------------------------------------------------------------------------------

const MAX_SHOWN_STATEMENTS = 20

type Planned = {
  table: RowTable
  identity: Identity
  change: RowChange
  items: ExecItem[]
  statements: Statement[]
  /** The statements with real parameters (uploads included), for display fields. */
  maxClass: StatementClass
  reasons: RowPlanInfoReasons
  cascadeTables: { db: string; table: string; fk: string }[]
  warnings: RowPlanInfo['warnings']
  usedUploads: string[]
  noChanges: boolean
}
type RowPlanInfoReasons = RowPlanInfo['reasons']

const operationOf = (change: RowChange) => change.op

const bytesOf =
  (env: RowsEnv) =>
  (id: string): Buffer | undefined =>
    (env.uploads ?? defaultUploads).peek(env.session.idHash, id)?.bytes

function checkWritableColumns(
  table: RowTable,
  record: Record<string, WireValue>,
  env: RowsEnv,
): string[] {
  const used: string[] = []
  for (const [name, value] of Object.entries(record)) {
    const column = requireColumn(table, name)
    if (column.generated || column.kind === 'unknown') {
      throw refuse('not-editable', 'This column cannot be written')
    }
    if (value.t === 'bin') {
      if (!bytesOf(env)(value.upload)) throw refuse('unknown-upload', 'The uploaded file is gone')
      used.push(value.upload)
    }
  }
  return used
}

/** Builds the statements of a change from the model; the same function serves preview and confirm. */
async function planChange(
  env: RowsEnv,
  db: string,
  tableName: string,
  input: RowChange,
): Promise<Planned> {
  const table = await loadTable(env, db, tableName)
  if (table.kind === 'view') throw refuse('view-read-only', 'A view cannot be edited')
  const identity = env.ports.identityFor(table)
  const limits = limitsOf(env, table)
  const bytes = bytesOf(env)
  const usedUploads: string[] = []
  const items: ExecItem[] = []
  let change = input

  if (change.op === 'insert') {
    if (change.rows.length > limits.bulkSize) throw refuse('bulk-limit', 'Too many rows')
    for (const row of change.rows) usedUploads.push(...checkWritableColumns(table, row, env))
    for (const [i, row] of change.rows.entries()) {
      const statement = env.ports.buildInsert(table, row, change.ignore, bytes)
      items.push({
        index: i,
        op: 'insert',
        statement,
        afterKey: (header) => insertedKey(table, identity, row, header.insertId),
      })
    }
  } else {
    if (identity.kind === 'none')
      throw refuse('no-identity', 'This table has no usable row identity')
    if (change.targets.length > limits.bulkSize)
      throw refuse('bulk-limit', 'Too many rows selected')
    for (const t of change.targets) {
      checkKey(table, identity, t.key)
      for (const name of Object.keys(t.old)) requireColumn(table, name)
    }
    if (change.op === 'update') {
      usedUploads.push(...checkWritableColumns(table, change.set, env))
      const set = dropUnchanged(change.set, change.targets)
      change = { ...change, set }
      if (Object.keys(set).length === 0) {
        return {
          table,
          identity,
          change,
          items: [],
          statements: [],
          maxClass: 'none',
          reasons: [],
          cascadeTables: [],
          warnings: [],
          usedUploads: [],
          noChanges: true,
        }
      }
      for (const [i, target] of change.targets.entries()) {
        items.push({
          index: i,
          op: 'update',
          statement: env.ports.buildUpdate(table, identity, target, set, bytes),
          target,
          afterKey: () => updatedKey(table, identity, target, set),
        })
      }
    } else {
      for (const [i, target] of change.targets.entries()) {
        items.push({
          index: i,
          op: 'delete',
          statement: env.ports.buildDelete(table, identity, target, bytes),
          target,
        })
      }
    }
  }

  const classed = env.ports.classify(table, change, identity)
  const warnings: Planned['warnings'] = [...classed.warnings]
  if (!table.transactional && items.length > 0 && !warnings.some((w) => w.code === 'no-rollback')) {
    warnings.push({
      code: 'no-rollback',
      message: `The ${table.engine ?? 'storage'} engine has no transactions; a failure part way cannot be undone.`,
    })
  }
  const statements: Statement[] = items.map((item) => ({
    sql: item.statement.sql,
    kind:
      item.statement.kind === 'rowInsert' ||
      item.statement.kind === 'rowUpdate' ||
      item.statement.kind === 'rowDelete'
        ? item.statement.kind
        : 'userSql',
    class: classed.maxClass,
    effect: item.statement.effect,
    params: hashableParams(item.statement.params),
  }))
  return {
    table,
    identity,
    change,
    items,
    statements,
    maxClass: classed.maxClass,
    reasons: classed.reasons,
    cascadeTables: classed.cascadeTables,
    warnings,
    usedUploads: [...new Set(usedUploads)],
    noChanges: false,
  }
}

/** Removes `set` entries that equal the old value of every target (an unchanged field is never written). */
function dropUnchanged(
  set: Record<string, WireValue>,
  targets: RowTarget[],
): Record<string, WireValue> {
  const out: Record<string, WireValue> = {}
  for (const [name, value] of Object.entries(set)) {
    const same =
      value.t === 'v' || value.t === 'null'
        ? targets.every((t) => {
            const old = t.old[name]
            if (!old) return false
            return value.t === 'null' ? old.t === 'null' : old.t === 'v' && old.v === value.v
          })
        : false
    if (!same) out[name] = value
  }
  return out
}

const toGuard = (value: WireValue | undefined): GuardValue | undefined => {
  if (!value) return undefined
  if (value.t === 'null') return { t: 'null' }
  if (value.t === 'v') return { t: 'v', v: value.v }
  return undefined
}

function updatedKey(
  table: RowTable,
  identity: Identity,
  target: RowTarget,
  set: Record<string, WireValue>,
): Record<string, GuardValue> | undefined {
  if (identity.kind === 'none') return undefined
  void table
  if (identity.kind === 'all-columns') {
    const next: Record<string, GuardValue> = { ...target.key }
    for (const [name, value] of Object.entries(set)) {
      const g = toGuard(value)
      if (!g) return undefined
      next[name] = g
    }
    return next
  }
  const key: Record<string, GuardValue> = { ...target.key }
  for (const name of identity.columns) {
    const value = set[name]
    if (value === undefined) continue
    const g = toGuard(value)
    if (!g) return undefined
    key[name] = g
  }
  return key
}

function insertedKey(
  table: RowTable,
  identity: Identity,
  row: Record<string, WireValue>,
  insertId: number | string,
): Record<string, GuardValue> | undefined {
  if (identity.kind === 'none' || identity.kind === 'all-columns') return undefined
  const key: Record<string, GuardValue> = {}
  for (const name of identity.columns) {
    const given = toGuard(row[name])
    if (given) {
      key[name] = given
      continue
    }
    const column = table.columns.find((c) => c.name === name)
    if (column?.autoIncrement && Number(insertId) > 0) {
      key[name] = { t: 'v', v: String(insertId) }
      continue
    }
    return undefined
  }
  return key
}

async function matchCount(env: RowsEnv, planned: Planned): Promise<number | undefined> {
  if (planned.identity.kind !== 'all-columns' || planned.change.op === 'insert') return undefined
  let total = 0
  for (const target of planned.change.targets) {
    const stmt = env.ports.buildMatchCount(planned.table, planned.identity, target)
    const rows = await readPrepared(env.session.pool, env.statementTimeoutMs, stmt)
    total += Number(rows[0]?.[0] ?? 0)
  }
  return total
}

async function infoOf(env: RowsEnv, planned: Planned): Promise<RowPlanInfo> {
  const cascadeTables = planned.cascadeTables
  const matches = await matchCount(env, planned)
  return {
    statements: planned.items.slice(0, MAX_SHOWN_STATEMENTS).map((item) => ({
      sql: item.statement.sql,
      preview: item.statement.preview,
      effect: item.statement.effect,
      class: planned.maxClass,
    })),
    totalStatements: planned.items.length,
    maxClass: planned.maxClass,
    reasons: planned.reasons,
    warnings: planned.warnings,
    identityKind: planned.identity.kind === 'none' ? 'primary' : planned.identity.kind,
    ...(matches !== undefined ? { matchCount: matches } : {}),
    ...(cascadeTables.length > 0 ? { cascadeTables } : {}),
  }
}

type PlanPayload = { change: RowChange; db: string; table: string; maxClass: StatementClass }

function refusedAudit(
  env: RowsEnv,
  db: string,
  table: string,
  code: string,
  operation?: RowChange['op'],
): void {
  auditRowsRefused({
    user: env.session.target.username,
    target: targetLabel(env.session.target),
    db,
    table,
    ...(operation ? { operation } : {}),
    code,
  })
}

/** `assertWritable` is the first call of every write function; a read-only session never reaches the pool. */
function guardWrite(env: RowsEnv, db: string, table: string, operation?: RowChange['op']): void {
  try {
    assertWritable(env.guard)
  } catch (error) {
    refusedAudit(env, db, table, (error as WriteGuardError).code, operation)
    throw error
  }
}

export async function previewRowsImpl(
  env: RowsEnv,
  raw: PreviewRowsInput,
): Promise<PreviewRowsResponse> {
  return guarded(async () => {
    const input = previewRowsInput.parse(raw)
    guardWrite(env, input.db, input.table, input.change.op)
    const planned = await planChange(env, input.db, input.table, input.change)
    return infoOf(env, planned)
  })
}

export async function changeRowsImpl(
  env: RowsEnv,
  raw: ChangeRowsInput,
): Promise<ChangeRowsResponse> {
  return guarded(async () => {
    const input = changeRowsInput.parse(raw)
    guardWrite(env, input.db, input.table, input.change.op)
    let planned: Planned
    try {
      planned = await planChange(env, input.db, input.table, input.change)
    } catch (error) {
      if (error instanceof RowValueError && error.field !== undefined) {
        // A value that does not fit its column: reported on the field, nothing ran (FR-ROW-025).
        return {
          kind: 'error' as const,
          error: {
            errno: null,
            code: error.code,
            message: error.message,
            field: error.field,
            ...(error.rowIndex !== undefined ? { rowIndex: error.rowIndex } : {}),
          },
          outcomes: [],
          known: true,
        }
      }
      if (error instanceof StructureRefusal || error instanceof BuildRefusal) {
        refusedAudit(env, input.db, input.table, error.code, input.change.op)
      }
      throw error
    }
    if (planned.noChanges) {
      return {
        kind: 'done' as const,
        operation: 'update' as const,
        affectedRows: 0,
        outcomes: [],
        statements: [],
        warnings: [],
        columns: [],
        rows: [],
        noChanges: true,
      }
    }
    const needsConfirm =
      planned.maxClass === 'hard' || (planned.maxClass === 'soft' && !input.acceptSoft)
    if (!needsConfirm) {
      return runPlanned(env, planned, undefined)
    }
    const info = await infoOf(env, planned)
    const plans = env.plans ?? defaultPlans
    const statementsHash = hashStatements(planned.statements)
    const payload: PlanPayload = {
      change: planned.change,
      db: input.db,
      table: input.table,
      maxClass: planned.maxClass,
    }
    const stored = plans.create(env.session.idHash, {
      statements: planned.statements,
      warnings: planned.warnings,
      statementsHash,
      db: input.db,
      table: input.table,
      payload,
    })
    const hard = planned.maxClass === 'hard'
    return {
      kind: 'confirm' as const,
      planId: stored.planId,
      confirmRequired: hard,
      ...(hard
        ? {
            confirmToken: env.tokens.issue({
              sessionId: env.session.idHash,
              target: targetLabel(env.session.target),
              planId: stored.planId,
              statementsHash,
              expiresAt: stored.expiresAt,
            }),
          }
        : {}),
      expiresAt: stored.expiresAt,
      ...info,
    }
  })
}

export async function confirmRowsImpl(
  env: RowsEnv,
  raw: ConfirmRowsInput,
): Promise<ChangeRowsResponse> {
  return guarded(async () => {
    const input = confirmRowsInput.parse(raw)
    const plans = env.plans ?? defaultPlans
    const plan = plans.get(env.session.idHash, input.planId)
    const payload = plan?.payload as PlanPayload | undefined
    const db = payload?.db ?? ''
    const tableName = payload?.table ?? ''
    guardWrite(env, db, tableName, payload?.change.op)

    const fail = (code: RowRefusalCode, message: string): never => {
      refusedAudit(env, db, tableName, code, payload?.change.op)
      throw refuse(code, message)
    }
    if (!plan || !payload) return fail('plan-missing', 'The plan has expired or does not exist')

    // The stored plan must still be what the token was issued for (tampered store, SEC-TGT-118).
    if (hashStatements(plan.statements) !== plan.statementsHash) {
      return fail('token-invalid', 'The plan does not match its confirmation')
    }
    if (plan.statements.some((s) => s.class === 'hard')) {
      try {
        env.tokens.verifyAndConsume(
          input.confirmToken,
          {
            sessionId: env.session.idHash,
            target: targetLabel(env.session.target),
            planId: plan.planId,
            statementsHash: plan.statementsHash,
          },
          nowOf(env),
        )
      } catch (error) {
        if (error instanceof WriteGuardError) {
          refusedAudit(env, db, tableName, error.code, payload.change.op)
        }
        throw error
      }
    }

    // From here on the plan is spent, whatever happens.
    plans.consume(plan.planId)
    const planned = await planChange(env, payload.db, payload.table, payload.change)
    if (hashStatements(planned.statements) !== plan.statementsHash) {
      return fail('plan-missing', 'The table changed since the preview; review again')
    }
    return runPlanned(env, planned, plan)
  })
}

async function runPlanned(
  env: RowsEnv,
  planned: Planned,
  plan: StoredPlan | undefined,
): Promise<ChangeRowsResponse> {
  const limits = limitsOf(env, planned.table)
  const execEnv: ExecEnv = {
    pool: env.session.pool,
    ports: env.ports,
    table: planned.table,
    identity: planned.identity,
    statementTimeoutMs: env.statementTimeoutMs,
    cellBytes: limits.cellBytes,
  }
  const operation = operationOf(planned.change)
  const out = await runChange(execEnv, planned.items)
  // Uploads are single use: gone after the write that used them, applied or not.
  for (const id of planned.usedUploads) (env.uploads ?? defaultUploads).consume(id)

  const audited = (
    outcome: 'ok' | 'conflict' | 'gone' | 'error' | 'partial',
    durationMs: number,
    errno?: number,
  ) =>
    auditRowsChange({
      user: env.session.target.username,
      target: targetLabel(env.session.target),
      db: planned.table.db,
      table: planned.table.table,
      operation,
      rowCount: planned.items.length,
      statementCount: planned.items.length,
      maxClass: planned.maxClass,
      identityKind: planned.identity.kind === 'none' ? 'primary' : planned.identity.kind,
      outcome,
      ...(errno !== undefined ? { errno } : {}),
      durationMs,
      ...(plan ? { planId: plan.planId } : {}),
    })

  switch (out.kind) {
    case 'done':
      audited('ok', out.durationMs)
      return {
        kind: 'done',
        operation,
        affectedRows: out.affectedRows,
        outcomes: out.outcomes,
        statements: planned.items.map((i) => ({
          sql: i.statement.sql,
          preview: i.statement.preview,
        })),
        warnings: out.warnings,
        columns: out.columns,
        rows: out.rows,
      }
    case 'conflict':
      audited('conflict', out.durationMs)
      return {
        kind: 'conflict',
        index: out.index,
        columns: out.columns,
        current: out.current,
        digests: out.digests,
        changed: out.changed,
        outcomes: out.outcomes,
      }
    case 'gone':
      audited('gone', out.durationMs)
      return { kind: 'gone', index: out.index, outcomes: out.outcomes }
    case 'error': {
      const applied = out.outcomes.some((o) => o.status === 'applied')
      audited(applied ? 'partial' : 'error', out.durationMs, out.error.errno ?? undefined)
      return { kind: 'error', error: out.error, outcomes: out.outcomes, known: out.known }
    }
  }
}
