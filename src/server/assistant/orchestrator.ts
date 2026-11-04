/**
 * The turn loop of the assistant (SPEC/34 FR-AST-002 to 005, 007 to 014, 018). One conversation is one `EngineState` in
 * memory (messages as the model sees them, the token map, pending approvals). A turn asks the model, runs its tool calls
 * through the policy, and stops when the model answers in text, when a call waits for the user, when a limit is hit or when
 * the user stops it. Nothing in here touches HTTP, the store or the database: those come in through `EngineDeps`.
 *
 * What the model gets back from the database is tokenized, capped and wrapped; the real rows only leave in events for the
 * user's screen and are never kept in the state.
 */
import { randomBytes } from 'node:crypto'
import type { Cell } from '../db/rows'
import type { AssistantInspect, AssistantResult } from '../sql/assistant'
import { parseStatement, type SqlProduct, type TableRef } from '../sql/parser'
import type { SqlColumnMeta } from '../sql/types'
import type { ApprovalFailure, ApprovalStore, PendingCall, RateLimiter } from './approval'
import type { ChatMessage, ChatRequest, ChatResponse, ToolCall } from './client'
import { AiError } from './client'
import { effectiveMode } from './config'
import { createNameHider, type NameHider } from './pii/names'
import type { CompiledRules } from './pii/rules'
import { shapeForModel } from './pii/shape'
import { analyzeStatement, type Analysis, type SchemaLookup } from './pii/taint'
import { createTokenMap, type DetokenizeResult, type TokenMap } from './pii/tokens'
import { decide, REFUSAL_TEXT, type RefusalCode } from './policy'
import { buildSystemPrompt, parseToolCall, TOOL_DEFS, toolEnvelope } from './tools'

export type TableDescription = {
  table: string
  view?: boolean
  found: boolean
  columns: { name: string; type: string; key?: string }[]
}

export type AuditName = 'assistant.call' | 'assistant.approve' | 'assistant.deny' | 'assistant.refuse' | 'assistant.mode'

export type EngineDeps = {
  chat: (req: ChatRequest, signal?: AbortSignal) => Promise<ChatResponse>
  model: string
  product: SqlProduct
  maxSteps: number
  maxRows: number
  maxTokensPerTurn?: number
  autoAllowed: () => boolean
  hideNames: () => boolean
  rules: () => CompiledRules
  /** No markings and no acknowledgement for this target (SPEC/34 Q7). */
  unconfigured: () => boolean
  loadSchema: (db: string | undefined, tables: TableRef[]) => Promise<SchemaLookup>
  describeTables: (db: string, tables: string[]) => Promise<TableDescription[]>
  inspect: (sqlReal: string, db: string | undefined) => Promise<AssistantInspect>
  run: (sqlReal: string, db: string | undefined, approvedWrite: boolean) => Promise<AssistantResult>
  /** Throws when the row cannot be written: the call then does not go on. */
  audit: (event: AuditName, fields: Record<string, unknown>) => void
  approvals: ApprovalStore
  rateLimit?: RateLimiter
  now?: () => number
}

export type EngineState = {
  id: string
  userId: string
  sessionId: string
  targetKey: string
  mode: 'manual' | 'auto'
  outline: string
  messages: ChatMessage[]
  tokens: TokenMap
  hider: NameHider
  queue: ToolCall[]
  awaiting: { call: ToolCall; callId: string } | null
  busy: boolean
  stopped: boolean
  steps: number
  tokensUsed: number
}

export function createEngineState(init: {
  id: string
  userId: string
  sessionId: string
  targetKey: string
  mode?: 'manual' | 'auto'
  outline: string
  tokens?: TokenMap
  hider?: NameHider
}): EngineState {
  return {
    id: init.id,
    userId: init.userId,
    sessionId: init.sessionId,
    targetKey: init.targetKey,
    mode: init.mode ?? 'manual',
    outline: init.outline,
    messages: [],
    tokens: init.tokens ?? createTokenMap(),
    hider: init.hider ?? createNameHider(),
    queue: [],
    awaiting: null,
    busy: false,
    stopped: false,
    steps: 0,
    tokensUsed: 0,
  }
}

