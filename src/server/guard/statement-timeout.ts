import type { Pool, PoolConnection } from 'mysql2/promise'
import { WriteGuardError } from './write-guard'

export type TimedResult = {
  /** Whatever `connection.query` resolved with ([rows, fields]). */
  result: Awaited<ReturnType<PoolConnection['query']>>
  /** True: the connection answered normally and may be reused. */
  usable: true
}

/**
 * Runs one statement on a dedicated connection. When it runs longer than `timeoutMs`, `KILL QUERY` is
 * sent from a second pool connection and the call rejects with `WriteGuardError('timeout')`, whose
 * `connectionUsable` says whether the dedicated connection still answers `SELECT 1`. Other errors
 * propagate unchanged (the caller decides about the connection). Never uses multi-statement.
 */
export async function runWithTimeout(
  pool: Pool,
  connection: PoolConnection,
  timeoutMs: number,
  sql: string,
): Promise<TimedResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WriteGuardError('invalid-timeout', 'The statement timeout must be greater than zero.')
  }
  let settled = false
  let timedOut = false
  let killing: Promise<void> = Promise.resolve()
  const timer = setTimeout(() => {
    if (settled) return
    timedOut = true
    killing = (async () => {
      let killer: PoolConnection | undefined
      try {
        killer = await pool.getConnection()
        await killer.query(`KILL QUERY ${Number(connection.threadId)}`)
      } catch {
        // Kill failed: the statement keeps running; connectionUsable will report false.
      } finally {
        killer?.release()
      }
    })()
  }, timeoutMs)

  try {
    const result = await connection.query(sql)
    settled = true
    clearTimeout(timer)
    if (!timedOut) return { result, usable: true }
    // Completed anyway (kill raced, or SLEEP-style functions return instead of failing).
  } catch (error) {
    settled = true
    clearTimeout(timer)
    if (!timedOut) throw error
  }
  await killing
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

/** Sends `KILL QUERY` for a thread from a second pool connection; never throws. */
export async function killThreadQuery(pool: Pool, threadId: number): Promise<void> {
  let killer: PoolConnection | undefined
  try {
    killer = await pool.getConnection()
    await killer.query(`KILL QUERY ${Number(threadId)}`)
  } catch {
    // The statement keeps running; the caller sees that the connection does not answer.
  } finally {
    killer?.release()
  }
}

export type Watchdog = {
  /** True once the time limit was reached (the kill is sent or in flight). */
  readonly timedOut: boolean
  /** Sends `KILL QUERY` now (result cap, cancel). Idempotent; resolves when the kill was processed. */
  kill(): Promise<void>
  /** Disarms the timer and waits for a kill in flight. Call it when the statement ended. */
  stop(): Promise<void>
}

/**
 * Armed per statement for the streaming runner (the stream cannot go through `runWithTimeout`, which
 * buffers). After `timeoutMs` it sends `KILL QUERY`; `timedOut` then tells the caller to report a time
 * limit even if the statement came back normally (SLEEP-style functions return instead of failing).
 * Always `await stop()` before sending the next statement, so a late kill cannot hit it.
 */
export function startWatchdog(pool: Pool, connection: PoolConnection, timeoutMs: number): Watchdog {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WriteGuardError('invalid-timeout', 'The statement timeout must be greater than zero.')
  }
  let killing: Promise<void> | undefined
  let timedOut = false
  const kill = (): Promise<void> => {
    killing ??= killThreadQuery(pool, connection.threadId)
    return killing
  }
  const timer = setTimeout(() => {
    timedOut = true
    void kill()
  }, timeoutMs)
  return {
    get timedOut() {
      return timedOut
    },
    kill,
    async stop() {
      clearTimeout(timer)
      if (killing) await killing
    },
  }
}
