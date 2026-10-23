import { killThreadQuery } from '../guard/statement-timeout'
import type { TargetPool } from '../db/target-pool'
import { StructureRefusal } from '../structure/errors'

const SWEEP_AFTER_MS = 15 * 60_000

export type RunHandle = {
  readonly runId: string
  readonly sessionId: string
  /** Thread id reported by the driver for the run's connection (never client input). */
  threadId?: number
  cancelRequested: boolean
  state: 'running' | 'finished'
  startedAt: number
}

/**
 * In-memory registry of running SQL (FR-SQL-013, 029): one entry per run, removed at its end and swept after
 * 15 minutes. Cancel is accepted only for a run of the same session and answers the same for everything else.
 */
export class RunRegistry {
  private runs = new Map<string, RunHandle>()

  constructor(private now: () => number = Date.now) {}

  /** Registers a run. `busy` when the session already has `maxConcurrent` runs; the third is refused. */
  begin(sessionId: string, runId: string, maxConcurrent: number): RunHandle {
    this.sweep()
    const existing = this.runs.get(runId)
    if (existing && existing.state === 'running') {
      throw new StructureRefusal('busy', 'This run is already in progress')
    }
    if (this.countRunning(sessionId) >= maxConcurrent) {
      throw new StructureRefusal('busy', 'Too many statements are running; wait for one to finish')
    }
    const handle: RunHandle = {
      runId,
      sessionId,
      cancelRequested: false,
      state: 'running',
      startedAt: this.now(),
    }
    this.runs.set(runId, handle)
    return handle
  }

  finish(handle: RunHandle): void {
    handle.state = 'finished'
    this.runs.delete(handle.runId)
  }

  countRunning(sessionId: string): number {
    let n = 0
    for (const r of this.runs.values()) if (r.sessionId === sessionId && r.state === 'running') n++
    return n
  }

  get size(): number {
    return this.runs.size
  }

  /**
   * `KILL QUERY` for a run of this session, from a second pool connection. Unknown, finished or foreign
   * runs give the same neutral answer (`false` is never shown to the client).
   */
  async cancel(pool: TargetPool, sessionId: string, runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || run.sessionId !== sessionId || run.state !== 'running') return
    run.cancelRequested = true
    if (run.threadId !== undefined) await killThreadQuery(pool, run.threadId)
  }

  /** Ends every run of a session (session end, closed tab). */
  async cancelSession(pool: TargetPool, sessionId: string): Promise<void> {
    const mine = [...this.runs.values()].filter((r) => r.sessionId === sessionId)
    await Promise.all(mine.map((r) => this.cancel(pool, sessionId, r.runId)))
  }

  sweep(): void {
    const cutoff = this.now() - SWEEP_AFTER_MS
    for (const [id, r] of this.runs) if (r.startedAt < cutoff) this.runs.delete(id)
  }
}

export const runRegistry = new RunRegistry()

/** What `cancelRun` needs from the request context. */
export type CancelEnv = {
  session: { idHash: string; pool: TargetPool }
  registry?: RunRegistry
}

/** Plain function behind `cancelSql`; the answer is always neutral (FR-SQL-013). */
export async function cancelRun(env: CancelEnv, runId: string): Promise<void> {
  await (env.registry ?? runRegistry).cancel(env.session.pool, env.session.idHash, runId)
}
