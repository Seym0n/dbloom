import { describe, expect, it } from 'vitest'
import { createApprovalStore, createRateLimiter, statementHash, APPROVAL_TTL_MS } from '~/server/assistant/approval'
import { decide, REFUSAL_TEXT } from '~/server/assistant/policy'
import { buildOutline, buildSystemPrompt, parseToolCall, toolEnvelope, TOOL_DEFS } from '~/server/assistant/tools'
import type { Analysis } from '~/server/assistant/pii/taint'
import type { AssistantInspect } from '~/server/sql/assistant'

// SPEC/34 FR-AST-002 (tools), FR-AST-003/005 (approval records), FR-AST-004 (policy), FR-AST-013 (rate limit).

const base = { userId: 'u1', sessionId: 's1', conversationId: 'c1' }
const call = (id = 'call_1', sql = "UPDATE t SET a = 1 WHERE id = 2") => ({ callId: id, ...base, sqlReal: sql, sqlModel: sql, access: 'write' as const })

describe('approval records', () => {
  it('are bound to user, session, conversation and the exact statement, and used once', () => {
    let t = 1000
    const s = createApprovalStore(() => t)
    const rec = s.issue(call())
    expect(rec).toMatchObject({ callId: 'call_1', createdAt: 1000, expiresAt: 1000 + APPROVAL_TTL_MS })
    expect(JSON.stringify(rec)).not.toContain('hash')
    const ok = s.consume('call_1', { ...base, sqlReal: "UPDATE t SET a = 1 WHERE id = 2" })
    expect(ok).toMatchObject({ ok: true, call: { callId: 'call_1' } })
    expect(s.consume('call_1', { ...base, sqlReal: "UPDATE t SET a = 1 WHERE id = 2" })).toEqual({ ok: false, reason: 'unknown' })
    expect(s.size()).toBe(0)
    t += 1
  })

  it('refuses another user, another session, another conversation or a changed statement, and leaves the record for the right caller', () => {
    const s = createApprovalStore(() => 1000)
    s.issue(call())
    const sql = "UPDATE t SET a = 1 WHERE id = 2"
    expect(s.consume('call_1', { ...base, userId: 'u2', sqlReal: sql })).toEqual({ ok: false, reason: 'wrong_user' })
    expect(s.consume('call_1', { ...base, sessionId: 's2', sqlReal: sql })).toEqual({ ok: false, reason: 'wrong_session' })
    expect(s.consume('call_1', { ...base, conversationId: 'c2', sqlReal: sql })).toEqual({ ok: false, reason: 'wrong_conversation' })
    expect(s.consume('call_1', { ...base, sqlReal: "UPDATE t SET a = 1 WHERE id = 3" })).toEqual({ ok: false, reason: 'changed' })
    expect(s.deny('call_1', { ...base, userId: 'u2' })).toEqual({ ok: false, reason: 'wrong_user' })
    expect(s.size()).toBe(1)
    expect(s.consume('call_1', { ...base, sqlReal: sql }).ok).toBe(true)
  })

  it('expires after ten minutes; an expired record is gone', () => {
    let t = 0
    const s = createApprovalStore(() => t)
    s.issue(call())
    t = APPROVAL_TTL_MS - 1
    expect(s.get('call_1')).toBeDefined()
    t = APPROVAL_TTL_MS
    expect(s.consume('call_1', { ...base, sqlReal: call().sqlReal })).toEqual({ ok: false, reason: 'expired' })
    expect(s.consume('call_1', { ...base, sqlReal: call().sqlReal })).toEqual({ ok: false, reason: 'unknown' })
    s.issue(call('call_2'))
    t += APPROVAL_TTL_MS + 5
    expect(s.deny('call_2', base)).toEqual({ ok: false, reason: 'expired' })
    expect(s.size()).toBe(0)
  })

  it('an expiry seen at the moment of the answer is reported as expired', () => {
    let t = 0
    const s = createApprovalStore(() => t)
    s.issue(call())
    t = APPROVAL_TTL_MS + 1
    expect(s.deny('call_1', base)).toEqual({ ok: false, reason: 'expired' })
  })

  it('deny takes the record out; clearConversation drops all of one conversation', () => {
    const s = createApprovalStore(() => 0)
    s.issue(call('a'))
    s.issue(call('b'))
    s.issue({ ...call('c'), conversationId: 'other' })
    expect(s.deny('a', base)).toMatchObject({ ok: true })
    expect(s.forConversation('c1').map((r) => r.callId)).toEqual(['b'])
    expect(s.clearConversation('c1')).toBe(1)
    expect(s.size()).toBe(1)
  })

  it('the statement hash is stable and sensitive', () => {
    expect(statementHash('a')).toBe(statementHash('a'))
    expect(statementHash('a')).not.toBe(statementHash('a '))
  })
})

