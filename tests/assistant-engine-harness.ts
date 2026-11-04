/**
 * Test harness for the assistant engine: fake dependencies around the real orchestrator, policy, analysis and tokens.
 * `chat` is scripted; the database is a queue of results; inspect classifies with the parser like the real hook does.
 */
import { vi } from 'vitest'
import { createApprovalStore } from '~/server/assistant/approval'
import type { ChatRequest, ChatResponse, ToolCall } from '~/server/assistant/client'
import { createEngineState, type AuditName, type EngineDeps, type EngineState, type TableDescription, type TurnEvent } from '~/server/assistant/orchestrator'
import { compileRules, parseRuleList } from '~/server/assistant/pii/rules'
import type { SchemaLookup } from '~/server/assistant/pii/taint'
import type { AssistantInspect, AssistantResult } from '~/server/sql/assistant'
import { parseStatement } from '~/server/sql/parser'
import type { SqlStatementResult } from '~/server/sql/types'

export const SCHEMA: Record<string, { columns: [string, string][]; view?: boolean }> = {
  'shop.customers': { columns: [['id', 'int'], ['email', 'varchar(120)'], ['first', 'varchar(40)'], ['last', 'varchar(40)'], ['city', 'varchar(40)'], ['salary', 'decimal(10,2)']] },
  'shop.orders': { columns: [['id', 'int'], ['customer_id', 'int'], ['total', 'decimal(10,2)'], ['note', 'text']] },
}
export const lookup: SchemaLookup = (db, table) => {
  const hit = SCHEMA[`${(db ?? 'shop').toLowerCase()}.${table.toLowerCase()}`]
  return hit ? { columns: hit.columns.map(([name, type]) => ({ name, type })), view: hit.view === true } : undefined
}
export const RULES = 'shop.customers.email, shop.customers.first, shop.customers.last, shop.customers.salary'

