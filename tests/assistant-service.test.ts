import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApprovalStore, createRateLimiter } from '~/server/assistant/approval'
import { readAssistantEnv } from '~/server/assistant/config'
import type { AiClient, ChatRequest, ChatResponse } from '~/server/assistant/client'
import { AiError } from '~/server/assistant/client'
import { createAssistantService, LIVE_IDLE_MS, LIVE_PER_OWNER, MESSAGE_MAX, type AssistantSession, type ServiceDeps } from '~/server/assistant/service'
import type { SchemaSource } from '~/server/assistant/schema-source'
import { schemaKey } from '~/server/assistant/schema-source'
import { ALL_TARGETS } from '~/server/assistant/store'
import type { User } from '~/server/auth/types'
import { initParser } from '~/server/sql/parser'
import type { TargetPool } from '~/server/db/target-pool'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'
import { SCHEMA, fakeInspect, query, rowsResult, text } from './assistant-engine-harness'
import type { AssistantResult } from '~/server/sql/assistant'

// SPEC/34 task 4: the service over a real store with a scripted AI, a fake schema and a fake SQL hook.

beforeAll(async () => {
  await initParser()
})

const CUSTOMERS: [string, string][] = [['id', 'int'], ['email', 'varchar(120)']]
const ROWS = [['1', 'anna@x.example'], ['2', 'ben@x.example']]

let dir: string
let store: SqliteStore
let t = 1_000_000
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-asst-svc-'))
  store = openSqliteStore(join(dir, 'store.db'))
  t = 1_000_000
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const mkUser = (id: string): User => ({ id, username: id, usernameKey: id, displayName: id, role: 'user', status: 'active', securityVersion: 1, mustChangePassword: false, tempPasswordExpiresAt: null, webauthnUserId: `w-${id}`, createdAt: 1, updatedAt: 1, createdBy: 'setup', lastSignInAt: null })

const schema: SchemaSource = {
  outline: async () => Object.entries(SCHEMA).map(([k, v]) => ({ db: k.split('.')[0]!, table: k.split('.')[1]!, columns: v.columns.map(([name, type]) => ({ name, type })) })),
  columns: async (_pool, pairs) => {
    const m = new Map<string, { columns: { name: string; type: string }[]; view: boolean }>()
    for (const p of pairs) {
      const hit = SCHEMA[schemaKey(p.db, p.table)]
      if (hit) m.set(schemaKey(p.db, p.table), { columns: hit.columns.map(([name, type]) => ({ name, type })), view: false })
    }
    return m
  },
}

function setup(over: { chat?: (req: ChatRequest) => ChatResponse; env?: Record<string, string>; settings?: Partial<ReturnType<ServiceDeps['settings']>>; withStore?: boolean } = {}) {
  const replies: (ChatResponse | Error)[] = []
  const requests: ChatRequest[] = []
  const results: AssistantResult[] = []
  const runs: string[] = []
  const audits: { event: string; fields: Record<string, unknown> }[] = []
  const settings = { assistantEnabled: true, assistantModel: 'm-1', assistantAutoAllowed: true, assistantHidePiiNames: false, ...over.settings }
  const client: AiClient = {
    chat: async (req) => {
      requests.push(structuredClone(req))
      if (over.chat) return over.chat(req)
      const r = replies.shift() ?? text('(nothing scripted)')
      if (r instanceof Error) throw r
      return r
    },
  }
  const deps: ServiceDeps = {
    env: () => readAssistantEnv({ DBLOOM_AI_BASE_URL: 'https://ai.example.com/v1', DBLOOM_PII_COLUMNS: 'shop.customers.email', ...over.env } as NodeJS.ProcessEnv),
    settings: () => settings,
    store: () => (over.withStore === false ? undefined : store.assistant),
    schema,
    sqlEnv: () => ({}) as never,
    createClient: () => client,
    audit: (event, fields) => void audits.push({ event, fields }),
    approvals: createApprovalStore(() => t),
    rateLimit: createRateLimiter(100, 60_000, () => t),
    productOf: async () => 'mysql',
    inspect: async (_env, sql) => fakeInspect(sql),
    run: async (_env, req) => {
      runs.push(req.text)
      const r = results.shift()
      if (!r) throw new Error('no result scripted')
      return r
    },
    now: () => t,
  }
  const svc = createAssistantService(deps)
  return { svc, deps, replies, requests, results, runs, audits, settings }
}

