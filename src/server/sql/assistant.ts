/** Assistant hook (FR-SQL-027): one read statement, read-only forced, no confirmation possible. */
import { randomBytes } from 'node:crypto'
import { StructureRefusal } from '../structure/errors'
import { executeRun, prepareText, type SqlRunEnv } from './run'
import type { AssistantRunRequest, SqlStatementResult } from './types'

export type AssistantResult =
  | { needsUser: true; reason: string }
  | { needsUser: false; ok: boolean; result: SqlStatementResult }

const INLINE_ROWS = 100

export async function runForAssistant(
  env: SqlRunEnv,
  req: AssistantRunRequest & { maxRows?: number },
): Promise<AssistantResult> {
  let prepared
  try {
    prepared = await prepareText(env, req.text, undefined, { skipGuard: true })
  } catch (error) {
    if (error instanceof StructureRefusal) return { needsUser: true, reason: error.code }
    throw error
  }
  if (prepared.statements.length !== 1) return { needsUser: true, reason: 'single-statement-only' }
  const c = prepared.statements[0]!.classification
  if (c.class !== 'none' || !c.readOnlySafe) {
    return { needsUser: true, reason: c.reasons[0] ?? c.kind }
  }
  const rowCap = Math.min(req.maxRows ?? INLINE_ROWS, env.limits.rowCap)
  const done = await executeRun(env, {
    runId: `asst-${randomBytes(8).toString('hex')}`,
    source: 'assistant',
    prepared,
    fullText: req.text,
    db: req.db,
    options: {
      continueOnError: false,
      singleTransaction: false,
      disableForeignKeyChecks: false,
      confirmSoft: false,
    },
    maxClass: 'none',
    forceReadOnly: true,
    limits: { rowCap },
  })
  const result = done.results[0]
  if (!result) return { needsUser: true, reason: 'no-result' }
  return { needsUser: false, ok: done.ok, result }
}
