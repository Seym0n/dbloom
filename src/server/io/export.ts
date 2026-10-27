/**
 * Export engine of module `io` (FR-IO-002/003/004/005/006/007/008/010, spec 5.1). `runExport` reads through one
 * dedicated connection (consistent snapshot or table locks), turns catalog objects and rows into SQL, CSV or JSON
 * text with the writers of package A, packs it (none, gzip, zip) and spools it to a temp file. The spool is
 * committed only when everything succeeded: a failed or cancelled export leaves no file behind (G4, Q10).
 *
 * The engine knows nothing about HTTP, sessions or the job registry; `export-service.ts` wires those.
 */
import type { PoolConnection } from 'mysql2/promise'
import { quoteIdent as q } from '../db/identifiers'
import type { TargetPool } from '../db/target-pool'
import { killThreadQuery } from '../guard/statement-timeout'
import type { ResultStream } from '../sql/export-source'
import { UTF8_BOM, CsvWriter } from './csv'
import {
  ObjectUnreadable,
  batchRows,
  findDatabase,
  foreignKeyDeps,
  kindOfWireType,
  listEvents,
  listObjects,
  listRoutines,
  listTriggers,
  listUserDatabases,
  loadColumns,
  primaryKeyColumns,
  selectSql,
  showCreate,
  streamSelect,
  toCell,
  viewReferences,
  type CreateKind,
  type ExportColumn,
  type ObjectInfo,
  type RoutineInfo,
  type TriggerInfo,
} from './export-catalog'
import { TextLimitReached, createSink, type ExportSink } from './export-sink'
import { buildFileNames, contentTypeFor, DEFAULT_TEMPLATES } from './filename'
import { JsonExportWriter } from './json'
import type { IoLimitsResolved } from './limits'
import { formatBytes } from './limits'
import { SqlWriter, commentSafe, orderByDependency } from './sql-writer'
import { TempError, type StageWriter, type TempFile, type TempOwner, type TempStore } from './temp'
import { separateEntryName } from './zip'
import { csvCellText } from './values'
import {
  MiB,
  TEXT_VIEW_MAX_BYTES,
  type Compression,
  type CsvExportOptions,
  type ExportRequest,
  type IoCell,
  type IoError,
  type IoErrorCode,
  type JobProgress,
  type JobResult,
  type SqlExportOptions,
} from './types'

export const DBLOOM_VERSION = process.env.npm_package_version ?? '0.0.0'

// ---- Errors ----------------------------------------------------------------------------------------------------

/** A request the engine refuses before it reads anything. */
export class ExportRefusal extends Error {
  constructor(
    public code: IoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ExportRefusal'
  }
}

class ExportFailure extends Error {
  constructor(public error: IoError) {
    super(error.message)
    this.name = 'ExportFailure'
  }
}

class ExportCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'ExportCancelled'
  }
}

/** Combinations the form cannot produce are refused, never repaired (FR-IOX-015). */
export function checkExportRequest(req: ExportRequest, limits: Pick<IoLimitsResolved, 'formats' | 'compressions'>): void {
  if (!limits.formats.includes(req.format)) throw new ExportRefusal('format_disabled', 'This export format is not enabled')
  if (!limits.compressions.includes(req.compression))
    throw new ExportRefusal('format_disabled', 'This compression is not enabled')
  const single = req.scope.kind === 'table' || req.scope.kind === 'result'
  if (req.separateFiles && single)
    throw new ExportRefusal('invalid_request', 'Separate files need a database or server export')
  if (req.view === 'text') {
    if (req.compression !== 'none') throw new ExportRefusal('invalid_request', 'The text view cannot be compressed')
    if (req.separateFiles) throw new ExportRefusal('invalid_request', 'The text view holds one file')
    if (req.format === 'csv' && !single)
      throw new ExportRefusal('invalid_request', 'CSV of several tables is a zip file; pick one table for the text view')
  }
}

const isServerError = (e: unknown): e is { errno: number; sqlMessage?: string; message: string; fatal?: boolean } =>
  typeof e === 'object' && e !== null && typeof (e as { errno?: unknown }).errno === 'number' && (e as { errno: number }).errno > 0

// ---- Engine contract ----------------------------------------------------------------------------------------

export type ExportDeps = {
  pool: TargetPool
  temp: TempStore
  owner: TempOwner
  request: ExportRequest
  limits: ExportLimits
  /** Aborts on cancel; the engine stops, kills the query and removes the spool. */
  signal: AbortSignal
  /** Target label for `@SERVER@`. */
  serverLabel: string
  httpHost?: string
  dbloomVersion?: string
  now?: () => Date
  /** FR-SQL-026 hook, bound to the session's SQL environment by the service. */
  openResult?: (req: { db?: string; text: string; statementIndex: number }) => Promise<ResultStream>
  /** CSV: effective formula neutralisation (ST-157), resolved by the service. */
  neutraliseFormulas: boolean
  onProgress?: (patch: Partial<JobProgress>) => void
  /** Registers what stops the work; the engine calls it once, early. */
  onCancel?: (hook: () => void | Promise<void>) => void
}