const session = (over: Partial<AssistantSession> = {}): AssistantSession => ({
  scopeKey: 'sess1/conn1', sessionId: 'sess1', ownerKey: 'u:ann', userId: 'ann', target: { host: 'db.example', port: 3306, username: 'ann' }, pool: {} as TargetPool, readOnly: false, ...over,
})
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'no error'
  } catch (e) {
    return (e as { code?: string }).code ?? String((e as Error).message).split(':')[0]
  }
}

describe('status', () => {
  it('available with endpoint, switch and model; reasons otherwise', () => {
    const a = setup()
    expect(a.svc.status(session())).toMatchObject({ available: true, autoAllowed: true, model: 'm-1', piiUnconfigured: false })
    expect(setup({ settings: { assistantEnabled: false } }).svc.status(session())).toMatchObject({ available: false, reason: 'disabled', model: null })
    expect(setup({ settings: { assistantModel: '' } }).svc.status(session())).toMatchObject({ available: false, reason: 'no-model' })
    expect(setup({ env: { DBLOOM_AI_BASE_URL: '' } }).svc.status(session())).toMatchObject({ available: false, reason: 'no-endpoint' })
  })

  it('reports an unconfigured target until markings or an acknowledgement exist', () => {
    const a = setup({ env: { DBLOOM_PII_COLUMNS: '' } })
    expect(a.svc.status(session()).piiUnconfigured).toBe(true)
    store.assistant.addPiiRule('db.example:3306', 'shop.customers.email', 'admin')
    expect(a.svc.status(session()).piiUnconfigured).toBe(false)
    const b = setup({ env: { DBLOOM_PII_COLUMNS: '' } })
    store.assistant.clearPiiAck(ALL_TARGETS)
    store.assistant.removePiiRule(store.assistant.listPiiRules()[0]!.id)
    expect(b.svc.status(session()).piiUnconfigured).toBe(true)
    store.assistant.setPiiAck('db.example:3306', 'admin')
    expect(b.svc.status(session()).piiUnconfigured).toBe(false)
  })
})

