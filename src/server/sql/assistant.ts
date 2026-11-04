/**
 * Assistant hook (FR-SQL-027, FR-AST-011): one statement, run only when the module `assistant` says the call is approved.
 * Reads run under the read-only force. INSERT and UPDATE run only with `approvedWrite` (a per-call user approval made
 * outside this file) and still pass the write guard; every other statement is handed back to the user.
 */
import { randomBytes } from 'node:crypto'
import { assertWritable, WriteGuardError } from '../guard/write-guard'
import { StructureRefusal } from '../structure/errors'
import { executeRun, prepareText, type SqlRunEnv } from './run'
import type { AssistantRunRequest, Classification, SqlStatementResult } from './types'

/** What the assistant needs to know about a statement before it decides how to run it. */
export type AssistantFacts = Pick<Classification, 'kind' | 'class' | 'readOnlySafe' | 'reasons' | 'tables'>

export type AssistantResult =
  | { needsUser: true; reason: string; facts?: AssistantFacts }
  | { needsUser: false; ok: boolean; result: SqlStatementResult; facts: AssistantFacts }

export type AssistantInspect =
  | { ok: true; access: 'read' | 'write'; sql: string; facts: AssistantFacts }
  | { ok: false; reason: string; facts?: AssistantFacts }

const INLINE_ROWS = 100

/** The statements an approved assistant call may write with. REPLACE, DELETE, DDL and the rest stay with the user. */
const WRITE_KINDS = new Set(['insert', 'update'])

const factsOf = (c: Classification): AssistantFacts => ({
  kind: c.kind,
  class: c.class,
  readOnlySafe: c.readOnlySafe,
  reasons: c.reasons,
  ...(c.tables ? { tables: c.tables } : {}),
})

async function prepare(env: SqlRunEnv, text: string) {
  try {
    return { prepared: await prepareText(env, text, undefined, { skipGuard: true }) }
  } catch (error) {
    if (error instanceof StructureRefusal) return { reason: error.code }
    throw error
  }
}

/**
 * Classifies one statement without running it (policy and approval card). `read`: a none-class read. `write`: an INSERT
 * or UPDATE the write guard does not call hard (an UPDATE without a restricting WHERE is hard and stays with the user).
 */
export async function inspectForAssistant(env: SqlRunEnv, text: string): Promise<AssistantInspect> {
  const p = await prepare(env, text)
  if (!p.prepared) return { ok: false, reason: p.reason ?? 'refused' }
  const { statements } = p.prepared
  if (statements.length !== 1) return { ok: false, reason: 'single-statement-only' }
  const stmt = statements[0]!
  const c = stmt.classification
  const facts = factsOf(c)
  if (c.class === 'none' && c.readOnlySafe) return { ok: true, access: 'read', sql: stmt.text, facts }
  if (WRITE_KINDS.has(c.kind) && c.class !== 'hard') return { ok: true, access: 'write', sql: stmt.text, facts }
  return { ok: false, reason: c.reasons[0] ?? c.kind, facts }
}

export async function runForAssistant(
  env: SqlRunEnv,
  req: AssistantRunRequest & { maxRows?: number },
): Promise<AssistantResult> {
  const found = await inspectForAssistant(env, req.text)
  if (!found.ok) return { needsUser: true, reason: found.reason, ...(found.facts ? { facts: found.facts } : {}) }
  if (found.access === 'write') {
    if (req.approvedWrite !== true) return { needsUser: true, reason: 'approval-required', facts: found.facts }
    try {
      assertWritable(env.guard)
    } catch (error) {
      if (error instanceof WriteGuardError) return { needsUser: true, reason: error.code, facts: found.facts }
      throw error
    }
  }
  const prepared = (await prepare(env, req.text)).prepared
  if (!prepared) return { needsUser: true, reason: 'refused', facts: found.facts }
  const write = found.access === 'write'
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
    maxClass: write ? found.facts.class : 'none',
    forceReadOnly: !write,
    limits: { rowCap },
  })
  const result = done.results[0]
  if (!result) return { needsUser: true, reason: 'no-result', facts: found.facts }
  return { needsUser: false, ok: done.ok, result, facts: found.facts }
}
