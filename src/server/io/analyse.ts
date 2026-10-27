/**
 * Analysis of an uploaded or server-folder file before anything runs (FR-IO-016): compression and format by
 * content, charset, size, and either the statement classes of an SQL script (policy of spec 5.7) or the
 * columns, a sample, the row count and the inferred types of a CSV or JSON file. Nothing is executed. When a
 * statement is `hard`, a confirmation token bound to this analysis is issued (SEC-TGT-118).
 */
import { createHash } from 'node:crypto'
import type { TargetPool } from '../db/target-pool'
import type { LiveSession } from '../sessions'
import type { TokenIssuer } from '../guard/confirm-token'
import type { GuardContext } from '../structure/types'
import * as fx from '../sql/fixed'
import { serverInfoOf } from '../sql/run'
import { audit } from '../audit'
import { resolveFolderFile, FOLDER_ID } from './folder'
import { failure, openDecoded, type ImportSource } from './import-source'
import { StatementStream, SqlModeTracker, classifyImportStatement, parserReady } from './import-sql'
import { scanRowFile, type RowSourceOptions } from './import-rows'
import type { JobRegistry, JobOwner } from './jobs'
import type { IoLimitsResolved } from './limits'
import type { TempOwner, TempStore } from './temp'
import {
  analyseRequest,
  rowImportOptions,
  type ImportAnalysis,
  type ImportStatementClass,
  type IoFormat,
} from './types'

/** Everything the import functions need from the request context. */
export type ImportEnv = {
  session: { idHash: string; target: LiveSession['target'] }
  pool: TargetPool
  guard: GuardContext
  tokens: TokenIssuer
  temp: TempStore
  jobs: JobRegistry
  owner: JobOwner & TempOwner
  limits: IoLimitsResolved
  /** Audit and token label of the target (`host[zone]:port`). */
  targetLabel: string
  /** Statement timeout of the structure module (new-table preview). */
  statementTimeoutMs: number
  /** `DBLOOM_IMPORT_DIR`. */
  importDir?: string
  now?: () => number
}

export const TOKEN_TTL_MS = 30 * 60_000
const MAX_RECORDS = 500
const MAX_KINDS = 50
const SAMPLE_CHARSET = 'utf-8'

export type AnalysisRecord = {
  analysis: ImportAnalysis
  sourceId: string
  decodedBytes: number
  /** What the user asked for; `startImport` must agree. */
  format: IoFormat
  charsetRequested?: string
  rowOptions?: RowSourceOptions
  /** Row files: column names are real names (header or JSON keys), for the mapping check at start. */
  named?: boolean
  owner: JobOwner
  createdAt: number
}

const records = new Map<string, AnalysisRecord>()
const keyOf = (o: JobOwner, id: string) => `${o.sessionId}\u0000${o.user}\u0000${id}`

export function rememberAnalysis(rec: AnalysisRecord): void {
  const key = keyOf(rec.owner, rec.sourceId)
  records.delete(key)
  records.set(key, rec)
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next()
    if (oldest.done) break
    records.delete(oldest.value)
  }
}

/** The analysis made in this session for this file, or undefined. */
export const analysisOf = (owner: JobOwner, id: string): AnalysisRecord | undefined =>
  records.get(keyOf(owner, id))

export const forgetAnalysis = (owner: JobOwner, id: string): void => void records.delete(keyOf(owner, id))

// ---- Sources --------------------------------------------------------------------------------------------------------

/** A staged upload of this owner, or a file of the server import folder. Other ids are unknown. */
export async function resolveSource(env: ImportEnv, id: string): Promise<ImportSource> {
  if (FOLDER_ID.test(id)) {
    if (!env.limits.serverFolderEnabled || !env.importDir) {
      throw failure('not_enabled', 'The server import folder is not enabled')
    }
    return resolveFolderFile(env.importDir, id)
  }
  const file = env.temp.get(id, env.owner)
  if (!file || file.kind !== 'upload') {
    throw failure('upload_unknown', 'The file is not available; upload it again')
  }
  return { id: file.id, kind: 'upload', path: file.path, name: file.name, bytes: file.bytes }
}

// ---- Analysis ---------------------------------------------------------------------------------------------------------

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const emptyClasses = (): Record<ImportStatementClass, number> => ({ none: 0, soft: 0, hard: 0, refused: 0 })

function bump(map: Record<string, number>, key: string): void {
  if (key in map || Object.keys(map).length < MAX_KINDS) map[key] = (map[key] ?? 0) + 1
  else map.other = (map.other ?? 0) + 1
}