export const text = (content: string, tokens = 10): ChatResponse => ({ content, toolCalls: [], totalTokens: tokens, finishReason: 'stop' })
let n = 0
export const calls = (...cs: { name: string; args: Record<string, unknown> | string; id?: string }[]): ChatResponse => ({
  content: null,
  toolCalls: cs.map((c): ToolCall => ({ id: c.id ?? `call_${++n}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })),
  totalTokens: 10,
  finishReason: 'tool_calls',
})
export const query = (sql: string, extra: Record<string, unknown> = {}, id?: string) => calls({ name: 'run_query', args: { db: 'shop', sql, ...extra }, ...(id ? { id } : {}) })

export const rowsResult = (columns: [string, string][], rows: (string | null)[][]): AssistantResult => ({
  needsUser: false,
  ok: true,
  result: { status: 'rows', index: 0, sql: '', columns: columns.map(([name, type]) => ({ name, type })), rows, rowCount: rows.length, warnings: [], durationMs: 3 } as SqlStatementResult,
  facts: { kind: 'select', class: 'none', readOnlySafe: true, reasons: [] },
})
export const affectedResult = (affectedRows: number): AssistantResult => ({
  needsUser: false,
  ok: true,
  result: { status: 'ok', index: 0, sql: '', affectedRows, warnings: [], durationMs: 2 },
  facts: { kind: 'update', class: 'none', readOnlySafe: false, reasons: [] },
})
export const failedResult = (code: string, message: string): AssistantResult => ({
  needsUser: false,
  ok: false,
  result: { status: 'failed', index: 0, sql: '', error: { errno: 1062, code, message }, durationMs: 1 },
  facts: { kind: 'insert', class: 'none', readOnlySafe: false, reasons: [] },
})

/** Like the real hook: a read, an INSERT, an UPDATE with a restricting WHERE; everything else is for the user. */
export function fakeInspect(sql: string): AssistantInspect {
  const p = parseStatement(sql, 'mysql')
  if (!p.ok) return { ok: false, reason: `parse-${p.reason}` }
  const facts = (kind: string, readOnlySafe: boolean) => ({ kind: kind as 'select', class: 'none' as const, readOnlySafe, reasons: [] })
  if (p.facts.family === 'query') return { ok: true, access: 'read', sql, facts: facts('select', true) }
  if (p.facts.family === 'insert') return { ok: true, access: 'write', sql, facts: facts('insert', false) }
  if (p.facts.family === 'update' && p.facts.dml?.hasWhere && !p.facts.dml.whereNonRestricting) return { ok: true, access: 'write', sql, facts: facts('update', false) }
  return { ok: false, reason: p.facts.family }
}

export type Harness = ReturnType<typeof makeHarness>

type HarnessOptions = Omit<Partial<EngineDeps>, 'rules' | 'unconfigured' | 'hideNames'> & { mode?: 'manual' | 'auto'; rules?: string; unconfigured?: boolean; hideNames?: boolean }

export function makeHarness(options: HarnessOptions = {}) {
  const { mode, rules: rulesText, unconfigured, hideNames, ...over } = options
  const replies: (ChatResponse | Error | ((req: ChatRequest) => ChatResponse))[] = []
  const requests: ChatRequest[] = []
  const results: (AssistantResult | Error)[] = []
  const runs: { sql: string; db: string | undefined; approvedWrite: boolean }[] = []
  const audits: { event: AuditName; fields: Record<string, unknown> }[] = []
  const failAudit = new Set<AuditName>()
  const now = { t: 1_000_000 }
  const hide = { on: hideNames ?? false }
  const auto = { on: true }
  const rules = compileRules(parseRuleList(rulesText ?? RULES).rules)
  const approvals = createApprovalStore(() => now.t)

  const deps: EngineDeps = {
    chat: vi.fn(async (req: ChatRequest) => {
      requests.push(structuredClone(req))
      const next = replies.shift()
      if (!next) return text('(nothing scripted)')
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next(req) : next
    }),
    model: 'm-1',
    product: 'mysql',
    maxSteps: 8,
    maxRows: 50,
    autoAllowed: () => auto.on,
    hideNames: () => hide.on,
    rules: () => rules,
    unconfigured: () => unconfigured ?? false,
    loadSchema: async () => lookup,
    describeTables: async (db, tables): Promise<TableDescription[]> =>
      tables.map((t) => {
        const hit = SCHEMA[`${db}.${t}`]
        return { table: t, found: !!hit, columns: (hit?.columns ?? []).map(([name, type]) => ({ name, type })) }
      }),
    inspect: async (sql) => fakeInspect(sql),
    run: async (sql, db, approvedWrite) => {
      runs.push({ sql, db, approvedWrite })
      const r = results.shift()
      if (!r) throw new Error('no result scripted')
      if (r instanceof Error) throw r
      return r
    },
    audit: (event, fields) => {
      if (failAudit.has(event)) throw new Error('audit sink down')
      audits.push({ event, fields })
    },
    approvals,
    now: () => now.t,
    ...over,
  }
  const state: EngineState = createEngineState({ id: 'c1', userId: 'u1', sessionId: 's1', targetKey: 'db:3306', mode: mode ?? 'manual', outline: 'shop.customers(id int, email varchar(120))' })
  const who = { userId: 'u1', sessionId: 's1' }
  return { deps, state, who, replies, requests, results, runs, audits, failAudit, now, hide, auto, approvals, rules }
}

export const eventsOf = <T extends TurnEvent['type']>(events: TurnEvent[], type: T) => events.filter((e): e is Extract<TurnEvent, { type: T }> => e.type === type)

/** Every tool call of the history has its tool message, in order, before the next assistant message. */
export function historyIsValid(state: EngineState): string | null {
  const open = new Set<string>()
  for (const m of state.messages) {
    if (m.role === 'assistant') {
      if (open.size > 0) return `assistant message while ${[...open].join(',')} unanswered`
      for (const c of m.tool_calls ?? []) open.add(c.id)
    } else if (m.role === 'tool') {
      if (!open.delete(m.tool_call_id)) return `tool message ${m.tool_call_id} without a call`
    } else if (m.role === 'user' && open.size > 0) return `user message while ${[...open].join(',')} unanswered`
  }
  return null
}