/** The result of a statement as the user's screen shows it: real values. Never stored. */
export type UserResult = {
  columns: SqlColumnMeta[]
  rows: Cell[][]
  rowCount: number
  truncated: boolean
  affectedRows?: number
  durationMs: number
}

export type TurnEvent =
  | { type: 'assistant'; text: string }
  | { type: 'step'; tool: 'describe_tables'; db: string; tables: string[] }
  | { type: 'approval'; callId: string; sql: string; sqlModel: string; db?: string; access: 'read' | 'write'; purpose?: string; metadataOnly: boolean; expiresAt: number }
  | { type: 'result'; callId: string; sql: string; sqlModel: string; db?: string; ok: true; result: UserResult; modelSaw: 'rows' | 'metadata' | 'affected'; anonymizedColumns: string[] }
  | { type: 'result'; callId: string; sql: string; sqlModel: string; db?: string; ok: false; message: string }
  | { type: 'refused'; callId: string; code: RefusalCode; message: string; sql?: string; db?: string }
  | { type: 'denied'; callId: string; reason: 'user' | 'expired' | 'stopped' | 'superseded' }
  | { type: 'error'; code: 'ai' | 'rate_limited' | 'step_limit' | 'token_limit' | 'busy' | 'no_pending' | 'approval_invalid'; message: string; detail?: string }

export type TurnStatus = 'done' | 'awaiting_approval' | 'error' | 'stopped'
export type TurnOutcome = { status: TurnStatus; events: TurnEvent[] }

const DEFAULT_TOKEN_BUDGET = 100_000

class Out {
  events: TurnEvent[] = []
  push(e: TurnEvent) {
    this.events.push(e)
  }
}

const toolMsg = (state: EngineState, id: string, payload: Record<string, unknown>) => {
  state.messages.push({ role: 'tool', tool_call_id: id, content: toolEnvelope(payload) })
}

const bestEffort = (deps: EngineDeps, event: AuditName, fields: Record<string, unknown>) => {
  try {
    deps.audit(event, fields)
  } catch {
    // a refusal is recorded when possible; it must not turn into a second failure
  }
}

type Prepared = {
  callId: string
  sqlModel: string
  sqlReal: string
  db?: string
  purpose?: string
  access: 'read' | 'write'
  analysis: Analysis
  metadataOnly: boolean
}

const detokenFailure = (r: Extract<DetokenizeResult, { ok: false }>): string => REFUSAL_TEXT.token + (r.reason === 'token-value-unsafe' ? ' (that value cannot be written into a statement)' : '')

/** The audit fields of a call: tokenized SQL, never a real value or a row. */
const auditOf = (state: EngineState, p: Prepared, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  conversationId: state.id,
  userId: state.userId,
  callId: p.callId,
  sql: p.sqlModel,
  db: p.db ?? null,
  access: p.access,
  mode: effectiveMode(state.mode, true),
  ...extra,
})

function refuse(state: EngineState, deps: EngineDeps, out: Out, call: ToolCall, code: RefusalCode, detail?: string, p?: { sqlReal?: string; db?: string; sqlModel?: string }): void {
  const text = code === 'token' && detail ? detail : REFUSAL_TEXT[code]
  toolMsg(state, call.id, { status: 'refused', reason: text })
  out.push({ type: 'refused', callId: call.id, code, message: text, ...(code === 'user-only' && p?.sqlReal ? { sql: p.sqlReal } : {}), ...(p?.db ? { db: p.db } : {}) })
  bestEffort(deps, 'assistant.refuse', { conversationId: state.id, userId: state.userId, callId: call.id, reason: code, ...(p?.sqlModel ? { sql: p.sqlModel } : {}) })
}

