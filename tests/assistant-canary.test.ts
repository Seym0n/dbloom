import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAiClient } from '~/server/assistant/client'
import { resolveCall, sendMessage } from '~/server/assistant/orchestrator'
import { initParser } from '~/server/sql/parser'
import { startMockAi, type MockAi } from './fixtures/mock-ai-server'
import { rowsResult, makeHarness } from './assistant-engine-harness'

// SPEC/34 success criterion 3: with canary values in PII columns, none of them appears in any request that would leave the
// machine, in the audit rows, in the log or in the conversation history. Real HTTP to a mock OpenAI-compatible server.

const EMAIL = 'canary.anna@canary-mail.example'
const NAME = 'Canarina Meyer'
const SALARY = '98765.43'
const CANARIES = [EMAIL, NAME, 'Canarina', SALARY, 'canary-mail']

let ai: MockAi
beforeAll(async () => {
  await initParser()
  ai = await startMockAi()
})
afterAll(async () => ai.close())

const T: [string, string][] = [['id', 'int'], ['email', 'varchar(120)'], ['first', 'varchar(40)'], ['last', 'varchar(40)'], ['city', 'varchar(40)'], ['salary', 'decimal(10,2)']]
const rowFor = (id: string): string[] => [id, EMAIL, 'Canarina', 'Meyer', 'Paris', SALARY]

/** Statement, result columns and rows as the database would answer; PII columns carry the canaries. */
const CASES: { name: string; sql: string; cols: [string, string][]; rows: string[][] }[] = [
  { name: 'plain', sql: 'SELECT id, email FROM customers', cols: [['id', 'int'], ['email', 'varchar(120)']], rows: [['1', EMAIL]] },
  { name: 'SELECT *', sql: 'SELECT * FROM customers', cols: T, rows: [rowFor('1')] },
  { name: 'alias', sql: 'SELECT email AS contact FROM customers', cols: [['contact', 'varchar(120)']], rows: [[EMAIL]] },
  { name: 'concat', sql: "SELECT CONCAT(first, ' ', last) AS full_name FROM customers", cols: [['full_name', 'varchar(81)']], rows: [[NAME]] },
  { name: 'join', sql: 'SELECT o.total, c.email FROM orders o JOIN customers c ON c.id = o.customer_id', cols: [['total', 'decimal'], ['email', 'varchar(120)']], rows: [['12.50', EMAIL]] },
  { name: 'CTE', sql: 'WITH w AS (SELECT email AS m FROM customers) SELECT m FROM w', cols: [['m', 'varchar(120)']], rows: [[EMAIL]] },
  { name: 'union', sql: 'SELECT city FROM customers UNION SELECT email FROM customers', cols: [['city', 'varchar(120)']], rows: [['Paris'], [EMAIL]] },
  { name: 'derived table', sql: 'SELECT x FROM (SELECT email AS x FROM customers) t', cols: [['x', 'varchar(120)']], rows: [[EMAIL]] },
  { name: 'scalar subquery', sql: 'SELECT (SELECT email FROM customers c WHERE c.id = o.customer_id) AS e FROM orders o', cols: [['e', 'varchar(120)']], rows: [[EMAIL]] },
  { name: 'aggregate over a PII number', sql: 'SELECT MAX(salary) AS top FROM customers', cols: [['top', 'decimal']], rows: [[SALARY]] },
  { name: 'upper and trim', sql: 'SELECT UPPER(TRIM(email)) FROM customers', cols: [['UPPER(TRIM(email))', 'varchar(120)']], rows: [[EMAIL.toUpperCase()]] },
  { name: 'a statement the analysis cannot trace (unknown column)', sql: 'SELECT secret_mail FROM customers', cols: [['secret_mail', 'varchar(120)']], rows: [[EMAIL]] },
]