describe('conversations', () => {
  it('create needs an available assistant; an account conversation is stored, a direct one lives in memory', async () => {
    const off = setup({ settings: { assistantEnabled: false } })
    expect(await code(off.svc.create(session()))).toBe('assistant_unavailable')
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    expect(c).toMatchObject({ title: 'New conversation', mode: 'manual', live: true })
    expect(store.assistant.getConversation('ann', c.id)).toMatchObject({ targetKey: 'db.example:3306', mode: 'manual' })
    const mem = await a.svc.create(session({ ownerKey: 'db.example:3306|ann', userId: null }))
    expect(store.assistant.getConversation('ann', mem.id)).toBeUndefined()
    expect(a.svc.list(session({ ownerKey: 'db.example:3306|ann', userId: null })).map((x) => x.id)).toEqual([mem.id])
  })

  it('the outline of the first message comes from the schema and hides PII names when asked', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup({ settings: { assistantHidePiiNames: true } })
    const c = await a.svc.create(session())
    a.replies.push(text('hi'))
    await a.svc.send(session(), c.id, 'hello')
    await a.svc.settled(c.id)
    const system = a.requests[0]!.messages[0]!.content as string
    expect(system).toContain('shop.customers(id int, col_1 varchar(120)')
    expect(system.split('Schema outline:')[1]).not.toContain('email')
  })

  it('list shows the conversations of this target newest first, not those of another user or target', async () => {
    store.accounts.createUser(mkUser('ann'))
    store.accounts.createUser(mkUser('bob'))
    const a = setup()
    const c1 = await a.svc.create(session())
    t += 10
    const c2 = await a.svc.create(session())
    await a.svc.create(session({ ownerKey: 'u:bob', userId: 'bob' }))
    await a.svc.create(session({ target: { host: 'other.example', port: 3306, username: 'ann' } }))
    expect(a.svc.list(session()).map((x) => x.id)).toEqual([c2.id, c1.id])
  })

  it('at most 20 live conversations per owner: the idle oldest leaves memory, the store keeps it', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const first = await a.svc.create(session())
    for (let i = 0; i < LIVE_PER_OWNER; i++) {
      t += 1
      await a.svc.create(session())
    }
    expect(a.svc.liveCount()).toBeLessThanOrEqual(LIVE_PER_OWNER)
    expect(store.assistant.getConversation('ann', first.id)).toBeDefined()
    expect(a.svc.list(session()).find((x) => x.id === first.id)).toMatchObject({ live: false })
  })

  it('idle conversations leave memory after two hours', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    t += LIVE_IDLE_MS + 1
    expect(a.svc.list(session()).find((x) => x.id === c.id)).toMatchObject({ live: false })
    expect(a.svc.liveCount()).toBe(0)
  })
})

describe('a turn in the background', () => {
  it('send returns at once; the answer is polled; messages and the title are stored', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    a.replies.push(text('There are two customers.'))
    const sent = await a.svc.send(session(), c.id, '  How many customers do I have?  ')
    expect(sent.next).toBe(1)
    expect(a.svc.poll(session(), c.id, 0).status).toBe('running')
    await a.svc.settled(c.id)
    const p = a.svc.poll(session(), c.id, 0)
    expect(p.status).toBe('idle')
    expect(p.events).toEqual([{ type: 'user', text: 'How many customers do I have?' }, { type: 'assistant', text: 'There are two customers.' }])
    expect(a.svc.poll(session(), c.id, p.next).events).toEqual([])
    expect(store.assistant.getConversation('ann', c.id)!.title).toBe('How many customers do I have?')
    expect(store.assistant.listMessages('ann', c.id).map((m) => [m.role, m.content])).toEqual([['user', 'How many customers do I have?'], ['assistant', 'There are two customers.']])
  })

  it('a second message while one runs is refused as busy; empty and over-long messages are refused', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    let release: () => void = () => {}
    a.deps.createClient = () => ({ chat: () => new Promise<ChatResponse>((r) => (release = () => r(text('late')))) })
    const svc = createAssistantService(a.deps)
    // the service of this test shares the store but not the live map: create a conversation on it
    const c2 = await svc.create(session())
    await svc.send(session(), c2.id, 'one')
    expect(await code(svc.send(session(), c2.id, 'two'))).toBe('assistant_busy')
    release()
    await svc.settled(c2.id)
    expect(await code(a.svc.send(session(), c.id, '   '))).toBe('assistant_empty')
    expect(await code(a.svc.send(session(), c.id, 'x'.repeat(MESSAGE_MAX + 1)))).toBe('assistant_message_too_long')
  })

  it('an AI failure shows as an error event and the conversation stays usable', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    a.replies.push(new AiError('status', 'The AI service answered with status 500.', 500))
    await a.svc.send(session(), c.id, 'one')
    await a.svc.settled(c.id)
    expect(a.svc.poll(session(), c.id, 0).events.at(-1)).toMatchObject({ type: 'error', code: 'ai' })
    a.replies.push(text('back'))
    await a.svc.send(session(), c.id, 'two')
    await a.svc.settled(c.id)
    expect(a.svc.poll(session(), c.id, 0).events.at(-1)).toMatchObject({ type: 'assistant', text: 'back' })
  })
})