describe('rate limit', () => {
  it('lets max takes through per key in the window, then says when to retry, per key', () => {
    let t = 0
    const r = createRateLimiter(3, 1000, () => t)
    for (let i = 0; i < 3; i++) expect(r.take('u1')).toEqual({ ok: true })
    expect(r.take('u1')).toEqual({ ok: false, retryAfterMs: 1000 })
    expect(r.take('u2')).toEqual({ ok: true })
    t = 400
    expect(r.take('u1')).toEqual({ ok: false, retryAfterMs: 600 })
    t = 1001
    expect(r.take('u1')).toEqual({ ok: true })
  })
})

describe('policy (FR-AST-004, FR-AST-009)', () => {
  const read: AssistantInspect = { ok: true, access: 'read', sql: 'SELECT 1', facts: { kind: 'select', class: 'none', readOnlySafe: true, reasons: [] } }
  const write: AssistantInspect = { ok: true, access: 'write', sql: 'UPDATE', facts: { kind: 'update', class: 'none', readOnlySafe: false, reasons: [] } }
  const refusedInspect: AssistantInspect = { ok: false, reason: 'no-where' }
  const query: Analysis = { kind: 'query', outputs: [], violations: [] }
  const writeAn: Analysis = { kind: 'write', violations: [] }
  const unsupported: Analysis = { kind: 'unsupported', reason: 'parse-rejected' }
  const violating: Analysis = { kind: 'query', outputs: [], violations: [{ code: 'inference', detail: 'LIKE on a PII column is refused' }] }
  const d = (inspect: AssistantInspect, analysis: Analysis, mode: 'manual' | 'auto', autoAllowed = true) => decide({ inspect, analysis, mode, autoAllowed })

  it('a read asks in manual mode and runs in auto mode', () => {
    expect(d(read, query, 'manual')).toEqual({ action: 'ask' })
    expect(d(read, query, 'auto')).toEqual({ action: 'run' })
  })

  it('auto mode switched off for everybody behaves as manual, whatever the conversation says', () => {
    expect(d(read, query, 'auto', false)).toEqual({ action: 'ask' })
  })

  it('a write always asks, also in auto mode', () => {
    expect(d(write, writeAn, 'manual')).toEqual({ action: 'ask' })
    expect(d(write, writeAn, 'auto')).toEqual({ action: 'ask' })
    expect(d(write, writeAn, 'auto', true)).not.toEqual({ action: 'run' })
  })

  it('a statement the guard does not accept is for the user only, in both modes', () => {
    expect(d(refusedInspect, query, 'manual')).toMatchObject({ action: 'refuse', code: 'user-only', detail: 'no-where' })
    expect(d(refusedInspect, query, 'auto')).toMatchObject({ action: 'refuse', code: 'user-only' })
  })

  it('an inference violation is refused in both modes, for reads and writes', () => {
    for (const mode of ['manual', 'auto'] as const) {
      expect(d(read, violating, mode)).toMatchObject({ action: 'refuse', code: 'inference' })
      expect(d(write, { kind: 'write', violations: violating.kind === 'query' ? violating.violations : [] }, mode)).toMatchObject({ action: 'refuse', code: 'inference' })
    }
  })

  it('a read the parser could not analyse asks (metadata only) in manual mode and is refused in auto mode', () => {
    expect(d(read, unsupported, 'manual')).toEqual({ action: 'ask', metadataOnly: true })
    expect(d(read, unsupported, 'auto')).toMatchObject({ action: 'refuse', code: 'unanalysable' })
  })

  it('a write that was not analysed as a write is refused', () => {
    expect(d(write, unsupported, 'manual')).toMatchObject({ action: 'refuse', code: 'unanalysable' })
    expect(d(write, query, 'manual')).toMatchObject({ action: 'refuse', code: 'unanalysable' })
  })

  it('every refusal code has a fixed text', () => {
    for (const code of ['user-only', 'inference', 'unanalysable', 'token', 'audit', 'limit', 'unknown-tool', 'bad-arguments'] as const) expect(REFUSAL_TEXT[code].length).toBeGreaterThan(10)
  })
})