export type ExportLimits = { maxExportBytes: number; jobMs: number }

export type ExportOutcome = {
  state: 'done' | 'done_with_skips' | 'failed' | 'cancelled'
  result: JobResult
  /** Committed spool file; set only for `done*`. */
  file?: TempFile
  fileName?: string
  contentType?: string
  textView: boolean
}

// ---- Plan ---------------------------------------------------------------------------------------------------------

type DbPlan = { name: string; objects: ObjectInfo[] }
type DbData = {
  name: string
  tables: ObjectInfo[]
  views: ObjectInfo[]
  columns: Map<string, ExportColumn[]>
  deferred: Record<string, string[]>
}
type Selection = {
  tables: ObjectInfo[]
  views: ObjectInfo[]
  routines: RoutineInfo[]
  triggers: TriggerInfo[]
  events: string[]
}
const EMPTY_PROGRAMS = { routines: [], triggers: [], events: [] } satisfies Pick<Selection, 'routines' | 'triggers' | 'events'>
type Hooks = {
  /** Called once, when the first batch (or the end of an empty table) has arrived. */
  start: () => Promise<void>
  batch: (rows: IoCell[][]) => Promise<void>
  end: () => Promise<void>
}
type Virtual = { db: string; table: string; columns: ExportColumn[]; rows: () => AsyncIterable<IoCell[]> }

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const FLUSH_BYTES = 64 * 1024

class ExportRun {
  private readonly req: ExportRequest
  private conn?: PoolConnection
  private resultStream?: ResultStream
  private writer?: StageWriter
  private sink?: ExportSink & { truncated?: boolean }
  /** A row stream was left unfinished: the connection can only be destroyed. */
  private dirty = false
  private locked = false
  private result: JobResult = { skipped: [], rejected: [], rejectedCount: 0, notes: [], durationMs: 0 }
  private rows = 0
  private index = 0
  private total = 0
  private lastLabel = ''
  private buf = ''
  private readonly started = Date.now()
  private readonly now: () => Date
  private serverVersion = ''
  private comp: Compression
  private fileBase = ''
  private entryNames = new Set<string>()
  private ctxBase: { server: string; database?: string; table?: string; columns?: string[]; httpHost?: string } = { server: '' }
  private template = ''
  private virtual?: Virtual
  private multiDb = false

