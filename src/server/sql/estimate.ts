/** Affected-rows estimate for UPDATE and DELETE from plain EXPLAIN (FR-SQL-022): nothing is executed. */
import { runWithTimeout } from '../guard/statement-timeout'
import { StructureRefusal, toClientError } from '../structure/errors'
import * as fx from './fixed'
import { asRows, prepareText, setupConnection, type SqlRunEnv } from './run'
import type { EstimateAffectedInput, SqlEstimateResponse } from './types'

const none = (note: string): SqlEstimateResponse => ({ estimatedRows: null, note })

export async function estimateAffected(
  env: SqlRunEnv,
  input: EstimateAffectedInput,
): Promise<SqlEstimateResponse> {
  try {
    let p
    try {
      p = await prepareText(env, input.text, undefined, { skipGuard: true })
    } catch (error) {
      if (error instanceof StructureRefusal) return none('The statement could not be analysed.')
      throw error
    }
    if (p.statements.length !== 1) return none('Only a single statement can be estimated.')
    const stmt = p.statements[0]!
    const kind = stmt.classification.kind
    if (kind !== 'update' && kind !== 'delete')
      return none('Only UPDATE and DELETE can be estimated.')
    const conn = await env.session.pool.getConnection()
    try {
      await setupConnection(conn, {
        readOnly: false, // EXPLAIN executes nothing and is refused inside a read-only transaction (1792)
        timeoutMs: env.limits.timeoutMs,
        product: p.info.product,
        db: input.db,
      })
      const { result } = await runWithTimeout(
        env.session.pool,
        conn,
        env.limits.timeoutMs,
        `${fx.ESTIMATE_PREFIX} ${stmt.text}`,
      )
      const rows = asRows(result[0])
      if (rows.length !== 1) return none('The plan has several steps; no single estimate.')
      const n = Number(rows[0]!.rows)
      if (rows[0]!.rows == null || !Number.isFinite(n)) return none('The server gave no estimate.')
      return {
        estimatedRows: Math.max(0, Math.round(n)),
        note: 'Estimate from EXPLAIN, not a count.',
      }
    } catch {
      return none('The server could not explain this statement.')
    } finally {
      conn.destroy()
    }
  } catch (error) {
    throw toClientError(error)
  }
}
