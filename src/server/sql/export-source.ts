/** Export hook for module io (FR-SQL-026): re-runs one statement under the guard and streams its rows. */
import { randomBytes } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import type { Cell } from '../db/rows'
import { auditSqlRun } from '../audit'
import { startWatchdog } from '../guard/statement-timeout'
import { StructureRefusal, toClientError } from '../structure/errors'
import { runRegistry } from './registry'
import { prepareText, setupConnection, targetLabel, toCell, type SqlRunEnv } from './run'
import type { SqlColumnMeta, SqlLimits } from './types'

export type ExportRequest = {
  db?: string
  text: string
  /** Index among the non-empty statements of `text`. */
  statementIndex: number
  /** The row and byte caps of the grid are ignored; the timeout and the cell cap apply. */
  limits?: Partial<Pick<SqlLimits, 'timeoutMs' | 'cellBytes'>>
}

export type ResultStream = {
  columns: SqlColumnMeta[]
  /** Rows with back pressure; ends the run (connection destroyed) when exhausted, broken or closed. */
  rows: AsyncGenerator<Cell[], void, void>
  close(): Promise<void>
}

type FieldPacket = { name: string; columnType: number; characterSet: number; table?: string }
type Readable = AsyncIterable<unknown[]> & {
  destroy(): void
  on(e: string, h: (...a: never[]) => void): unknown
  once(e: string, h: (...a: never[]) => void): unknown
}
type CoreQuery = { stream(o: { highWaterMark: number }): Readable }
type CoreConnection = { query(o: { sql: string; rowsAsArray: boolean }): CoreQuery }

export async function openResultStream(env: SqlRunEnv, req: ExportRequest): Promise<ResultStream> {
  const runId = `export-${randomBytes(6).toString('hex')}`
  const user = env.session.target.username
  const target = targetLabel(env.session.target)
  const limits = { ...env.limits, ...req.limits }
  let conn: PoolConnection | undefined
  let handle: ReturnType<typeof runRegistry.begin> | undefined
  try {
    const p = await prepareText(env, req.text, undefined, { skipGuard: true })
    const stmt = p.statements[req.statementIndex]
    const c = stmt?.classification
    if (!stmt || !c || c.class !== 'none' || !c.readOnlySafe) {
      throw new StructureRefusal('not_exportable', 'Only a plain read statement can be exported')
    }
    const registry = env.registry ?? runRegistry
    handle = registry.begin(env.session.idHash, runId, limits.maxConcurrentRuns)
    conn = await env.session.pool.getConnection()
    await setupConnection(conn, {
      readOnly: true,
      timeoutMs: limits.timeoutMs,
      product: p.info.product,
      db: req.db,
    })
    const wd = startWatchdog(env.session.pool, conn, limits.timeoutMs)
    const core = (conn as unknown as { connection: CoreConnection }).connection
    const stream = core.query({ sql: stmt.text, rowsAsArray: true }).stream({ highWaterMark: 64 })

    let ended = false
    let failure: unknown
    stream.on('error', ((e: unknown) => {
      failure = e
    }) as never)
    stream.on('end', (() => {
      ended = true
    }) as never)

    const columns = await new Promise<SqlColumnMeta[]>((resolve) => {
      stream.once('fields', ((f: FieldPacket[] | undefined) =>
        resolve(
          (f ?? []).map((x) => ({
            name: x.name,
            type: String(x.columnType),
            ...(x.table ? { table: x.table } : {}),
          })),
        )) as never)
      stream.once('end', (() => resolve([])) as never)
      stream.once('error', (() => resolve([])) as never)
    })

    const started = Date.now()
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      if (!ended) await wd.kill()
      await wd.stop()
      stream.destroy()
      conn?.destroy()
      if (handle) registry.finish(handle)
      auditSqlRun({
        user,
        target,
        runId,
        statements: 1,
        maxClass: 'none',
        outcome: wd.timedOut ? 'timeout' : failure ? 'failed' : 'ok',
        source: 'export',
        durationMs: Date.now() - started,
      })
    }

    async function* rows(): AsyncGenerator<Cell[], void, void> {
      try {
        for await (const row of stream) {
          yield row.map((v) => toCell(v, limits.cellBytes).cell)
        }
        if (wd.timedOut) throw new StructureRefusal('timeout', 'The export hit the time limit')
      } catch (error) {
        if (wd.timedOut) throw new StructureRefusal('timeout', 'The export hit the time limit')
        throw error
      } finally {
        await close()
      }
    }
    return { columns, rows: rows(), close }
  } catch (error) {
    conn?.destroy()
    if (handle) (env.registry ?? runRegistry).finish(handle)
    throw toClientError(error)
  }
}
