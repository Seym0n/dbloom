import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  JOB_RECORD_MAX_BYTES,
  JOB_RETENTION_MS,
  MAX_EXPORTS_PER_USER,
  type IoError,
  type IoJob,
  type JobKind,
  type JobProgress,
  type JobResult,
  type JobState,
} from './types'

/**
 * Job registry of module `io` (FR-IO-001, section 5.1). Jobs live in the Node process only (Q5). The public
 * record (`IoJob`) is what polling returns; it never grows past `JOB_RECORD_MAX_BYTES` (NFR-ISS-104), whatever
 * the size of the file. Staged files and spool files are held elsewhere (`temp.ts`).
 */

export type JobOwner = { sessionId: string; user: string }

export type JobErrorCode = 'busy' | 'not_found' | 'invalid_transition'

export class JobError extends Error {
  constructor(
    public code: JobErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'JobError'
  }
}

/**
 * What the download route reads (package C provides the implementation, e.g. over a spool file in the temp
 * directory). `open` returns the bytes of the finished output; for a live tee it may be called while the job
 * runs and must then error when the writer fails. The route never trusts it to be complete: it checks the
 * job state itself and aborts the response if the job did not end in a `done*` state.
 */
export interface SpoolSource {
  /** Final file name with extension (already sanitised by the file-name module). */
  fileName: string
  /** Explicit `Content-Type`, e.g. `text/csv; charset=utf-8`. */
  contentType: string
  /** Exact size when the output is complete and its size is known. */
  size(): number | undefined
  open(): Readable | Promise<Readable>
}

export const TERMINAL_STATES: readonly JobState[] = [
  'done',
  'done_with_skips',
  'done_with_rejects',
  'failed',
  'cancelled',
  'interrupted',
]
export const DONE_STATES: readonly JobState[] = ['done', 'done_with_skips', 'done_with_rejects']
export const isTerminal = (s: JobState) => TERMINAL_STATES.includes(s)
export const isDone = (s: JobState) => DONE_STATES.includes(s)

/** Allowed moves of the state machine. */
export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'cancelled', 'failed', 'interrupted'],
  running: ['paused', 'done', 'done_with_skips', 'done_with_rejects', 'failed', 'cancelled', 'interrupted'],
  paused: ['running', 'cancelled', 'failed', 'interrupted'],
  done: [],
  done_with_skips: [],
  done_with_rejects: [],
  failed: [],
  cancelled: [],
  interrupted: [],
}

// ---- Bounded record ------------------------------------------------------------------------------------

const str = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

function trimError(e: IoError, max: number): IoError {
  return {
    ...e,
    message: str(e.message, max),
    serverMessage: e.serverMessage === undefined ? undefined : str(e.serverMessage, max),
    statementText: e.statementText === undefined ? undefined : str(e.statementText, max),
  }
}

/** Copy of a result that fits the share of the record given to it; counts stay, details are cut. */
function fitResult(r: JobResult, budget: number): JobResult {
  const tiers = [
    { text: 300, list: 10 },
    { text: 160, list: 5 },
    { text: 80, list: 2 },
    { text: 40, list: 0 },
  ]
  for (const t of tiers) {
    const out: JobResult = {
      ...r,
      fileName: r.fileName === undefined ? undefined : str(r.fileName, 160),
      skipped: r.skipped
        .slice(0, t.list)
        .map((s) => ({ object: str(s.object, t.text), message: str(s.message, t.text) })),
      rejected: r.rejected
        .slice(0, t.list)
        .map((p) => ({
          ...p,
          column: p.column === undefined ? undefined : str(p.column, 64),
          message: str(p.message, t.text),
        })),
      notes: r.notes.slice(0, t.list).map((n) => str(n, t.text)),
      error: r.error === undefined ? undefined : trimError(r.error, t.text),
    }
    if (size(out) <= budget) return out
  }
  return {
    ...r,
    fileName: undefined,
    skipped: [],
    rejected: [],
    notes: [],
    error: r.error && { code: r.error.code, message: str(r.error.message, 40) },
  }
}

/** A record that fits `JOB_RECORD_MAX_BYTES` (progress names are cut too). */
export function boundRecord(job: IoJob): IoJob {
  const progress: JobProgress = {
    ...job.progress,
    object: job.progress.object && {
      ...job.progress.object,
      name: str(job.progress.object.name, 120),
    },
  }
  const base: IoJob = { ...job, progress, result: undefined }
  const room = JOB_RECORD_MAX_BYTES - size(base) - 16
  if (!job.result) return { ...base, result: undefined }
  const out: IoJob = { ...base, result: fitResult(job.result, Math.max(64, room)) }
  if (size(out) <= JOB_RECORD_MAX_BYTES) return out
  // last resort: counts and state only
  return {
    ...base,
    result: {
      skipped: [],
      rejected: [],
      rejectedCount: job.result.rejectedCount,
      notes: [],
      durationMs: job.result.durationMs,
      error: job.result.error && { code: job.result.error.code, message: '' },
    },
  }
}

// ---- Registry ------------------------------------------------------------------------------------------------