async function prepareQuery(state: EngineState, deps: EngineDeps, call: ToolCall, args: { db?: string; sql: string; purpose?: string }, out: Out): Promise<Prepared | undefined> {
  const sqlModel = deps.hideNames() ? state.hider.restoreSql(args.sql) : args.sql
  const parsed = parseStatement(sqlModel, deps.product)
  const refs = parsed.ok ? parsed.facts.tables : []
  const schema = await deps.loadSchema(args.db, refs)
  const analysis = analyzeStatement(sqlModel, {
    product: deps.product,
    ...(args.db ? { defaultDb: args.db } : {}),
    rules: deps.rules(),
    schema,
    unconfigured: deps.unconfigured(),
    isIssuedToken: (s) => state.tokens.isIssued(s),
  })
  const detok = state.tokens.detokenizeSql(sqlModel)
  if (!detok.ok) {
    refuse(state, deps, out, call, 'token', detokenFailure(detok), { sqlModel })
    return undefined
  }
  const inspect = await deps.inspect(detok.sql, args.db)
  const decision = decide({ inspect, analysis, mode: state.mode, autoAllowed: deps.autoAllowed() })
  if (decision.action === 'refuse') {
    refuse(state, deps, out, call, decision.code, undefined, { sqlReal: detok.sql, ...(args.db ? { db: args.db } : {}), sqlModel })
    return undefined
  }
  const p: Prepared = {
    callId: call.id,
    sqlModel,
    sqlReal: detok.sql,
    ...(args.db ? { db: args.db } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {}),
    access: inspect.ok ? inspect.access : 'read',
    analysis,
    metadataOnly: decision.action === 'ask' && decision.metadataOnly === true,
  }
  if (decision.action === 'ask') {
    const rec: PendingCall = deps.approvals.issue({
      callId: call.id,
      conversationId: state.id,
      userId: state.userId,
      sessionId: state.sessionId,
      sqlReal: p.sqlReal,
      sqlModel: p.sqlModel,
      ...(p.db ? { db: p.db } : {}),
      access: p.access,
    })
    state.awaiting = { call, callId: call.id }
    out.push({ type: 'approval', callId: call.id, sql: p.sqlReal, sqlModel: p.sqlModel, ...(p.db ? { db: p.db } : {}), access: p.access, ...(p.purpose ? { purpose: p.purpose } : {}), metadataOnly: p.metadataOnly, expiresAt: rec.expiresAt })
    return p
  }
  // run now (auto mode, read)
  await execute(state, deps, call, p, out)
  return undefined
}

async function execute(state: EngineState, deps: EngineDeps, call: ToolCall, p: Prepared, out: Out): Promise<void> {
  const now = deps.now ?? Date.now
  try {
    if (p.access === 'write') deps.audit('assistant.approve', auditOf(state, p, { by: state.userId }))
  } catch {
    refuse(state, deps, out, call, 'audit', undefined, { sqlModel: p.sqlModel })
    return
  }
  const started = now()
  let res: AssistantResult
  try {
    res = await deps.run(p.sqlReal, p.db, p.access === 'write')
  } catch {
    toolMsg(state, call.id, { status: 'error', code: 'internal' })
    out.push({ type: 'result', callId: call.id, sql: p.sqlReal, sqlModel: p.sqlModel, ...(p.db ? { db: p.db } : {}), ok: false, message: 'The statement could not be run.' })
    return
  }
  const durationMs = now() - started
  if (res.needsUser) {
    refuse(state, deps, out, call, 'user-only', res.reason, { sqlReal: p.sqlReal, ...(p.db ? { db: p.db } : {}), sqlModel: p.sqlModel })
    return
  }
  const r = res.result
  let rows = 0
  let outcome: 'ok' | 'failed' = 'ok'
  let modelPayload: Record<string, unknown>
  let userEvent: TurnEvent
  if (r.status === 'rows') {
    rows = r.rowCount
    const taints = p.analysis.kind === 'query' && !p.metadataOnly ? p.analysis.outputs : undefined
    const shaped = shapeForModel(taints, r.columns, r.rows, state.tokens, { maxRows: deps.maxRows, truncated: r.truncated !== undefined })
    const hide = (n: string) => (deps.hideNames() ? state.hider.hideResultName(n) : n)
    modelPayload =
      shaped.mode === 'rows'
        ? { status: 'ok', columns: shaped.columns.map((c) => ({ name: hide(c.name), type: c.type, anonymized: c.anonymized })), rows: shaped.rows, row_count: shaped.rowCount, truncated: shaped.truncated }
        : { status: 'ok', columns: shaped.columns.map((c) => ({ name: hide(c.name), type: c.type })), row_count: shaped.rowCount, rows_withheld: true, note: 'Only column names and the row count are shown: the origin of some columns could not be checked against the privacy rules.' }
    userEvent = {
      type: 'result',
      callId: call.id,
      sql: p.sqlReal,
      sqlModel: p.sqlModel,
      ...(p.db ? { db: p.db } : {}),
      ok: true,
      result: { columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated !== undefined, durationMs: r.durationMs },
      modelSaw: shaped.mode,
      anonymizedColumns: p.analysis.kind === 'query' ? p.analysis.outputs.filter((o) => o.taint === 'pii').map((o) => o.name) : [],
    }
  } else if (r.status === 'ok') {
    rows = r.affectedRows
    modelPayload = { status: 'ok', affected_rows: r.affectedRows }
    userEvent = { type: 'result', callId: call.id, sql: p.sqlReal, sqlModel: p.sqlModel, ...(p.db ? { db: p.db } : {}), ok: true, result: { columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: r.affectedRows, durationMs: r.durationMs }, modelSaw: 'affected', anonymizedColumns: [] }
  } else if (r.status === 'failed') {
    outcome = 'failed'
    // The database's own text can carry values ("Duplicate entry 'anna@x.example'"): the model gets the code only.
    modelPayload = { status: 'error', code: r.error.code }
    userEvent = { type: 'result', callId: call.id, sql: p.sqlReal, sqlModel: p.sqlModel, ...(p.db ? { db: p.db } : {}), ok: false, message: r.error.message }
  } else {
    outcome = 'failed'
    modelPayload = { status: 'error', code: 'not_run' }
    userEvent = { type: 'result', callId: call.id, sql: p.sqlReal, sqlModel: p.sqlModel, ...(p.db ? { db: p.db } : {}), ok: false, message: 'The statement was not run.' }
  }
  try {
    deps.audit('assistant.call', auditOf(state, p, { outcome, rows, durationMs }))
  } catch {
    toolMsg(state, call.id, { status: 'error', code: 'audit_failed' })
    out.push({ type: 'refused', callId: call.id, code: 'audit', message: p.access === 'write' ? 'The statement ran but could not be recorded; the assistant was not told the result.' : REFUSAL_TEXT.audit })
    return
  }
  toolMsg(state, call.id, modelPayload)
  out.push(userEvent)
}