describe('the canary scan', () => {
  it.each(CASES)('$name: no canary reaches the AI service, the audit, the log or the history; the user sees the real value', async (c) => {
    const logs: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))))
    try {
      ai.requests.length = 0
      const client = createAiClient({ baseUrl: ai.baseUrl, apiKey: 'sk-test', allowPrivate: true })
      const h = makeHarness({ mode: 'auto', chat: (req, signal) => client.chat(req, signal) })
      h.results.push(rowsResult(c.cols, c.rows))
      ai.script({ toolCalls: [{ name: 'run_query', arguments: { db: 'shop', sql: c.sql } }] }, { content: 'Here is what I found.' })
      const out = await sendMessage(h.state, h.deps, 'Show me the data')
      expect(out.status).toBe('done')
      expect(ai.requests).toHaveLength(2)

      const everything = JSON.stringify({ requests: ai.requests, audits: h.audits, logs, history: h.state.messages })
      for (const canary of CANARIES) expect(everything, `${c.name}: ${canary}`).not.toContain(canary)

      const shown = JSON.stringify(out.events)
      expect(shown, 'the user sees the real value').toMatch(/canary|Canarina|98765/i)
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })

  it('a token round trip: the model asks about a value by token, the database gets the real value, the AI service never does', async () => {
    ai.requests.length = 0
    const client = createAiClient({ baseUrl: ai.baseUrl, apiKey: 'sk-test', allowPrivate: true })
    const h = makeHarness({ mode: 'auto', chat: (req, signal) => client.chat(req, signal) })
    h.results.push(rowsResult([['id', 'int'], ['email', 'varchar(120)']], [['1', EMAIL]]), rowsResult([['total', 'decimal']], [['12.50']]))
    ai.script(
      { toolCalls: [{ name: 'run_query', arguments: { db: 'shop', sql: 'SELECT id, email FROM customers' } }] },
      (body) => {
        const tool = JSON.parse(body.messages.at(-1)!.content as string) as { rows: string[][] }
        return { toolCalls: [{ name: 'run_query', arguments: { db: 'shop', sql: `SELECT total FROM orders WHERE customer_id = 1 AND note = '${tool.rows[0]![1]}'` } }] }
      },
      (body) => ({ content: `Their total is 12.50 (${(JSON.parse(body.messages.find((m) => m.role === 'tool')!.content as string) as { rows: string[][] }).rows[0]![1]}).` }),
    )
    const out = await sendMessage(h.state, h.deps, 'What did they order?')
    expect(out.status).toBe('done')
    expect(h.runs[1]!.sql).toBe(`SELECT total FROM orders WHERE customer_id = 1 AND note = '${EMAIL}'`)
    expect(JSON.stringify(ai.requests)).not.toContain(EMAIL)
    expect(JSON.stringify(h.audits)).not.toContain(EMAIL)
    // the answer's token is shown to the user as the real value
    const text = out.events.find((e) => e.type === 'assistant' && e.text.startsWith('Their total'))
    expect(text).toBeDefined()
    if (text?.type === 'assistant') expect(h.state.tokens.revealText(text.text)).toContain(EMAIL)
  })

  it('manual mode: nothing about the data leaves before Approve, and the approved result is tokenized', async () => {
    ai.requests.length = 0
    const client = createAiClient({ baseUrl: ai.baseUrl, apiKey: 'sk-test', allowPrivate: true })
    const h = makeHarness({ chat: (req, signal) => client.chat(req, signal) })
    h.results.push(rowsResult([['id', 'int'], ['email', 'varchar(120)']], [['1', EMAIL]]))
    ai.script({ toolCalls: [{ name: 'run_query', arguments: { db: 'shop', sql: 'SELECT id, email FROM customers' } }] }, { content: 'done' })
    const first = await sendMessage(h.state, h.deps, 'list')
    expect(first.status).toBe('awaiting_approval')
    expect(h.runs).toHaveLength(0)
    expect(ai.requests).toHaveLength(1)
    const callId = h.approvals.forConversation('c1')[0]!.callId
    const second = await resolveCall(h.state, h.deps, callId, 'approve', h.who)
    expect(second.status).toBe('done')
    expect(JSON.stringify(ai.requests)).not.toContain(EMAIL)
    expect(JSON.parse(ai.requests[1]!.body).messages.at(-1).content).toMatch(/<email:[a-z0-9]{4}:1>/)
  })

  it('the request carries the model, messages and tools only: no key in the body, no cookie, no connection detail', async () => {
    ai.requests.length = 0
    const client = createAiClient({ baseUrl: ai.baseUrl, apiKey: 'sk-test-secret', allowPrivate: true })
    const h = makeHarness({ mode: 'auto', chat: (req, signal) => client.chat(req, signal) })
    ai.script({ content: 'hi' })
    await sendMessage(h.state, h.deps, 'hello')
    const sent = ai.requests[0]!
    expect(Object.keys(JSON.parse(sent.body)).sort()).toEqual(['messages', 'model', 'stream', 'tools'])
    expect(sent.body).not.toContain('sk-test-secret')
    expect(sent.headers.cookie).toBeUndefined()
    expect(sent.body).not.toMatch(/db:3306|"u1"|"s1"|session/i)
  })
})