describe('approvals through the service', () => {
  const ask = async (a: ReturnType<typeof setup>, c: { id: string }) => {
    a.replies.push(query('SELECT id, email FROM customers', {}, 'call_1'), query("SELECT id FROM customers WHERE email = 'x'", {}, 'ignored'), text('Done.'))
    a.replies.splice(1, 1)
    await a.svc.send(session(), c.id, 'list them')
    await a.svc.settled(c.id)
  }

  it('manual mode: the call waits, runs after approval, the screen shows real values and the store keeps tokenized SQL and a count only', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    a.results.push(rowsResult(CUSTOMERS, ROWS))
    await ask(a, c)
    const waiting = a.svc.poll(session(), c.id, 0)
    expect(waiting.status).toBe('awaiting_approval')
    expect(waiting.events.find((e) => e.type === 'approval')).toMatchObject({ callId: 'call_1', sql: 'SELECT id, email FROM customers', access: 'read' })
    expect(a.runs).toEqual([])
    const r = await a.svc.resolve(session(), c.id, 'call_1', 'approve')
    await a.svc.settled(c.id)
    const done = a.svc.poll(session(), c.id, r.next)
    expect(done.status).toBe('idle')
    const result = done.events.find((e) => e.type === 'result')
    expect(JSON.stringify(result)).toContain('anna@x.example')
    expect(a.runs).toEqual(['SELECT id, email FROM customers'])
    const stored = store.assistant.listMessages('ann', c.id)
    expect(stored.map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(stored[1]).toMatchObject({ sql: 'SELECT id, email FROM customers', outcome: 'ok', rowCount: 2 })
    expect(JSON.stringify(stored)).not.toMatch(/anna@|ben@/)
    const everything = JSON.stringify(store.db.prepare('SELECT * FROM assistant_messages').all())
    expect(everything).not.toMatch(/anna@|ben@/)
  })

  it('an assistant answer with a token is shown with the real value and stored as the token', async () => {
    store.accounts.createUser(mkUser('ann'))
    let step = 0
    const a = setup({
      chat: (req) => {
        if (step++ === 0) return query('SELECT id, email FROM customers', {}, 'call_1')
        const tool = req.messages.findLast((m) => m.role === 'tool')
        const token = (JSON.parse(tool!.content as string) as { rows: string[][] }).rows[0]![1]
        return text(`The first customer is ${token}.`)
      },
    })
    const c = await a.svc.create(session({ }))
    store.assistant.updateConversation('ann', c.id, { mode: 'auto' })
    a.svc.setMode(session(), c.id, 'auto')
    a.results.push(rowsResult(CUSTOMERS, ROWS))
    await a.svc.send(session(), c.id, 'who is first?')
    await a.svc.settled(c.id)
    const shown = a.svc.poll(session(), c.id, 0).events.findLast((e) => e.type === 'assistant')
    expect(shown).toMatchObject({ type: 'assistant', text: 'The first customer is anna@x.example.' })
    const stored = store.assistant.listMessages('ann', c.id).findLast((m) => m.role === 'assistant')!
    expect(stored.content).toMatch(/^The first customer is <email:[a-z0-9]{4}:1>.$/)
  })

  it('nothing is approved by another owner, another connection, or when nothing waits', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    a.results.push(rowsResult(CUSTOMERS, ROWS))
    expect(await code(a.svc.resolve(session(), c.id, 'call_1', 'approve'))).toBe('assistant_not_waiting')
    await ask(a, c)
    expect(await code(a.svc.resolve(session({ ownerKey: 'u:bob', userId: 'bob' }), c.id, 'call_1', 'approve'))).toBe('assistant_not_found')
    expect(await code(a.svc.resolve(session({ target: { host: 'other.example', port: 3306, username: 'ann' } }), c.id, 'call_1', 'approve'))).toBe('assistant_wrong_target')
    // another session of the same user: the approval is bound to the session that asked
    await a.svc.resolve(session({ sessionId: 'sess-other' }), c.id, 'call_1', 'approve')
    await a.svc.settled(c.id)
    expect(a.svc.poll(session(), c.id, 0).events.some((e) => e.type === 'error' && e.code === 'approval_invalid')).toBe(true)
    expect(a.runs).toEqual([])
    expect(a.svc.poll(session(), c.id, 0).status).toBe('awaiting_approval')
  })

  it('stop declines the waiting call and returns to idle', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    await ask(a, c)
    const s = a.svc.stop(session(), c.id)
    const p = a.svc.poll(session(), c.id, 0)
    expect(p.status).toBe('idle')
    expect(p.events.some((e) => e.type === 'denied' && e.reason === 'stopped')).toBe(true)
    expect(s.next).toBe(p.next)
    expect(a.deps.approvals.size()).toBe(0)
  })
})

