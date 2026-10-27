/**
 * Plain functions behind the import server functions (FR-IO-016..021): start, resume and the server import
 * folder. The order in `startImportImpl` is the order of the spec: read-only refuses first, then the analysis of
 * this session must exist, then policy (refused statements, database, confirmation token), then the job.
 */
import { WriteGuardError, assertWritable } from '../guard/write-guard'
import { createTokenIssuer } from '../guard/confirm-token'
import { getRuntime } from '../runtime'
import type { LiveSession } from '../sessions'
import { loadRowTable } from '../rows/model'
import { serverInfoOf } from '../sql/run'
import * as fx from '../sql/fixed'
import { previewImpl } from '../structure/service'
import { tableDefinition, type TableDefinition } from '../structure/types'
import { auditIo } from '../audit'
import { ioEnvOf } from './http'
import { JobError } from './jobs'
import { analysisOf, resolveSource, tokenPlan, tokenTarget, type ImportEnv } from './analyse'
import { listFolder, type FolderEntry } from './folder'
import { IoFailure, failure, asIoFailure } from './import-source'
import { type ImportRunEnv } from './import-job'
import { resolveMapping, runRowImport, rowResumes, type RowSourceOptions } from './import-rows'
import { runSqlImport, sqlResumes } from './import-sql'
import {
  rowImportOptions,
  sqlImportOptions,
  startImportRequest,
  type StartImportRequest,
} from './types'

const tokens = createTokenIssuer()

/** A runner ends its own job; this only keeps an unexpected throw from becoming an unhandled rejection. */
const swallow = (): void => undefined

export function importEnvOf(session: LiveSession): ImportEnv {
  const runtime = getRuntime()
  const e = ioEnvOf(session, runtime)
  return {
    session: { idHash: session.idHash, target: session.target },
    pool: session.pool,
    guard: { forcedReadOnly: runtime.config.readOnly, sessionReadOnly: session.readOnly },
    tokens,
    temp: e.temp,
    jobs: e.jobs,
    owner: e.owner,
    limits: e.limits,
    targetLabel: e.targetLabel,
    statementTimeoutMs: runtime.config.statementTimeoutMs,
    ...(runtime.config.importDir ? { importDir: runtime.config.importDir } : {}),
  }
}

/** `code: message` for the client; unexpected errors stay as they are (the caller's wrapper hides them). */
export function toClientImportError(e: unknown): Error {
  const f = asIoFailure(e)
  if (f instanceof IoFailure) return new Error(`${f.error.code}: ${f.error.message}`)
  if (e instanceof WriteGuardError) return new Error(`read_only: ${e.message}`)
  return e instanceof Error ? e : new Error('unexpected_error')
}

const SQL_KEYS = Object.keys(sqlImportOptions.shape)
const ROW_KEYS = Object.keys(rowImportOptions.shape)
const pickKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)))

function guardWritable(env: ImportEnv): void {
  try {
    assertWritable(env.guard)
  } catch (e) {
    if (e instanceof WriteGuardError) {
      throw failure('read_only', 'The connection is read-only; imports are not available')
    }
    throw e
  }
}

async function schemaExists(env: ImportEnv, db: string): Promise<boolean> {
  const [rows] = await env.pool.query(fx.SCHEMA_EXISTS, [db])
  return (rows as unknown[]).length > 0
}

function runEnvOf(
  env: ImportEnv,
  jobId: string,
  product: ImportRunEnv['product'],
  fileName: string,
): ImportRunEnv {
  return {
    pool: env.pool,
    jobs: env.jobs,
    temp: env.temp,
    jobId,
    user: env.owner.user,
    targetLabel: env.targetLabel,
    jobMs: env.limits.jobMs,
    decompressedBytes: env.limits.decompressedBytes,
    product,
    fileName,
    ...(env.now ? { now: env.now } : {}),
  }
}

function startJob(env: ImportEnv): string {
  try {
    return env.jobs.create(env.owner, 'import', { maxImports: env.limits.concurrentImports }).id
  } catch (e) {
    if (e instanceof JobError) throw failure('busy', 'An import is already running; wait for it to end')
    throw e
  }
}