describe('tools', () => {
  it('two tools with strict schemas', () => {
    expect(TOOL_DEFS.map((t) => t.function.name)).toEqual(['describe_tables', 'run_query'])
    for (const t of TOOL_DEFS) expect(t.function.parameters).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('valid arguments parse; extras, wrong types, empties, backticks and oversize are refused with a fixed message', () => {
    expect(parseToolCall('run_query', '{"sql":"SELECT 1"}')).toEqual({ ok: true, name: 'run_query', args: { sql: 'SELECT 1' } })
    expect(parseToolCall('run_query', '{"sql":"SELECT 1","db":"shop","purpose":"count"}')).toMatchObject({ ok: true })
    expect(parseToolCall('describe_tables', '{"db":"shop","tables":["a","b"]}')).toMatchObject({ ok: true, name: 'describe_tables' })
    for (const [name, args] of [
      ['run_query', '{"sql":"SELECT 1","extra":1}'],
      ['run_query', '{"sql":5}'],
      ['run_query', '{"sql":""}'],
      ['run_query', '{}'],
      ['run_query', '' ],
      ['run_query', `{"sql":"${'x'.repeat(20_001)}"}`],
      ['run_query', '{"sql":"SELECT 1","db":"a`b"}'],
      ['run_query', 'not json'],
      ['describe_tables', '{"db":"shop","tables":[]}'],
      ['describe_tables', `{"db":"shop","tables":[${Array.from({ length: 21 }, (_, i) => `"t${i}"`).join(',')}]}`],
    ] as const) {
      const r = parseToolCall(name, args)
      expect(r.ok, `${name} ${args.slice(0, 40)}`).toBe(false)
      if (!r.ok) expect(r.message).not.toContain('extra')
    }
  })

  it('an unknown tool is refused and its name is not echoed', () => {
    const r = parseToolCall('drop_everything', '{}')
    expect(r).toEqual({ ok: false, message: 'There is no such tool. The tools are describe_tables and run_query.' })
  })

  it('the envelope marks data as untrusted and caps the size', () => {
    expect(JSON.parse(toolEnvelope({ status: 'ok', rows: [['a']] }))).toEqual({ untrusted_data: true, status: 'ok', rows: [['a']] })
    const big = JSON.parse(toolEnvelope({ rows: [['x'.repeat(100_000)]] }))
    expect(big).toMatchObject({ untrusted_data: true, status: 'too_large' })
  })

  it('the system prompt explains tokens and untrusted data; hidden names add a line', () => {
    const p = buildSystemPrompt({ hideNames: false })
    expect(p).toMatch(/token/)
    expect(p).toMatch(/not instructions/)
    expect(p).not.toMatch(/col_1/)
    expect(buildSystemPrompt({ hideNames: true })).toMatch(/col_1/)
  })

  it('the outline lists tables with columns within the budget, then the names of the rest', () => {
    const tables = Array.from({ length: 50 }, (_, i) => ({ db: 'shop', table: `t${i}`, columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar(40)' }] }))
    const full = buildOutline(tables, 100_000)
    expect(full.split('\n')).toHaveLength(50)
    expect(full.split('\n')[0]).toBe('shop.t0(id int, name varchar(40))')
    const cut = buildOutline(tables, 400)
    const lines = cut.split('\n')
    expect(lines.at(-1)).toMatch(/^More tables \(columns not shown, use describe_tables\): shop\.t\d+/)
    expect(cut.length).toBeLessThan(900)
    expect(buildOutline([{ db: 'd', table: 'v', view: true, columns: [{ name: 'a', type: 'int' }] }])).toBe('d.v (view)(a int)')
    expect(buildOutline([])).toBe('')
  })
})