describe('mode', () => {
  it('switching is audited and stored; auto not allowed is refused; a running turn blocks it', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    expect(a.svc.setMode(session(), c.id, 'auto')).toEqual({ mode: 'auto' })
    expect(store.assistant.getConversation('ann', c.id)!.mode).toBe('auto')
    expect(a.audits).toEqual([{ event: 'assistant.mode', fields: { conversationId: c.id, userId: 'u:ann', from: 'manual', to: 'auto' } }])
    expect(a.svc.setMode(session(), c.id, 'auto')).toEqual({ mode: 'auto' })
    expect(a.audits).toHaveLength(1)
    a.settings.assistantAutoAllowed = false
    expect(await code(() => a.svc.setMode(session(), c.id, 'auto'))).toBe('assistant_auto_not_allowed')
    expect(a.svc.setMode(session(), c.id, 'manual')).toEqual({ mode: 'manual' }) // going back to manual is always possible
    const c2 = await a.svc.create(session())
    expect(await code(() => a.svc.setMode(session(), c2.id, 'auto'))).toBe('assistant_auto_not_allowed')
    expect(a.svc.setMode(session(), c2.id, 'manual')).toEqual({ mode: 'manual' })
  })

  it('a mode switch whose audit row fails does not change the mode', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    a.deps.audit = () => {
      throw new Error('sink down')
    }
    const svc = createAssistantService(a.deps)
    const c = await svc.create(session())
    expect(await code(() => svc.setMode(session(), c.id, 'auto'))).toBe('sink down')
    expect(svc.poll(session(), c.id, 0).mode).toBe('manual')
    expect(store.assistant.getConversation('ann', c.id)!.mode).toBe('manual')
  })
})