export async function analyseImportImpl(
  env: ImportEnv,
  raw: unknown,
  signal?: AbortSignal,
): Promise<ImportAnalysis> {
  const req = analyseRequest.parse(raw)
  const now = env.now ?? Date.now
  if (!env.limits.formats.includes(req.format)) throw failure('format_disabled', 'This file format is not enabled')
  const source = await resolveSource(env, req.uploadId)
  const rowOptions: RowSourceOptions | undefined =
    req.format === 'sql' ? undefined : (req.rowOptions ?? rowImportOptions.parse({}))
  const content = createHash('sha256')
  const decoded = await openDecoded(source, env.limits, req.charset, (chunk) => content.update(chunk))
  const started = now()
  const overTime = () => signal?.aborted === true || now() - started > env.limits.jobMs

  let statements: ImportAnalysis['statements']
  let rows: ImportAnalysis['rows']
  let named = false
  try {
    if (req.format === 'sql') {
      const info = await serverInfoOf(env.pool)
      const [modeRows] = await env.pool.query(fx.SELECT_SQL_MODE)
      const mode = String(((modeRows as { m?: unknown }[])[0] ?? {}).m ?? '')
      const tracker = new SqlModeTracker(mode)
      const parser = await parserReady()
      const stream = new StatementStream({ lex: tracker.lexOptions() })
      const byClass = emptyClasses()
      const hardKinds: Record<string, number> = {}
      const refusedKinds: Record<string, number> = {}
      const creates = new Set<string>()
      const drops = new Set<string>()
      let total = 0
      let usesDatabase = false
      let needsDatabase = false
      const handle = (st: NonNullable<ReturnType<StatementStream['next']>>) => {
        if (st.flags.empty) return
        total++
        const v = classifyImportStatement(st, { product: info.product, lex: tracker.lexOptions(), parser })
        byClass[v.tier]++
        if (v.tier === 'hard') bump(hardKinds, v.label)
        if (v.tier === 'refused') bump(refusedKinds, v.label)
        const c = v.classification
        if (c.kind === 'use') usesDatabase = true
        else if (!usesDatabase && c.tables?.some((t) => t.db === undefined) && c.kind !== 'select') needsDatabase = true
        if (c.kind === 'createObject') for (const d of c.databases ?? []) creates.add(d)
        if (c.kind === 'dropObject') for (const d of c.databases ?? []) drops.add(d)
        if (c.kind === 'setSession' && tracker.observe(st.text)) stream.setLex(tracker.lexOptions())
      }
      for await (const chunk of decoded.text) {
        if (overTime()) throw failure('time_limit', 'The file is too large to analyse within the time limit')
        stream.push(chunk)
        for (let st = stream.next(false); st; st = stream.next(false)) handle(st)
      }
      for (let st = stream.next(true); st; st = stream.next(true)) handle(st)
      statements = {
        total,
        byClass,
        hardKinds,
        refusedKinds,
        createsDatabases: [...creates],
        dropsDatabases: [...drops],
        usesDatabase,
        needsDatabase,
      }
    } else {
      const scan = await scanRowFile(decoded, req.format, rowOptions as RowSourceOptions)
      named = scan.named
      rows = {
        columns: scan.columns,
        sample: scan.sample,
        rowCount: scan.rowCount,
        warnings: scan.warnings,
        inferred: scan.inferred,
        ...(scan.jsonTables.length > 0 ? { jsonTables: scan.jsonTables } : {}),
      }
    }
  } finally {
    await decoded.text.return(undefined)
  }

  const confirmRequired = (statements?.byClass.hard ?? 0) > 0
  const base = {
    uploadId: source.id,
    fileName: source.name,
    bytes: source.bytes,
    compression: decoded.compression,
    format: req.format,
    charset: decoded.decoder.encoding || SAMPLE_CHARSET,
  }
  const analysisHash = sha(
    JSON.stringify([
      base,
      content.digest('hex'),
      statements ? [statements.total, statements.byClass, statements.hardKinds, statements.refusedKinds] : null,
      rows ? [rows.columns, rows.rowCount] : null,
    ]),
  )
  const analysis: ImportAnalysis = {
    ...base,
    analysisHash,
    ...(statements ? { statements } : {}),
    ...(rows ? { rows } : {}),
    confirmRequired,
    ...(confirmRequired
      ? {
          confirmToken: env.tokens.issue({
            sessionId: env.owner.sessionId,
            target: tokenTarget(env),
            planId: tokenPlan(source.id),
            statementsHash: analysisHash,
            expiresAt: now() + TOKEN_TTL_MS,
          }),
        }
      : {}),
  }
  rememberAnalysis({
    analysis,
    sourceId: source.id,
    decodedBytes: decoded.counter.bytes,
    format: req.format,
    charsetRequested: req.charset,
    rowOptions,
    named,
    owner: { sessionId: env.owner.sessionId, user: env.owner.user },
    createdAt: now(),
  })
  audit('io.import.analyse', {
    user: env.owner.user,
    target: env.targetLabel,
    uploadId: source.id,
    format: req.format,
    compression: decoded.compression,
    fileName: source.name,
    bytes: source.bytes,
    statements: statements?.total,
    rows: rows?.rowCount ?? undefined,
    classCounts: statements
      ? Object.entries(statements.byClass)
          .map(([k, v]) => `${k}:${v}`)
          .join(',')
      : undefined,
    confirmRequired,
  })
  return analysis
}

/** Token claims: session, user and target in `target`, the file in `planId`, the analysis in `statementsHash`. */
export const tokenTarget = (env: Pick<ImportEnv, 'targetLabel' | 'owner'>): string =>
  `${env.targetLabel}|${env.owner.user}`
export const tokenPlan = (uploadId: string): string => `io-import:${uploadId}`