  constructor(private d: ExportDeps) {
    this.req = d.request
    this.now = d.now ?? (() => new Date())
    this.comp = d.request.compression
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  private get textView() {
    return this.req.view === 'text'
  }
  private get scopeKind() {
    return this.req.scope.kind
  }
  private get skipAllowed() {
    return this.req.skipUnreadable && (this.scopeKind === 'server' || this.scopeKind === 'database')
  }
  /** One file per table or object in the output. */
  private get separate(): boolean {
    if (this.scopeKind !== 'server' && this.scopeKind !== 'database') return false
    return this.req.format === 'csv' || this.req.separateFiles
  }

  private check() {
    if (this.d.signal.aborted) throw new ExportCancelled()
    if (Date.now() - this.started > this.d.limits.jobMs)
      throw new ExportFailure({ code: 'time_limit', message: 'The export exceeded the time limit' })
  }

  private progress(extra: Partial<JobProgress> = {}) {
    this.d.onProgress?.({ bytes: this.sink?.bytes() ?? 0, rows: this.rows, ...extra })
  }

  private async flush() {
    if (this.buf === '') return
    const text = this.buf
    this.buf = ''
    await this.sink!.write(text)
  }

  private async put(text: string) {
    if (text === '') return
    this.check()
    this.buf += text
    if (this.buf.length >= FLUSH_BYTES) {
      await this.flush()
      this.progress()
    }
  }

  private async begin(entry: string) {
    await this.flush()
    await this.sink!.begin(entry)
  }
  private async endEntry() {
    await this.flush()
    await this.sink!.endEntry()
  }

  private touch(label: string) {
    this.check()
    if (label === this.lastLabel) return
    this.lastLabel = label
    this.index++
    this.progress({ object: { index: Math.min(this.index, this.total), total: this.total, name: label } })
  }

  private describe(e: unknown, label?: string): IoError {
    if (e instanceof ExportFailure) return e.error
    if (e instanceof ExportRefusal) return { code: e.code, message: e.message }
    if (e instanceof TempError) {
      if (e.code === 'upload_too_large')
        return { code: 'export_too_large', message: `The export is larger than the limit of ${formatBytes(this.d.limits.maxExportBytes)}` }
      if (e.code === 'quota_full') return { code: 'quota_full', message: 'The server has no room for the export file right now' }
      return { code: 'export_failed', message: 'The export file could not be written' }
    }
    const what = label ? `Could not export ${label}` : 'The export failed'
    if (e instanceof ObjectUnreadable) return { code: 'export_failed', message: `${what}: ${e.message}` }
    if (isServerError(e)) {
      const serverMessage = e.sqlMessage ?? e.message
      return { code: 'export_failed', message: `${what}: ${serverMessage}`, errno: e.errno, serverMessage }
    }
    const err = e as { code?: unknown; message?: unknown } | null
    if (err && typeof err.message === 'string' && /^(StructureRefusal)$/.test((e as Error).name))
      return { code: 'export_failed', message: `${what}: ${err.message}` }
    if (err && typeof err.code === 'string' && /^(PROTOCOL_|ECONN|ETIMEDOUT|EPIPE)/.test(err.code))
      return { code: 'export_failed', message: `${what}: the connection to the server was lost` }
    return { code: 'export_failed', message: what }
  }

  /**
   * Runs one object; a server error on an object nobody has read yet is skipped when the request allows it
   * (FR-IO-010), everything else fails the job with the object named.
   */
  private async guarded<T>(
    label: string,
    fn: () => Promise<T>,
    o: { canSkip?: () => boolean; onSkip: (message: string) => Promise<void> },
  ): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ExportCancelled || e instanceof TextLimitReached || e instanceof ExportFailure || e instanceof ExportRefusal) throw e
      if (this.d.signal.aborted) throw new ExportCancelled()
      const skippable =
        this.skipAllowed &&
        (o.canSkip?.() ?? true) &&
        ((isServerError(e) && e.fatal !== true) || e instanceof ObjectUnreadable)
      if (skippable) {
        const message = this.describe(e).serverMessage ?? (e as Error).message
        this.result.skipped.push({ object: label, message })
        await o.onSkip(message)
        return undefined
      }
      throw new ExportFailure(this.describe(e, label))
    }
  }

  // ---- main ---------------------------------------------------------------------------------------------------

  async run(): Promise<ExportOutcome> {
    this.d.onCancel?.(async () => {
      if (this.conn) {
        await killThreadQuery(this.d.pool, this.conn.threadId as number)
        try {
          this.conn.destroy()
        } catch {
          // the run destroys it too
        }
      }
      await this.resultStream?.close().catch(() => undefined)
    })
    let state: ExportOutcome['state'] = 'done'
    let file: TempFile | undefined
    let names: { entryName: string; downloadName: string } | undefined
    try {
      this.check()
      await this.connect()
      const dbs = await this.plan()
      names = this.setupNames(dbs)
      this.writer = await this.d.temp.begin(this.d.owner, 'spool', {
        name: names.downloadName,
        format: this.req.format,
        maxBytes: this.d.limits.maxExportBytes,
      })
      this.sink = createSink(this.comp, this.writer, { textLimit: this.textView ? TEXT_VIEW_MAX_BYTES : undefined })
      try {
        await this.emitAll(dbs, names.entryName)
        await this.flush()
      } catch (e) {
        if (!(e instanceof TextLimitReached)) throw e
        this.result.notes.push('The text view shows the first 2 MiB of the export.')
      }
      await this.sink.finish()
      file = await this.writer.commit()
      this.writer = undefined
      if (this.result.skipped.length > 0) state = 'done_with_skips'
    } catch (e) {
      state = this.d.signal.aborted || e instanceof ExportCancelled ? 'cancelled' : 'failed'
      this.result.error =
        state === 'cancelled' ? { code: 'cancelled', message: 'The export was cancelled' } : this.describe(e)
    } finally {
      this.sink?.destroy()
      await this.writer?.abort().catch(() => undefined)
      await this.release()
    }
    this.result.rows = this.rows
    this.result.durationMs = Date.now() - this.started
    if (names) this.result.fileName = names.downloadName
    return {
      state,
      result: this.result,
      ...(state === 'done' || state === 'done_with_skips'
        ? {
            file,
            fileName: names?.downloadName,
            contentType: this.textView ? 'text/plain; charset=utf-8' : contentTypeFor(this.req.format, this.comp),
          }
        : {}),
      textView: this.textView,
    }
  }

  private async release() {
    const conn = this.conn
    this.conn = undefined
    if (conn) {
      if (this.locked && !this.dirty) await conn.query('UNLOCK TABLES').catch(() => undefined)
      try {
        conn.destroy()
      } catch {
        // already destroyed by the cancel hook
      }
    }
    await this.resultStream?.close().catch(() => undefined)
  }

  // ---- connection and plan -------------------------------------------------------------------------------------

  private async connect() {
    if (this.req.scope.kind === 'result') {
      const [rows] = await this.d.pool.query('SELECT VERSION() AS v')
      this.serverVersion = String((rows as { v: unknown }[])[0]?.v ?? '')
      return
    }
    const conn = await this.d.pool.getConnection()
    this.conn = conn
    this.check()
    await conn.query("SET SESSION time_zone = '+00:00'")
    await conn.query('SET SESSION net_write_timeout = 3600').catch(() => undefined)
    // MySQL caches table sizes for a day; the size filter wants current ones.
    await conn.query('SET SESSION information_schema_stats_expiry = 0').catch(() => undefined)
    await conn.query('SET SESSION TRANSACTION READ ONLY')
    if (!this.req.lock) await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
    const [rows] = await conn.query('SELECT VERSION() AS v')
    this.serverVersion = String((rows as { v: unknown }[])[0]?.v ?? '')
  }

  private unknown(kind: string, name: string): never {
    throw new ExportFailure({ code: 'invalid_request', message: `Unknown ${kind}: ${name.slice(0, 80)}` })
  }

  private async plan(): Promise<DbPlan[]> {
    const scope = this.req.scope
    if (scope.kind === 'result') return []
    const conn = this.conn!
    let dbs: DbPlan[]
    if (scope.kind === 'server') {
      const all = await listUserDatabases(conn)
      const names = scope.databases ?? all
      for (const n of names) if (!all.includes(n)) this.unknown('database', n)
      dbs = []
      for (const n of [...new Set(names)].sort(byName)) dbs.push({ name: n, objects: await listObjects(conn, n) })
    } else {
      const db = await findDatabase(conn, scope.db)
      if (db === null) this.unknown('database', scope.db)
      const objects = await listObjects(conn, db)
      if (scope.kind === 'database') {
        const wanted = scope.tables
        if (wanted !== undefined) {
          const have = new Set(objects.map((o) => o.name))
          for (const t of wanted) if (!have.has(t)) this.unknown('table', t)
          const set = new Set(wanted)
          dbs = [{ name: db, objects: objects.filter((o) => set.has(o.name)) }]
        } else dbs = [{ name: db, objects }]
      } else {
        const one = objects.find((o) => o.name === scope.table)
        if (!one) this.unknown('table', scope.table)
        dbs = [{ name: db, objects: [one] }]
        this.ctxBase.columns = (await loadColumns(conn, db)).get(one.name)?.map((c) => c.name)
      }
    }
    this.multiDb = dbs.length > 1
    this.total = dbs.reduce((n, d) => n + d.objects.length, 0)
    if (this.req.lock) {
      const targets = dbs.flatMap((d) => d.objects.map((o) => `${q(d.name)}.${q(o.name)} READ`))
      if (targets.length > 0) {
        await conn.query(`LOCK TABLES ${targets.join(', ')}`)
        this.locked = true
      }
    }
    return dbs
  }

  private async loadDb(dbp: DbPlan, ordered: boolean): Promise<DbData> {
    if (this.virtual) {
      const t: ObjectInfo = { name: this.virtual.table, kind: 'table', engine: null, dataBytes: null }
      return { name: this.virtual.db, tables: [t], views: [], columns: new Map([[t.name, this.virtual.columns]]), deferred: {} }
    }
    const conn = this.conn!
    // With this database as the default, SHOW CREATE leaves its name out of views and triggers, so the dump restores into any database.
    await conn.query(`USE ${q(dbp.name)}`)
    const columns = await loadColumns(conn, dbp.name)
    const tables = dbp.objects.filter((o) => o.kind === 'table')
    const views = dbp.objects.filter((o) => o.kind === 'view')
    let deferred: Record<string, string[]> = {}
    let order = tables.map((t) => t.name)
    if (ordered && tables.length > 1) {
      const deps = await foreignKeyDeps(conn, dbp.name)
      const o = orderByDependency(tables.map((t) => ({ name: t.name, deps: deps.get(t.name) ?? [] })))
      order = o.order
      deferred = o.deferred
      for (const cycle of o.cycles)
        this.result.notes.push(`Foreign key cycle between ${cycle.join(', ')}: their keys are added after all data.`)
    }
    const info = new Map(tables.map((t) => [t.name, t]))
    return { name: dbp.name, tables: order.map((n) => info.get(n) as ObjectInfo), views, columns, deferred }
  }

  // ---- names ----------------------------------------------------------------------------------------------------

  private setupNames(dbs: DbPlan[]) {
    const scope = this.req.scope
    this.ctxBase = {
      server: this.d.serverLabel,
      httpHost: this.d.httpHost,
      ...(scope.kind === 'database' || scope.kind === 'table' ? { database: dbs[0]?.name } : {}),
      ...(scope.kind === 'result' && scope.db ? { database: scope.db } : {}),
      ...(scope.kind === 'table' ? { table: scope.table } : {}),
      ...(scope.kind === 'result' ? { table: 'export' } : {}),
    }
    this.template = this.req.fileNameTemplate ?? DEFAULT_TEMPLATES[scope.kind]
    // Zip of several objects: the container name cannot carry one table, so the table token is dropped.
    let template = this.template
    if (this.separate || this.comp === 'zip') {
      if (scope.kind === 'server' || scope.kind === 'database')
        template = template.replaceAll('@TABLE@', '').replace(/[_.\-\s]+$/, '') || 'export'
    }
    // The zip that holds several files (CSV of a database, separate files) is forced.
    if (!this.textView && this.separate && this.comp !== 'zip') {
      this.comp = 'zip'
      this.result.notes.push('The output is a zip file because it holds one file per table.')
    }
    const names = buildFileNames(template, { ...this.ctxBase, now: this.now() }, this.req.format, this.comp)
    this.fileBase = names.entryName
    return names
  }

  /** Name of the file of one object inside a zip (FR-IOX-085): the template with the table token, else `<base>_<object>.<ext>`. */
  private entryFor(db: string, object: string): string {
    const scopeKind = this.scopeKind
    let name: string
    if (this.template.includes('@TABLE@') && scopeKind !== 'table' && scopeKind !== 'result') {
      name = buildFileNames(
        this.template,
        { ...this.ctxBase, database: scopeKind === 'server' ? db : this.ctxBase.database, table: object, now: this.now() },
        this.req.format,
        'none',
      ).entryName
    } else {
      name = separateEntryName(this.fileBase, scopeKind === 'server' ? `${db}_${object}` : object)
    }
    let unique = name
    for (let n = 2; this.entryNames.has(unique); n++) {
      const dot = name.lastIndexOf('.')
      unique = dot > 0 ? `${name.slice(0, dot)}_${n}${name.slice(dot)}` : `${name}_${n}`
    }
    this.entryNames.add(unique)
    return unique
  }

  // ---- emission -----------------------------------------------------------------------------------------------

  private async emitAll(dbs: DbPlan[], entryName: string) {
    if (this.req.scope.kind === 'result') await this.openVirtual()
    const plans: DbPlan[] = this.virtual
      ? [{ name: this.virtual.db, objects: [{ name: this.virtual.table, kind: 'table', engine: null, dataBytes: null }] }]
      : dbs
    if (this.virtual) this.total = 1
    if (this.req.format === 'sql') await this.emitSql(plans, entryName)
    else if (this.req.format === 'csv') await this.emitCsv(plans, entryName)
    else await this.emitJson(plans, entryName)
  }

  private async openVirtual() {
    const scope = this.req.scope
    if (scope.kind !== 'result') return
    if (!this.d.openResult) throw new ExportRefusal('invalid_request', 'Exporting a result is not available here')
    const stream = await this.d.openResult({ db: scope.db, text: scope.text, statementIndex: scope.statementIndex })
    this.resultStream = stream
    const fields = stream.fields ?? []
    const columns: ExportColumn[] = stream.columns.map((c, i) => {
      const kind = kindOfWireType(fields[i]?.columnType ?? Number(c.type), fields[i]?.binary ?? false)
      return {
        name: c.name,
        kind,
        type: kind,
        ...(kind === 'binary' || kind === 'blob' ? { binary: true } : {}),
        ...(kind === 'geometry' ? { geometry: true } : {}),
        ...(kind === 'bit' ? { bit: true } : {}),
      }
    })
    // One table behind every column gives the INSERT its name; anything else is `export`.
    const tables = new Set(stream.columns.map((c) => c.table).filter((t): t is string => !!t))
    const table = tables.size === 1 ? ([...tables][0] as string) : 'export'
    this.ctxBase.columns = columns.map((c) => c.name)
    const geometry = columns.findIndex((c) => c.geometry)
    const rawRows = stream.rows as AsyncGenerator<unknown[], void, void>
    this.virtual = {
      db: scope.db ?? '',
      table,
      columns,
      rows: () =>
        (async function* () {
          for await (const row of rawRows) {
            if (geometry >= 0 && row[geometry] !== null)
              throw new ExportFailure({
                code: 'export_failed',
                message: `Column ${columns[geometry]!.name} holds geometry; wrap it in ST_AsText() or HEX() to export it`,
              })
            yield row.map(toCell)
          }
        })(),
    }
  }

  private optionsSql(): SqlExportOptions {
    const o = this.req.options as SqlExportOptions
    const multi = this.multiDb
    const createDatabase = (o.createDatabase || multi || this.scopeKind === 'server') && o.content !== 'data' && !this.virtual
    return { ...o, createDatabase }
  }

  // ---- table data (shared by the three formats) ------------------------------------------------------------------

  private sizeSkipped(t: ObjectInfo, label: string): boolean {
    const scope = this.req.scope
    if (scope.kind !== 'database' || scope.maxTableMiB === undefined) return false
    if (t.dataBytes === null || t.dataBytes <= scope.maxTableMiB * MiB) return false
    this.result.skipped.push({ object: label, message: `Larger than ${scope.maxTableMiB} MiB` })
    return true
  }

  private async dataOf(
    db: string,
    t: ObjectInfo,
    columns: ExportColumn[],
    hooks: Hooks,
    onSkip: (message: string) => Promise<void>,
  ) {
    const label = this.virtual ? 'result' : `${db}.${t.name}`
    let started = false
    await this.guarded(
      label,
      async () => {
        let source: AsyncIterable<IoCell[]>
        if (this.virtual) source = this.virtual.rows()
        else {
          const scope = this.req.scope
          const range = scope.kind === 'table' ? scope.range : undefined
          const order = range ? await primaryKeyColumns(this.conn!, db, t.name) : []
          source = streamSelect(this.conn!, selectSql(db, t.name, columns, range, order))
        }
        this.dirty = true
        try {
          for await (const batch of batchRows(source)) {
            this.check()
            if (!started) {
              await hooks.start()
              started = true
            }
            await hooks.batch(batch)
            this.rows += batch.length
            this.progress()
          }
          if (!started) {
            await hooks.start()
            started = true
          }
          await hooks.end()
          this.dirty = false
        } finally {
          // left set when the loop was left early: the stream is unfinished
        }
      },
      { canSkip: () => !started, onSkip },
    )
  }

  // ---- SQL ----------------------------------------------------------------------------------------------------------

  private header() {
    return {
      type: 'header' as const,
      dbloomVersion: this.d.dbloomVersion ?? DBLOOM_VERSION,
      serverVersion: this.serverVersion,
      generatedAt: this.now(),
    }
  }

  private async emitSql(dbs: DbPlan[], entryName: string) {
    const o = this.optionsSql()
    const separate = this.separate
    if (!separate) await this.begin(entryName)
    for (const dbp of dbs) {
      const d = await this.loadDb(dbp, true)
      const scope = this.req.scope
      // routines and events belong to the database; a table selection takes only the triggers of its tables
      const whole = scope.kind === 'server' || (scope.kind === 'database' && scope.tables === undefined)
      const exported = new Set(dbp.objects.map((x) => x.name))
      const programs: Pick<Selection, 'routines' | 'triggers' | 'events'> =
        this.virtual || o.content === 'data'
          ? EMPTY_PROGRAMS
          : {
              routines: o.routines && whole ? await listRoutines(this.conn!, d.name) : [],
              triggers: o.triggers ? (await listTriggers(this.conn!, d.name)).filter((t) => exported.has(t.table)) : [],
              events: o.events && whole ? await listEvents(this.conn!, d.name) : [],
            }
      const full: Selection = { tables: d.tables, views: d.views, ...programs }
      if (!separate) {
        // With foreign_key_checks off a CREATE TABLE may name a table that does not exist yet, so a dump that must
        // import twice (IF NOT EXISTS) keeps cycle keys inside CREATE TABLE: an ALTER ... ADD CONSTRAINT is not repeatable.
        const deferred = o.ifNotExists && o.foreignKeyChecksOff ? {} : d.deferred
        await this.sqlBlock(o, d, full, deferred, o.tableStatementsTogether)
      } else {
        for (const t of d.tables) {
          await this.sqlUnit(o, d, { tables: [t], views: [], ...EMPTY_PROGRAMS }, t.name)
        }
        for (const v of d.views) {
          await this.sqlUnit(o, d, { tables: [], views: [v], ...EMPTY_PROGRAMS }, v.name)
        }
        for (const section of ['routines', 'triggers', 'events'] as const) {
          if (full[section].length === 0) continue
          await this.sqlUnit(o, d, { tables: [], views: [], ...EMPTY_PROGRAMS, [section]: full[section] }, section)
        }
      }
    }
    if (!separate) await this.endEntry()
  }

  private async sqlUnit(o: SqlExportOptions, d: DbData, sel: Selection, objectName: string) {
    await this.begin(this.entryFor(d.name, objectName))
    await this.sqlBlock(o, d, sel, {}, true)
    await this.endEntry()
  }

  /** header, database, objects, data, footer of one writer instance (one database, or one file). */
  private async sqlBlock(o: SqlExportOptions, d: DbData, sel: Selection, deferred: Record<string, string[]>, together: boolean) {
    const w = new SqlWriter(o)
    const wantStructure = o.content !== 'data'
    const wantData = o.content !== 'structure'
    const virtual = this.virtual !== undefined
    await this.put(w.write(this.header()))
    if (!virtual) {
      let createText: string | undefined
      if (o.createDatabase) createText = await showCreate(this.conn!, 'database', d.name, d.name).catch(() => undefined)
      await this.put(w.write({ type: 'database', name: d.name, createText }))
      // Several databases without CREATE DATABASE (data only): the file still has to say where rows go.
      if (!o.createDatabase && this.multiDb && wantData) await this.put(`USE ${q(d.name)};\n\n`)
    }
    const failedStructure = new Set<string>()
    const skipMarker = (label: string) => async () => {
      await this.put(`-- skipped: ${commentSafe(label)}\n\n`)
    }

    const structureOf = async (t: ObjectInfo) => {
      if (virtual || !wantStructure) return
      const label = `${d.name}.${t.name}`
      this.touch(label)
      await this.guarded(
        label,
        async () => {
          const createText = await showCreate(this.conn!, 'table', d.name, t.name)
          await this.put(w.write({ type: 'object', kind: 'table', database: d.name, name: t.name, createText, deferForeignKeysTo: deferred[t.name] }))
        },
        {
          onSkip: async () => {
            failedStructure.add(t.name)
            await skipMarker(label)()
          },
        },
      )
    }

    const dataOfTable = async (t: ObjectInfo) => {
      if (!wantData || failedStructure.has(t.name)) return
      const label = this.virtual ? 'result' : `${d.name}.${t.name}`
      if (!wantStructure) this.touch(label)
      if (!virtual && this.sizeSkipped(t, label)) {
        await skipMarker(label)()
        return
      }
      const cols = (d.columns.get(t.name) ?? []).filter((c) => !c.generated)
      if (cols.length === 0) return
      await this.dataOf(
        d.name,
        t,
        cols,
        {
          start: async () => {},
          batch: async (rows) => {
            await this.put(w.write({ type: 'row-batch', database: d.name, table: t.name, columns: cols, rows }))
          },
          end: async () => {
            await this.put(w.write({ type: 'table-end' }))
          },
        },
        async () => {
          await skipMarker(label)()
        },
      )
    }

    for (const t of sel.tables) {
      await structureOf(t)
      if (together) await dataOfTable(t)
    }
    if (!together) for (const t of sel.tables) await dataOfTable(t)

    if (wantStructure && !virtual) {
      if (o.views && sel.views.length > 0) await this.sqlViews(w, d, sel.views)
      for (const r of sel.routines) await this.sqlObject(w, d.name, r.kind, r.name, skipMarker)
      for (const t of sel.triggers) await this.sqlObject(w, d.name, 'trigger', t.name, skipMarker)
      for (const e of sel.events) await this.sqlObject(w, d.name, 'event', e, skipMarker)
    }
    await this.put(w.write({ type: 'footer' }))
  }

  private async sqlObject(
    w: SqlWriter,
    db: string,
    kind: Exclude<CreateKind, 'database' | 'table'>,
    name: string,
    skipMarker: (label: string) => () => Promise<void>,
    prefetched?: string | Error,
  ) {
    const label = `${db}.${name}`
    if (kind === 'view') this.touch(label)
    await this.guarded(
      label,
      async () => {
        if (prefetched instanceof Error) throw prefetched
        const createText = prefetched ?? (await showCreate(this.conn!, kind, db, name))
        await this.put(w.write({ type: 'object', kind, database: db, name, createText }))
      },
      { onSkip: skipMarker(label) },
    )
  }

  /** Views in dependency order: referenced views first (Q7), ties by name. */
  private async sqlViews(w: SqlWriter, d: DbData, views: ObjectInfo[]) {
    const texts = new Map<string, string | Error>()
    for (const v of views) {
      try {
        texts.set(v.name, await showCreate(this.conn!, 'view', d.name, v.name))
      } catch (e) {
        texts.set(v.name, e instanceof Error ? e : new Error('unreadable'))
      }
    }
    const names = views.map((v) => v.name)
    const order = orderByDependency(
      views.map((v) => {
        const t = texts.get(v.name)
        return { name: v.name, deps: typeof t === 'string' ? viewReferences(t, d.name, names.filter((n) => n !== v.name)) : [] }
      }),
    )
    const marker = (label: string) => async () => {
      await this.put(`-- skipped: ${commentSafe(label)}\n\n`)
    }
    for (const name of order.order) await this.sqlObject(w, d.name, 'view', name, marker, texts.get(name))
  }

  // ---- CSV ----------------------------------------------------------------------------------------------------------

  private csvSettings() {
    const o = this.req.options as CsvExportOptions
    const excel = o.preset === 'excel'
    const writer = new CsvWriter({
      separator: excel ? ';' : o.separator,
      enclosure: excel ? '"' : o.enclosure,
      escape: excel ? '"' : o.escape,
      lineEnding: excel ? 'crlf' : o.lineEnding,
      nullText: excel && o.nullText === '' ? 'NULL' : o.nullText,
    })
    const nullText = excel && o.nullText === '' ? 'NULL' : o.nullText
    return {
      writer,
      header: o.header,
      bom: o.bom,
      cell: { nullText, neutraliseFormulas: this.d.neutraliseFormulas, lineBreaks: o.removeLineBreaks ? ('remove' as const) : excel ? ('lf' as const) : ('keep' as const) },
    }
  }

  private async emitCsv(dbs: DbPlan[], entryName: string) {
    const s = this.csvSettings()
    const separate = this.separate
    if (!separate) await this.begin(entryName)
    let opened = false
    const headCol: ExportColumn = { name: '', kind: 'char', type: 'char' }
    for (const dbp of dbs) {
      const d = await this.loadDb(dbp, false)
      const objects = this.virtual ? d.tables : dbp.objects
      for (const t of objects) {
        const label = this.virtual ? 'result' : `${d.name}.${t.name}`
        this.touch(label)
        if (!this.virtual && this.sizeSkipped(t, label)) continue
        const cols = d.columns.get(t.name) ?? []
        if (cols.length === 0) continue
        await this.dataOf(
          d.name,
          t,
          cols,
          {
            start: async () => {
              if (separate) await this.begin(this.entryFor(d.name, t.name))
              else if (opened) throw new Error('A CSV file holds one table')
              opened = true
              let head = s.bom ? UTF8_BOM : ''
              if (s.header)
                head += s.writer.line(cols.map((c) => csvCellText(c.name, headCol, s.cell)))
              await this.put(head)
            },
            batch: async (rows) => {
              let out = ''
              for (const row of rows)
                out += s.writer.line(
                  cols.map((c, i) => csvCellText(row[i] ?? null, c, s.cell)),
                  cols.map((_, i) => (row[i] ?? null) === null),
                )
              await this.put(out)
            },
            end: async () => {
              if (separate) await this.endEntry()
            },
          },
          async () => {},
        )
      }
    }
    if (!separate) await this.endEntry()
  }

  // ---- JSON ---------------------------------------------------------------------------------------------------------

  private async emitJson(dbs: DbPlan[], entryName: string) {
    const o = this.req.options as { pretty: boolean; unicode: boolean }
    const version = this.d.dbloomVersion ?? DBLOOM_VERSION
    const separate = this.separate
    let j = new JsonExportWriter(o)
    if (!separate) {
      await this.begin(entryName)
      await this.put(j.begin(version))
    }
    for (const dbp of dbs) {
      const d = await this.loadDb(dbp, false)
      if (!separate && d.name !== '') await this.put(j.database(d.name))
      const objects = this.virtual ? d.tables : dbp.objects
      for (const t of objects) {
        const label = this.virtual ? 'result' : `${d.name}.${t.name}`
        this.touch(label)
        if (!this.virtual && this.sizeSkipped(t, label)) continue
        const cols = d.columns.get(t.name) ?? []
        await this.dataOf(
          d.name,
          t,
          cols,
          {
            start: async () => {
              if (separate) {
                j = new JsonExportWriter(o)
                await this.begin(this.entryFor(d.name, t.name))
                await this.put(j.begin(version))
                await this.put(j.database(d.name))
              }
              await this.put(j.tableStart(d.name, t.name, cols.map((c) => ({ name: c.name, type: c.type }))))
            },
            batch: async (rows) => {
              await this.put(j.rowsOf(cols, rows))
            },
            end: async () => {
              await this.put(j.tableEnd())
              if (separate) {
                await this.put(j.end())
                await this.endEntry()
              }
            },
          },
          async (message) => {
            if (!separate) await this.put(j.skipped(label, message))
          },
        )
      }
    }
    if (!separate) {
      await this.put(j.end())
      await this.endEntry()
    }
  }
}

/** Runs one export to completion. Never throws for export failures; the outcome says what happened. */
export async function runExport(deps: ExportDeps): Promise<ExportOutcome> {
  return new ExportRun(deps).run()
}