async function describe(state: EngineState, deps: EngineDeps, call: ToolCall, args: { db: string; tables: string[] }, out: Out): Promise<void> {
  const described = await deps.describeTables(args.db, args.tables)
  const rules = deps.rules()
  const hide = deps.hideNames()
  const tables = described.map((t) => ({
    table: t.table,
    ...(t.view ? { view: true } : {}),
    found: t.found,
    columns: t.columns.map((c) => ({
      name: hide && rules.isPiiColumn(args.db, t.table, c.name) ? state.hider.register({ db: args.db, table: t.table, column: c.name }) : c.name,
      type: c.type,
      ...(c.key ? { key: c.key } : {}),
    })),
  }))
  try {
    deps.audit('assistant.call', { conversationId: state.id, userId: state.userId, callId: call.id, tool: 'describe_tables', db: args.db, tables: args.tables, outcome: 'ok' })
  } catch {
    refuse(state, deps, out, call, 'audit')
    return
  }
  toolMsg(state, call.id, { status: 'ok', tables })
  out.push({ type: 'step', tool: 'describe_tables', db: args.db, tables: args.tables })
}

/** Handles the call at the head of the queue. Returns true when the loop must pause for the user. */
async function handleHead(state: EngineState, deps: EngineDeps, out: Out): Promise<boolean> {
  const call = state.queue[0]!
  const parsed = parseToolCall(call.function.name, call.function.arguments)
  if (!parsed.ok) {
    const known = call.function.name === 'describe_tables' || call.function.name === 'run_query'
    toolMsg(state, call.id, { status: 'refused', reason: parsed.message })
    out.push({ type: 'refused', callId: call.id, code: known ? 'bad-arguments' : 'unknown-tool', message: parsed.message })
    state.queue.shift()
    return false
  }
  try {
    if (parsed.name === 'describe_tables') {
      await describe(state, deps, call, parsed.args, out)
      state.queue.shift()
      return false
    }
    const pending = await prepareQuery(state, deps, call, parsed.args, out)
    if (pending) return true // waiting for the user
    state.queue.shift()
    return false
  } catch {
    toolMsg(state, call.id, { status: 'error', code: 'internal' })
    out.push({ type: 'result', callId: call.id, sql: '', sqlModel: '', ok: false, message: 'The call could not be handled.' })
    state.queue.shift()
    return false
  }
}

