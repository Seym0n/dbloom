/**
 * Helpers shared by the two import runners (`import-sql.ts`, `import-rows.ts`): the run environment, the
 * accumulator that survives pause and resume, change events for the sidebar (FR-IO-024), notes, and a finish
 * that tolerates a job already ended by cancel.
 */
import type { TargetPool } from '../db/target-pool'
import { structureEvents } from '../structure/execute'
import type { Product } from '../structure/types'
import { auditIo } from '../audit'
import { ProblemList } from './csv'
import { isTerminal, type JobRegistry } from './jobs'
import { type TempStore } from './temp'
import {
  JOB_RETENTION_MS,
  MAX_ALTER_EVENTS,
  type IoError,
  type JobResult,
  type JobState,
  type ParseProblem,
} from './types'

export type ImportRunEnv = {
  pool: TargetPool
  jobs: JobRegistry
  temp: TempStore
  jobId: string
  /** Audit labels (FR-IO-021). */
  user: string
  targetLabel: string
  /** Wall-clock limit of one run segment (ST-111). */
  jobMs: number
  decompressedBytes: number
  product: Product
  /** Display name of the file, kept in the result (SCN-056: the result names the file). */
  fileName?: string
  now?: () => number
}

export const MAX_NOTES = 10

/** What an import has done so far; kept across pause and resume. */
export class ImportAccum {
  run = 0
  skipped = 0
  failed = 0
  rows = 0
  rejected = new ProblemList()
  notes: string[] = []
  createdTable?: { db: string; table: string }
  skippedObjects: { object: string; message: string }[] = []
  /** Counts per statement class for the audit line. */
  classCounts: Record<string, number> = {}
  changes = new ChangeSet()
  /** Time spent in earlier segments. */
  elapsedMs = 0

  note(text: string): void {
    if (this.notes.length < MAX_NOTES && !this.notes.includes(text)) this.notes.push(text)
  }
  reject(p: ParseProblem): void {
    this.rejected.add(p)
  }
}

/** Changed objects, at most MAX_ALTER_EVENTS, then one event per database (FR-IO-024). */
export class ChangeSet {
  private list: { db?: string; table?: string }[] = []
  private dbs = new Set<string>()
  private overflow = false
  add(db: string | undefined, table?: string): void {
    if (db !== undefined) this.dbs.add(db)
    if (this.overflow) return
    if (this.list.length >= MAX_ALTER_EVENTS) {
      this.overflow = true
      return
    }
    this.list.push({ ...(db !== undefined ? { db } : {}), ...(table !== undefined ? { table } : {}) })
  }
  get size(): number {
    return this.list.length
  }
  emit(): void {
    if (this.overflow) {
      for (const db of this.dbs) structureEvents.emit('changed', { db })
    } else {
      for (const c of this.list) structureEvents.emit('changed', c)
    }
    this.list = []
    this.dbs.clear()
    this.overflow = false
  }
}

// ---- Details beyond the 4 KB record (reject lists) -------------------------------------------------------------

const details = new Map<string, ParseProblem[]>()
const MAX_DETAIL_JOBS = 200

/** The (up to 100) rejected rows or failed statements of a job; the job record keeps only about 10. */
export function setImportDetails(jobId: string, items: ParseProblem[]): void {
  details.delete(jobId)
  details.set(jobId, items)
  while (details.size > MAX_DETAIL_JOBS) {
    const oldest = details.keys().next()
    if (oldest.done) break
    details.delete(oldest.value)
  }
}
export const getImportDetails = (jobId: string): ParseProblem[] => details.get(jobId) ?? []
export const dropImportDetails = (jobId: string): void => void details.delete(jobId)

// ---- Finishing ------------------------------------------------------------------------------------------------------

export function resultOf(acc: ImportAccum, extra: Partial<JobResult> = {}): JobResult {
  return {
    skipped: acc.skippedObjects,
    rejected: acc.rejected.items,
    rejectedCount: acc.rejected.count,
    notes: acc.notes,
    ...(acc.createdTable ? { createdTable: acc.createdTable } : {}),
    durationMs: acc.elapsedMs,
    ...extra,
  }
}

/** Ends the job unless cancel already did; never throws. */
export function finishJob(
  env: ImportRunEnv,
  state: Extract<JobState, 'done' | 'done_with_skips' | 'done_with_rejects' | 'failed' | 'cancelled'>,
  result: JobResult,
  audit: {
    statements?: number
    rows?: number
    bytes?: number
    classCounts?: string
    statementHash?: string
    statementNumber?: number
  } = {},
): void {
  setImportDetails(env.jobId, result.rejected)
  if (!isTerminal(env.jobs.stateOf(env.jobId) ?? 'failed')) {
    try {
      env.jobs.finish(env.jobId, state, env.fileName ? { ...result, fileName: env.fileName } : result)
    } catch {
      // the job was ended meanwhile
    }
  }
  auditIo('io.import.end', {
    user: env.user,
    target: env.targetLabel,
    jobId: env.jobId,
    kind: 'import',
    state,
    ...audit,
    ...(result.error ? { errorCode: result.error.code, errno: result.error.errno } : {}),
    durationMs: result.durationMs,
  })
}

export const failResult = (acc: ImportAccum, env: ImportRunEnv, error: IoError): JobResult =>
  resultOf(acc, {
    error,
    ...(acc.rows > 0 ? { rows: acc.rows } : {}),
    statements: { run: acc.run, skipped: acc.skipped, failed: acc.failed },
  })

/** Keeps the staged file for the retention time of the job (FR-IO-001). */
export function retainSource(env: ImportRunEnv, sourceId: string, kind: 'upload' | 'folder'): void {
  if (kind === 'upload') env.temp.retain(sourceId, (env.now ?? Date.now)() + JOB_RETENTION_MS)
}

export const classCountsText = (c: Record<string, number>): string =>
  Object.entries(c)
    .map(([k, v]) => `${k}:${v}`)
    .join(',')

/** Session settings that every segment applies first (FR-IO-017, DATA-ISS-005). */
export const SET_NAMES = 'SET NAMES utf8mb4'