type Entry = {
  job: IoJob
  owner: JobOwner
  controller: AbortController
  cancelHook?: () => void | Promise<void>
  output?: SpoolSource
  waiters: (() => void)[]
}

export type JobRegistryOptions = {
  now?: () => number
  newId?: () => string
  maxExports?: number
  retentionMs?: number
  /** Called with the id of every job the sweep or `dropSession` removes, to release its files. */
  onRemove?: (id: string, owner: JobOwner) => void
}

const clone = (job: IoJob): IoJob => structuredClone(job)

export class JobRegistry {
  private jobs = new Map<string, Entry>()
  private now: () => number
  private newId: () => string
  private maxExports: number
  private retentionMs: number
  private timer?: NodeJS.Timeout

  constructor(private opts: JobRegistryOptions = {}) {
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? (() => randomBytes(16).toString('base64url'))
    this.maxExports = opts.maxExports ?? MAX_EXPORTS_PER_USER
    this.retentionMs = opts.retentionMs ?? JOB_RETENTION_MS
  }

  private entry(id: string): Entry {
    const e = this.jobs.get(id)
    if (!e) throw new JobError('not_found', 'Unknown job')
    return e
  }

  private active(user: string, kind: JobKind): number {
    let n = 0
    for (const e of this.jobs.values()) {
      if (
        e.owner.user === user &&
        e.job.kind === kind &&
        (e.job.state === 'queued' || e.job.state === 'running')
      )
        n++
    }
    return n
  }

  /**
   * Registers a job in state `queued`. Refused with `busy` when the user already has `maxImports` (imports;
   * default 1, ST-155) or `MAX_EXPORTS_PER_USER` (exports) queued or running. Paused imports do not count.
   */
  create(owner: JobOwner, kind: JobKind, opts: { maxImports?: number } = {}): IoJob {
    const limit = kind === 'import' ? (opts.maxImports ?? 1) : this.maxExports
    if (this.active(owner.user, kind) >= limit)
      throw new JobError('busy', `Too many ${kind} jobs are running`)
    const id = this.newId()
    const job: IoJob = {
      id,
      kind,
      state: 'queued',
      progress: { bytes: 0 },
      startedAt: this.now(),
    }
    this.jobs.set(id, { job, owner: { ...owner }, controller: new AbortController(), waiters: [] })
    return clone(job)
  }

  /** The job of this owner (session and user); a foreign or unknown id gives `undefined`. */
  get(id: string, owner: JobOwner): IoJob | undefined {
    const e = this.jobs.get(id)
    return e && sameOwner(e.owner, owner) ? clone(boundRecord(e.job)) : undefined
  }

  /** State only, without copying the record (used per chunk by the download route). */
  stateOf(id: string): JobState | undefined {
    return this.jobs.get(id)?.job.state
  }

  list(owner: JobOwner): IoJob[] {
    return [...this.jobs.values()]
      .filter((e) => sameOwner(e.owner, owner))
      .map((e) => clone(boundRecord(e.job)))
  }

  /** The abort signal of a job: set by `cancel`; the runner passes it to its stream and connection work. */
  signal(id: string): AbortSignal {
    return this.entry(id).controller.signal
  }

  private move(e: Entry, to: JobState): void {
    if (!TRANSITIONS[e.job.state].includes(to)) {
      throw new JobError('invalid_transition', `A job cannot go from ${e.job.state} to ${to}`)
    }
    e.job.state = to
    if (isTerminal(to)) {
      e.job.endedAt = this.now()
      const waiters = e.waiters.splice(0)
      for (const w of waiters) w()
    }
  }

  start(id: string): IoJob {
    const e = this.entry(id)
    this.move(e, 'running')
    return clone(e.job)
  }

  /** Merges a progress update; ignored once the job has ended. Cheap enough to call per chunk. */
  progress(id: string, patch: Partial<JobProgress>): void {
    const e = this.jobs.get(id)
    if (!e || isTerminal(e.job.state)) return
    e.job.progress = { ...e.job.progress, ...patch }
  }

  /** `running` to `paused` with the resume point in the result (time limit or transient error). */
  pause(id: string, result: JobResult): IoJob {
    const e = this.entry(id)
    this.move(e, 'paused')
    e.job = boundRecord({ ...e.job, result })
    return clone(boundRecord(e.job))
  }

  /** Paused to running again; counts against the import limit like a new start. */
  resume(id: string, owner: JobOwner, maxImports = 1): IoJob {
    const e = this.entry(id)
    if (!sameOwner(e.owner, owner)) throw new JobError('not_found', 'Unknown job')
    if (e.job.state !== 'paused') {
      throw new JobError('invalid_transition', `A job cannot go from ${e.job.state} to running`)
    }
    if (
      this.active(owner.user, e.job.kind) >=
      (e.job.kind === 'import' ? maxImports : this.maxExports)
    ) {
      throw new JobError('busy', `Too many ${e.job.kind} jobs are running`)
    }
    this.move(e, 'running')
    e.job.result = undefined
    return clone(e.job)
  }