function systemMessage(state: EngineState, deps: EngineDeps): ChatMessage {
  return { role: 'system', content: `${buildSystemPrompt({ hideNames: deps.hideNames() })}\n\nSchema outline:\n${state.outline || '(not available)'}` }
}

async function loop(state: EngineState, deps: EngineDeps, out: Out, signal?: AbortSignal): Promise<TurnStatus> {
  const budget = deps.maxTokensPerTurn ?? DEFAULT_TOKEN_BUDGET
  for (;;) {
    if (state.stopped) return 'stopped'
    while (state.queue.length > 0) {
      if (state.stopped) return 'stopped'
      if (state.awaiting) return 'awaiting_approval'
      const pause = await handleHead(state, deps, out)
      if (pause) return 'awaiting_approval'
    }
    if (state.steps >= deps.maxSteps) {
      out.push({ type: 'error', code: 'step_limit', message: REFUSAL_TEXT.limit, detail: `at most ${deps.maxSteps} steps for one message` })
      return 'error'
    }
    if (state.tokensUsed >= budget) {
      out.push({ type: 'error', code: 'token_limit', message: REFUSAL_TEXT.limit, detail: 'token budget of this message used up' })
      return 'error'
    }
    state.steps++
    let resp: ChatResponse
    try {
      resp = await deps.chat({ model: deps.model, messages: [systemMessage(state, deps), ...state.messages], tools: TOOL_DEFS }, signal)
    } catch (error) {
      if (error instanceof AiError && error.code === 'aborted') return 'stopped'
      out.push({ type: 'error', code: 'ai', message: error instanceof AiError ? error.message : 'The AI service failed.', ...(error instanceof AiError ? { detail: error.code } : {}) })
      return 'error'
    }
    state.tokensUsed += resp.totalTokens
    state.messages.push({ role: 'assistant', content: resp.content, ...(resp.toolCalls.length ? { tool_calls: resp.toolCalls } : {}) })
    if (resp.content) out.push({ type: 'assistant', text: resp.content })
    if (resp.toolCalls.length === 0) return 'done'
    state.queue = [...resp.toolCalls]
  }
}

const failureText: Record<ApprovalFailure, string> = {
  unknown: 'This call is not waiting for approval any more.',
  expired: 'The approval time ran out.',
  wrong_user: 'This call belongs to another user.',
  wrong_session: 'This call belongs to another session.',
  wrong_conversation: 'This call belongs to another conversation.',
  changed: 'The statement changed after it was shown. Review it again.',
}

async function guarded(state: EngineState, run: (out: Out) => Promise<TurnStatus>): Promise<TurnOutcome> {
  const out = new Out()
  if (state.busy) {
    out.push({ type: 'error', code: 'busy', message: 'The assistant is still working on the previous message.' })
    return { status: 'error', events: out.events }
  }
  state.busy = true
  try {
    return { status: await run(out), events: out.events }
  } finally {
    state.busy = false
  }
}

/** Answers every call that has no tool message yet so the history stays valid for the model. */
function settleOpenCalls(state: EngineState, deps: Pick<EngineDeps, 'approvals'>, out: Out, reason: 'stopped' | 'superseded'): void {
  const text = reason === 'stopped' ? 'The user stopped the assistant before this call ran.' : 'The user wrote a new message before this call was answered.'
  for (const call of state.queue) {
    toolMsg(state, call.id, { status: 'declined', reason: text })
    out.push({ type: 'denied', callId: call.id, reason })
  }
  state.queue = []
  state.awaiting = null
  deps.approvals.clearConversation(state.id)
}

/** A new user message: runs a turn. A call still waiting for approval is dropped (declined as superseded). */
export async function sendMessage(state: EngineState, deps: EngineDeps, text: string, signal?: AbortSignal): Promise<TurnOutcome> {
  return guarded(state, async (out) => {
    const limited = deps.rateLimit?.take(state.userId)
    if (limited && !limited.ok) {
      out.push({ type: 'error', code: 'rate_limited', message: 'Too many messages in a short time. Try again in a moment.', detail: `${Math.ceil(limited.retryAfterMs / 1000)} s` })
      return 'error'
    }
    if (state.queue.length > 0 || state.awaiting) settleOpenCalls(state, deps, out, 'superseded')
    state.stopped = false
    state.steps = 0
    state.tokensUsed = 0
    state.messages.push({ role: 'user', content: text })
    return loop(state, deps, out, signal)
  })
}