const kindsText = (k: Record<string, number>) =>
  Object.entries(k)
    .map(([name, n]) => `${n} ${name}`)
    .join(', ')

export async function startImportImpl(env: ImportEnv, raw: unknown): Promise<{ jobId: string }> {
  // Read-only refuses before anything else, with no target connection (SEC-TGT-052).
  guardWritable(env)
  const req: StartImportRequest = startImportRequest.parse(raw)
  const rec = analysisOf(env.owner, req.uploadId)
  if (!rec) throw failure('invalid_request', 'Analyse the file before importing it')
  if (!env.limits.formats.includes(req.format)) throw failure('format_disabled', 'This file format is not enabled')
  if (req.format !== rec.format || (req.charset ?? '') !== (rec.charsetRequested ?? '')) {
    throw failure('invalid_request', 'The file was analysed with other settings; analyse it again')
  }
  const source = await resolveSource(env, req.uploadId)
  const analysis = rec.analysis
  const input = req.options as Record<string, unknown>

  if (req.format === 'sql') {
    const options = sqlImportOptions.parse(pickKeys(input, SQL_KEYS))
    const st = analysis.statements
    if (!st) throw failure('invalid_request', 'The analysis has no statements')
    if (st.byClass.refused > 0 && !options.skipRefused) {
      throw failure('refused_statement', `The file contains statements that are not allowed in an import: ${kindsText(st.refusedKinds)}`)
    }
    if (st.needsDatabase && !req.db) {
      throw failure('needs_database', 'The script needs a database; select one first')
    }
    if (req.db !== undefined && !(await schemaExists(env, req.db))) {
      throw failure('invalid_request', 'The selected database does not exist')
    }
    let hardAllowed = false
    if (analysis.confirmRequired) {
      try {
        env.tokens.verifyAndConsume(req.confirmToken, {
          sessionId: env.owner.sessionId,
          target: tokenTarget(env),
          planId: tokenPlan(source.id),
          statementsHash: analysis.analysisHash,
        }, (env.now ?? Date.now)())
      } catch (e) {
        if (e instanceof WriteGuardError) {
          throw failure(e.code === 'token-missing' ? 'confirm_required' : 'confirm_invalid', e.message)
        }
        throw e
      }
      hardAllowed = true
    }
    const info = await serverInfoOf(env.pool)
    const jobId = startJob(env)
    env.jobs.start(jobId)
    auditIo('io.import.start', {
      user: env.owner.user, target: env.targetLabel, jobId, kind: 'import', format: 'sql',
      compression: analysis.compression, db: req.db, fileName: source.name, bytes: source.bytes,
      statements: st.total,
    })
    void runSqlImport({
      env: runEnvOf(env, jobId, info.product, source.name),
      source,
      charset: req.charset,
      db: req.db,
      options,
      fkOff: options.foreignKeyChecksOff ?? true,
      hardAllowed,
      totalBytes: rec.decodedBytes,
    }).catch(swallow)
    return { jobId }
  }

  // CSV and JSON
  if (!req.db) throw failure('needs_database', 'Select the database of the table first')
  if ((req.table === undefined) === (req.newTable === undefined)) {
    throw failure('invalid_request', 'Name either an existing table or a new table')
  }
  if (!(await schemaExists(env, req.db))) throw failure('invalid_request', 'The selected database does not exist')
  const options: RowSourceOptions = rowImportOptions.parse(pickKeys(input, ROW_KEYS))
  let table = req.table
  let createSql: string[] | undefined
  if (req.newTable !== undefined) {
    const def: TableDefinition = tableDefinition.parse({ ...(req.newTable as object), db: req.db })
    table = def.name
    try {
      const plan = await previewImpl(
        { session: { idHash: env.session.idHash, target: env.session.target, pool: env.pool }, guard: env.guard, tokens: env.tokens, statementTimeoutMs: env.statementTimeoutMs },
        { action: 'createTable', table: def },
      )
      if (plan.confirmRequired) throw failure('invalid_request', 'The table definition needs a confirmation')
      createSql = plan.statements.map((s) => s.sql)
    } catch (e) {
      if (e instanceof IoFailure) throw e
      throw failure('invalid_request', e instanceof Error ? e.message.replace(/^[a-z_]+: /, '') : 'The table definition is not valid')
    }
  } else {
    let model
    try {
      model = await loadRowTable(env.pool, req.db, req.table as string)
    } catch {
      throw failure('invalid_request', 'The table does not exist')
    }
    // A mapping that cannot work is refused now, not after the job started.
    resolveMapping(analysis.rows?.columns ?? [], rec.named === true, req.mapping, model)
  }
  const info = await serverInfoOf(env.pool)
  const jobId = startJob(env)
  env.jobs.start(jobId)
  auditIo('io.import.start', {
    user: env.owner.user, target: env.targetLabel, jobId, kind: 'import', format: req.format,
    compression: analysis.compression, db: req.db, objects: table, fileName: source.name,
    bytes: source.bytes, rows: analysis.rows?.rowCount ?? undefined,
  })
  void runRowImport({
    env: runEnvOf(env, jobId, info.product, source.name),
    source,
    format: req.format as 'csv' | 'json',
    charset: req.charset,
    db: req.db,
    table: table as string,
    ...(createSql ? { createSql } : {}),
    options,
    mapping: req.mapping,
    totalBytes: rec.decodedBytes,
  }).catch(swallow)
  return { jobId }
}