  /** Ends the job. `done*` states, `failed` and `cancelled` are final. */
  finish(
    id: string,
    state: Extract<
      JobState,
      'done' | 'done_with_skips' | 'done_with_rejects' | 'failed' | 'cancelled' | 'interrupted'
    >,
    result: JobResult,
  ): IoJob {
    const e = this.entry(id)
    this.move(e, state)
    e.job = boundRecord({ ...e.job, result })
    e.cancelHook = undefined
    return clone(boundRecord(e.job))
  }

  fail(id: string, error: IoError, durationMs = 0): IoJob {
    return this.finish(id, 'failed', {
      skipped: [],
      rejected: [],
      rejectedCount: 0,
      notes: [],
      error,
      durationMs,
    })
  }

  /** Registers what stops the work (kill query, destroy connection, destroy streams). Called by `cancel`. */
  setCancelHook(id: string, hook: () => void | Promise<void>): void {
    this.entry(id).cancelHook = hook
  }

  /**
   * Cancels a queued, running or paused job of this owner: aborts the signal, runs the hook (its errors do
   * not stop the cancel), then ends the job as `cancelled`. An ended job is returned unchanged.
   */
  async cancel(id: string, owner: JobOwner): Promise<IoJob> {
    const e = this.jobs.get(id)
    if (!e || !sameOwner(e.owner, owner)) throw new JobError('not_found', 'Unknown job')
    if (isTerminal(e.job.state)) return clone(boundRecord(e.job))
    e.controller.abort()
    const hook = e.cancelHook
    e.cancelHook = undefined
    try {
      await hook?.()
    } catch {
      // the connection is destroyed anyway; the job still ends
    }
    if (!isTerminal(e.job.state)) {
      this.move(e, 'cancelled')
      e.job.result = {
        skipped: e.job.result?.skipped ?? [],
        rejected: [],
        rejectedCount: e.job.result?.rejectedCount ?? 0,
        notes: [],
        error: { code: 'cancelled', message: 'The job was cancelled' },
        durationMs: this.now() - e.job.startedAt,
      }
    }
    return clone(boundRecord(e.job))
  }

  /**
   * Shutdown (FR-SVR-014): every queued, running or paused job is stopped (signal aborted, hook run) and ends as
   * `interrupted`, never silently dropped. Returns the ids with their kind. Jobs live in this process only (Q5), so the
   * state is what a client polling during the grace period sees and what the shutdown log records.
   */
  async interruptAll(): Promise<{ id: string; kind: JobKind; from: JobState }[]> {
    const out: { id: string; kind: JobKind; from: JobState }[] = []
    for (const [id, e] of [...this.jobs]) {
      if (isTerminal(e.job.state)) continue
      const from = e.job.state
      e.controller.abort()
      const hook = e.cancelHook
      e.cancelHook = undefined
      try {
        await hook?.()
      } catch {
        // the connection is destroyed anyway; the job still ends
      }
      if (isTerminal(e.job.state)) continue // the runner ended it meanwhile
      this.move(e, 'interrupted')
      e.job.result = {
        skipped: e.job.result?.skipped ?? [],
        rejected: [],
        rejectedCount: e.job.result?.rejectedCount ?? 0,
        notes: [],
        error: { code: 'interrupted', message: 'The server was stopped while the job was running' },
        durationMs: this.now() - e.job.startedAt,
      }
      out.push({ id, kind: e.job.kind, from })
    }
    return out
  }

  setOutput(id: string, output: SpoolSource): void {
    this.entry(id).output = output
  }

  getOutput(id: string, owner: JobOwner): SpoolSource | undefined {
    const e = this.jobs.get(id)
    return e && sameOwner(e.owner, owner) ? e.output : undefined
  }

  /** Resolves when the job has ended (immediately if it has) or after `timeoutMs`. */
  whenEnded(id: string, timeoutMs: number): Promise<void> {
    const e = this.jobs.get(id)
    if (!e || isTerminal(e.job.state)) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs)
      t.unref()
      e.waiters.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  /** Removes the jobs that ended more than the retention ago (24 h). Returns the removed ids. */
  sweep(at: number = this.now()): string[] {
    const removed: string[] = []
    for (const [id, e] of this.jobs) {
      if (
        isTerminal(e.job.state) &&
        e.job.endedAt !== undefined &&
        at - e.job.endedAt >= this.retentionMs
      ) {
        this.jobs.delete(id)
        removed.push(id)
        this.opts.onRemove?.(id, e.owner)
      }
    }
    return removed
  }

  /** The session ended: its running jobs are cancelled and all its records removed. */
  async dropSession(sessionId: string): Promise<void> {
    for (const [id, e] of [...this.jobs]) {
      if (e.owner.sessionId !== sessionId) continue
      await this.cancel(id, e.owner).catch(() => undefined)
      this.jobs.delete(id)
      this.opts.onRemove?.(id, e.owner)
    }
  }

  startSweeper(intervalMs = 3_600_000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweep(), intervalMs)
    this.timer.unref()
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

export const sameOwner = (a: JobOwner, b: JobOwner) =>
  a.sessionId === b.sessionId && a.user === b.user
