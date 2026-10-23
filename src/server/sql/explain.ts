/** Explain and analyse (FR-SQL-021, FR-TGT-231; spec 5.9). */
import { randomBytes } from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { auditSqlRun, auditSqlStatement } from '../audit'
import { hashStatements } from '../guard/confirm-token'
import { killThreadQuery, runWithTimeout } from '../guard/statement-timeout'
import { assertWritable, WriteGuardError } from '../guard/write-guard'
import { mapMysqlError, StructureRefusal, toClientError } from '../structure/errors'
import { planStore as defaultPlanStore } from '../structure/plans'
import type { Statement } from '../structure/types'
import * as fx from './fixed'
import {
  asRows,
  display,
  fullOf,
  prepareText,
  setupConnection,
  sqlHash,
  targetLabel,
  type Prepared,
  type SqlRunEnv,
} from './run'
import type { ExplainSqlInput, SqlExplainResponse, SqlRunResponse } from './types'

const EXPLAINABLE = new Set(['select', 'insert', 'update', 'delete', 'replace'])

type AnalysePayload = {
  v: 1
  type: 'sql-analyse'
  text: string
  db?: string
}

const isReadOnly = (env: SqlRunEnv) => env.guard.forcedReadOnly || env.guard.sessionReadOnly

/** Statements that EXPLAIN would execute or that are explain forms themselves are never sent to the probe. */
const NO_PROBE = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:explain|analyze|describe|desc)\b/i

/**
 * Asks the server why it cannot explain a statement: plain `EXPLAIN <statement>` never executes anything
 * (no ANALYZE), so the answer is the server's own syntax error. Best effort; null on any failure.
 */
async function serverReason(env: SqlRunEnv, p: Prepared): Promise<string | null> {
  const stmt = p.statements[0]!
  if (NO_PROBE.test(stmt.text)) return null
  let conn: PoolConnection | undefined
  try {
    conn = await env.session.pool.getConnection()
    await setupConnection(conn, {
      readOnly: true,
      timeoutMs: env.limits.timeoutMs,
      product: p.info.product,
    })
    await runWithTimeout(env.session.pool, conn, env.limits.timeoutMs, `EXPLAIN ${stmt.text}`)
    return null
  } catch (error) {
    return mapMysqlError(error).message
  } finally {
    conn?.destroy()
  }
}

async function single(env: SqlRunEnv, text: string): Promise<Prepared> {
  // The guard is applied below: plain EXPLAIN of a write is allowed on a read-only connection.
  const p = await prepareText(env, text, undefined, { skipGuard: true })
  if (p.statements.length !== 1) {
    throw new StructureRefusal('select_one_statement', 'Select exactly one statement')
  }
  const kind = p.statements[0]!.classification.kind
  if (!EXPLAINABLE.has(kind)) {
    const why = await serverReason(env, p)
    throw new StructureRefusal(
      'cannot_explain',
      why ? `This statement cannot be explained: ${why}` : 'This statement cannot be explained',
    )
  }
  return p
}

/** Analyse executes: only a safe read runs directly; anything else needs the hard-class token. */
const analyseNeedsToken = (p: Prepared): boolean => {
  const c = p.statements[0]!.classification
  return !(c.class === 'none' && c.readOnlySafe)
}

const asStatement = (p: Prepared): Statement => ({
  sql: p.statements[0]!.text,
  kind: 'userSql',
  class: 'hard',
  effect: 'Analyse executes this statement and changes data',
})

/** Step one of analysing a changing statement: stores the plan and issues the token (hard class). */
export async function planAnalyse(
  env: SqlRunEnv,
  input: Pick<ExplainSqlInput, 'db' | 'text'>,
): Promise<Extract<SqlRunResponse, { kind: 'confirm' }>> {
  try {
    const p = await single(env, input.text)
    if (!analyseNeedsToken(p)) {
      throw new StructureRefusal(
        'no_confirmation_needed',
        'This statement can be analysed directly',
      )
    }
    assertWritable(env.guard)
    const plans = env.plans ?? defaultPlanStore
    const statement = asStatement(p)
    const statementsHash = hashStatements([statement])
    const payload: AnalysePayload = {
      v: 1,
      type: 'sql-analyse',
      text: input.text,
      ...(input.db !== undefined ? { db: input.db } : {}),
    }
    const stored = plans.create(env.session.idHash, {
      statements: [statement],
      warnings: [],
      statementsHash,
      ...(input.db !== undefined ? { db: input.db } : {}),
      payload,
    })
    return {
      kind: 'confirm',
      runId: `analyse-${randomBytes(6).toString('hex')}`,
      planId: stored.planId,
      statements: [
        {
          index: 0,
          sql: display(statement.sql),
          ...fullOf(statement.sql),
          class: 'hard',
          reasons: p.statements[0]!.classification.reasons,
        },
      ],
      totalStatements: 1,
      maxClass: 'hard',
      confirmRequired: true,
      confirmToken: env.tokens.issue({
        sessionId: env.session.idHash,
        target: targetLabel(env.session.target),
        planId: stored.planId,
        statementsHash,
        expiresAt: stored.expiresAt,
      }),
      expiresAt: stored.expiresAt,
    }
  } catch (error) {
    throw toClientError(error)
  }
}