/** The user's decision on the waiting call. */
export async function resolveCall(
  state: EngineState,
  deps: EngineDeps,
  callId: string,
  decision: 'approve' | 'deny',
  who: { userId: string; sessionId: string },
  signal?: AbortSignal,
): Promise<TurnOutcome> {
  return guarded(state, async (out) => {
    const waiting = state.awaiting
    const pending = deps.approvals.get(callId)
    if (!waiting || waiting.callId !== callId || !state.queue[0] || state.queue[0].id !== callId) {
      out.push({ type: 'error', code: 'no_pending', message: failureText.unknown })
      return 'error'
    }
    const check = { userId: who.userId, sessionId: who.sessionId, conversationId: state.id }
    const call = state.queue[0]
    const settle = (reason: 'user' | 'expired') => {
      toolMsg(state, call.id, { status: 'declined', reason: reason === 'user' ? 'The user declined this call.' : 'The approval time ran out; the call was not run.' })
      out.push({ type: 'denied', callId, reason })
      state.queue.shift()
      state.awaiting = null
    }
    if (decision === 'deny') {
      const r = deps.approvals.deny(callId, check)
      if (!r.ok) {
        if (r.reason === 'expired') {
          settle('expired')
          return loop(state, deps, out, signal)
        }
        out.push({ type: 'error', code: 'approval_invalid', message: failureText[r.reason], detail: r.reason })
        return 'error'
      }
      bestEffort(deps, 'assistant.deny', { conversationId: state.id, userId: state.userId, callId, sql: r.call.sqlModel })
      settle('user')
      return loop(state, deps, out, signal)
    }
    if (!pending) {
      out.push({ type: 'error', code: 'no_pending', message: failureText.unknown })
      return 'error'
    }
    const r = deps.approvals.consume(callId, { ...check, sqlReal: pending.sqlReal })
    if (!r.ok) {
      if (r.reason === 'expired') {
        settle('expired')
        return loop(state, deps, out, signal)
      }
      out.push({ type: 'error', code: 'approval_invalid', message: failureText[r.reason], detail: r.reason })
      return 'error'
    }
    state.awaiting = null
    const analysis = await analysisFor(state, deps, r.call)
    if (analysis.kind !== 'unsupported' && analysis.violations.length > 0) {
      // the markings may have changed while the call waited
      refuse(state, deps, out, call, 'inference', undefined, { sqlModel: r.call.sqlModel })
      state.queue.shift()
      return loop(state, deps, out, signal)
    }
    const prepared: Prepared = { callId, sqlModel: r.call.sqlModel, sqlReal: r.call.sqlReal, ...(r.call.db ? { db: r.call.db } : {}), access: r.call.access, analysis, metadataOnly: analysis.kind === 'unsupported' }
    await execute(state, deps, call, prepared, out)
    state.queue.shift()
    return loop(state, deps, out, signal)
  })
}

/** The analysis is computed again when the call runs: the schema or the markings may have changed while it waited. */
async function analysisFor(state: EngineState, deps: EngineDeps, call: PendingCall): Promise<Analysis> {
  const parsed = parseStatement(call.sqlModel, deps.product)
  const schema = await deps.loadSchema(call.db, parsed.ok ? parsed.facts.tables : [])
  return analyzeStatement(call.sqlModel, {
    product: deps.product,
    ...(call.db ? { defaultDb: call.db } : {}),
    rules: deps.rules(),
    schema,
    unconfigured: deps.unconfigured(),
    isIssuedToken: (s) => state.tokens.isIssued(s),
  })
}

/** Stop: the running turn ends at the next step and every open call is declined. */
export function stopTurn(state: EngineState, deps: Pick<EngineDeps, 'approvals'>): TurnEvent[] {
  state.stopped = true
  const out = new Out()
  if (!state.busy) settleOpenCalls(state, deps, out, 'stopped')
  return out.events
}

export const newCallId = (): string => `call_${randomBytes(6).toString('hex')}`