/** Continues a paused import from its resume point (FR-IO-020); no second token is needed. */
export async function resumeImportImpl(env: ImportEnv, raw: { jobId: string }): Promise<{ jobId: string }> {
  guardWritable(env)
  const jobId = String(raw.jobId)
  const job = env.jobs.get(jobId, env.owner)
  if (!job || job.kind !== 'import') throw failure('invalid_request', 'Unknown job')
  if (job.state !== 'paused') throw failure('invalid_request', 'Only a paused import can be resumed')
  const sql = sqlResumes.get(jobId)
  const rows = rowResumes.get(jobId)
  const ctx = sql ?? rows
  if (!ctx) throw failure('file_gone', 'The resume point is no longer available; start again')
  let source
  try {
    source = await resolveSource(env, ctx.sourceId)
  } catch (e) {
    const f = asIoFailure(e)
    if (f instanceof IoFailure && f.error.code === 'upload_unknown') {
      throw failure('file_gone', 'The file is no longer available; upload it again')
    }
    throw e
  }
  const info = await serverInfoOf(env.pool)
  try {
    env.jobs.resume(jobId, env.owner, env.limits.concurrentImports)
  } catch (e) {
    if (e instanceof JobError) throw failure(e.code === 'busy' ? 'busy' : 'invalid_request', e.message)
    throw e
  }
  auditIo('io.job.resume', {
    user: env.owner.user, target: env.targetLabel, jobId, kind: 'import',
    statementNumber: sql?.statementNumber ?? rows?.lastRow,
  })
  if (sql) {
    void runSqlImport({
      env: runEnvOf(env, jobId, info.product, source.name),
      source,
      charset: sql.charset,
      db: sql.db,
      options: sql.options,
      fkOff: sql.fkOff,
      hardAllowed: sql.hardAllowed,
      totalBytes: sql.totalBytes,
      resume: sql,
    }).catch(swallow)
  } else if (rows) {
    void runRowImport({
      env: runEnvOf(env, jobId, info.product, source.name),
      source,
      format: rows.format,
      charset: rows.charset,
      db: rows.db,
      table: rows.table,
      options: rows.options,
      mapping: rows.mapping,
      totalBytes: rows.totalBytes,
      resume: rows,
    }).catch(swallow)
  }
  return { jobId }
}

/** Files of the server import folder (FR-IO-013); `not_enabled` when the folder is off. */
export async function listImportFolderImpl(env: ImportEnv): Promise<FolderEntry[]> {
  if (!env.limits.serverFolderEnabled || !env.importDir) {
    throw failure('not_enabled', 'The server import folder is not enabled')
  }
  return listFolder(env.importDir)
}