function rawOf(rows: Record<string, unknown>[]): string {
  const first = rows[0]
  if (!first) return ''
  const keys = Object.keys(first)
  if (keys.length === 1) return rows.map((r) => String(r[keys[0]!] ?? '')).join('\n')
  const line = (r: Record<string, unknown>) => keys.map((k) => String(r[k] ?? 'NULL')).join('\t')
  return [keys.join('\t'), ...rows.map(line)].join('\n')
}

export async function explainSql(
  env: SqlRunEnv,
  input: ExplainSqlInput,
): Promise<SqlExplainResponse> {
  const started = Date.now()
  const runId = `explain-${randomBytes(6).toString('hex')}`
  const user = env.session.target.username
  const target = targetLabel(env.session.target)
  const plans = env.plans ?? defaultPlanStore
  let statementHash = ''
  let tokenChecked = false
  try {
    const p = await single(env, input.text)
    const stmt = p.statements[0]!
    statementHash = sqlHash(stmt.text)
    const prefix = fx.explainPrefix(p.info.product, input.mode, input.format)

    if (input.mode === 'analyse' && analyseNeedsToken(p)) {
      assertWritable(env.guard)
      const plan = input.planId ? plans.get(env.session.idHash, input.planId) : undefined
      const payload = plan?.payload as Partial<AnalysePayload> | undefined
      if (!input.planId) {
        throw new StructureRefusal(
          'confirm_required',
          'Analyse executes this statement; confirm first',
        )
      }
      if (
        !plan ||
        payload?.type !== 'sql-analyse' ||
        payload.text !== input.text ||
        payload.db !== input.db ||
        plan.statementsHash !== hashStatements([asStatement(p)])
      ) {
        throw new StructureRefusal('plan_expired', 'The plan has expired or does not exist')
      }
      env.tokens.verifyAndConsume(input.confirmToken, {
        sessionId: env.session.idHash,
        target,
        planId: plan.planId,
        statementsHash: plan.statementsHash,
      })
      plans.consume(plan.planId)
      tokenChecked = true
    }

    const conn: PoolConnection = await env.session.pool.getConnection()
    // Client gone (FR-SQL-013): end the statement on the server at once.
    const onAbort = (): void => {
      void killThreadQuery(env.session.pool, conn.threadId)
    }
    if (env.signal?.aborted) onAbort()
    else env.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await setupConnection(conn, {
        // EXPLAIN is refused by a read-only transaction (1792) and executes nothing; analyse runs the statement.
        readOnly: input.mode === 'analyse' && isReadOnly(env),
        timeoutMs: env.limits.timeoutMs,
        product: p.info.product,
        db: input.db,
      })
      let raw: string
      try {
        const { result } = await runWithTimeout(
          env.session.pool,
          conn,
          env.limits.timeoutMs,
          `${prefix.prefix} ${stmt.text}`,
        )
        raw = rawOf(asRows(result[0]))
      } catch (error) {
        if (error instanceof WriteGuardError) throw error
        throw new StructureRefusal('explain_failed', mapMysqlError(error).message)
      }
      const durationMs = Date.now() - started
      auditSqlRun({
        user,
        target,
        runId,
        statements: 1,
        maxClass: tokenChecked ? 'hard' : 'none',
        outcome: 'ok',
        durationMs,
      })
      if (tokenChecked) {
        auditSqlStatement({
          user,
          target,
          runId,
          index: 0,
          kind: stmt.classification.kind,
          class: 'hard',
          statementHash,
          outcome: 'executed',
          durationMs,
        })
      }
      return { mode: input.mode, format: prefix.format, raw, durationMs }
    } finally {
      env.signal?.removeEventListener('abort', onAbort)
      conn.destroy()
    }
  } catch (error) {
    if (error instanceof WriteGuardError || error instanceof StructureRefusal) {
      auditSqlRun({
        user,
        target,
        runId,
        statements: 1,
        maxClass: 'none',
        outcome:
          error instanceof WriteGuardError && error.code === 'timeout' ? 'timeout' : 'refused',
        code: error.code,
      })
    }
    throw toClientError(error)
  }
}