describe('open, rename, delete, purge', () => {
  it('a stored conversation comes back after it left memory: text only, mode kept, no rows', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    a.results.push(rowsResult(CUSTOMERS, ROWS))
    a.replies.push(query('SELECT id, email FROM customers', {}, 'call_1'), text('Two customers.'))
    await a.svc.send(session(), c.id, 'list them')
    await a.svc.settled(c.id)
    await a.svc.resolve(session(), c.id, 'call_1', 'approve')
    await a.svc.settled(c.id)
    a.svc.setMode(session(), c.id, 'auto')
    t += LIVE_IDLE_MS + 1
    a.svc.list(session()) // sweeps
    expect(a.svc.liveCount()).toBe(0)

    const opened = await a.svc.open(session(), c.id)
    expect(opened.mode).toBe('auto')
    expect(opened.summary.title).toBe('list them')
    expect(opened.items.map((i) => i.type)).toEqual(['user', 'tool', 'assistant'])
    expect(opened.items[1]).toMatchObject({ type: 'tool', sql: 'SELECT id, email FROM customers', outcome: 'ok', rowCount: 2 })
    expect(JSON.stringify(opened)).not.toMatch(/anna@|ben@/)
    // the model gets the text back, not the tool calls
    a.replies.push(text('Continuing.'))
    await a.svc.send(session(), c.id, 'and now?')
    await a.svc.settled(c.id)
    expect(a.requests.at(-1)!.messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('another user, another target and a missing id cannot open, rename or delete', async () => {
    store.accounts.createUser(mkUser('ann'))
    store.accounts.createUser(mkUser('bob'))
    const a = setup()
    const c = await a.svc.create(session())
    const bob = session({ ownerKey: 'u:bob', userId: 'bob' })
    expect(await code(a.svc.open(bob, c.id))).toBe('assistant_not_found')
    expect(await code(() => a.svc.rename(bob, c.id, 'mine'))).toBe('assistant_not_found')
    expect(await code(() => a.svc.delete(bob, c.id))).toBe('assistant_not_found')
    expect(await code(() => a.svc.poll(bob, c.id, 0))).toBe('assistant_not_found')
    expect(await code(a.svc.open(session({ target: { host: 'other.example', port: 1, username: 'ann' } }), c.id))).toBe('assistant_wrong_target')
    expect(await code(a.svc.open(session(), 'cv_missing'))).toBe('assistant_not_found')
    expect(store.assistant.getConversation('ann', c.id)).toBeDefined()
  })

  it('rename and delete reach memory and store; deleting clears waiting approvals', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const c = await a.svc.create(session())
    expect(a.svc.rename(session(), c.id, '  Orders   per month ').title).toBe('Orders per month')
    expect(store.assistant.getConversation('ann', c.id)!.title).toBe('Orders per month')
    expect(await code(() => a.svc.rename(session(), c.id, '   '))).toBe('assistant_empty')
    a.replies.push(query('SELECT 1', {}, 'call_9'))
    await a.svc.send(session(), c.id, 'q')
    await a.svc.settled(c.id)
    expect(a.deps.approvals.size()).toBe(1)
    expect(a.svc.delete(session(), c.id)).toEqual({ ok: true })
    expect(a.deps.approvals.size()).toBe(0)
    expect(store.assistant.getConversation('ann', c.id)).toBeUndefined()
    expect(a.svc.list(session())).toEqual([])
  })

  it('a conversation without a store lives and dies in memory', async () => {
    const a = setup({ withStore: false })
    const me = session({ ownerKey: 'db.example:3306|ann', userId: null })
    const c = await a.svc.create(me)
    a.replies.push(text('ok'))
    await a.svc.send(me, c.id, 'hi')
    await a.svc.settled(c.id)
    expect((await a.svc.open(me, c.id)).items).toHaveLength(2)
    t += LIVE_IDLE_MS + 1
    a.svc.list(me)
    expect(await code(a.svc.open(me, c.id))).toBe('assistant_not_found')
  })

  it('purge removes old conversations from the store and idle ones from memory', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup()
    const old = await a.svc.create(session())
    t += 10_000
    const fresh = await a.svc.create(session())
    expect(a.svc.purge(t - 5_000)).toBeGreaterThanOrEqual(1)
    expect(store.assistant.getConversation('ann', old.id)).toBeUndefined()
    expect(store.assistant.getConversation('ann', fresh.id)).toBeDefined()
    expect(a.svc.list(session()).map((x) => x.id)).toEqual([fresh.id])
  })
})

describe('the log', () => {
  it('is capped and a client that fell behind gets what is left', async () => {
    store.accounts.createUser(mkUser('ann'))
    const a = setup({ withStore: false })
    const me = session({ ownerKey: 'o', userId: null })
    const c = await a.svc.create(me)
    for (let i = 0; i < 250; i++) {
      a.replies.push(text(`answer ${i}`))
      await a.svc.send(me, c.id, `question ${i}`)
      await a.svc.settled(c.id)
    }
    const p = a.svc.poll(me, c.id, 0)
    expect(p.events.length).toBeLessThanOrEqual(400)
    expect(p.next).toBe(500)
    expect(a.svc.poll(me, c.id, 499).events).toHaveLength(1)
  })
})
