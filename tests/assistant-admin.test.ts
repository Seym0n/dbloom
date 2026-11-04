import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSISTANT_STEP_UP_PURPOSE, createAssistantAdminService, RULE_LIMIT, ACK_LIMIT, type AssistantAdminService } from '~/server/assistant/admin-service'
import { readAssistantEnv } from '~/server/assistant/config'
import { compileRules, parseRuleList } from '~/server/assistant/pii/rules'
import { suggestFromOutline, SUGGESTION_LIMIT } from '~/server/assistant/suggest'
import { ALL_TARGETS } from '~/server/assistant/store'
import { AuditUnavailable } from '~/server/audit'
import { isStepUpPurpose } from '~/server/auth/step-up-set'
import { AuthError, type AccountContext } from '~/server/auth/types'
import { addRuleInput, ackInput, removeRuleInput } from '~/server/assistant-admin.functions'
import { openSqliteStore, type SqliteStore } from '~/server/store/sqlite-store'

// SPEC/34 task 6: the administrator side of the assistant page: roles, step-up, validation, audit in the transaction.

let dir: string
let store: SqliteStore
let audits: { event: string; fields: Record<string, unknown> }[]
let published: number
let stepUpOk: boolean
let stepUpPurposes: string[]
let mode: 'account' | 'direct' | 'setup' | 'stateless'
let failAudit: boolean
let withStore: boolean

const user = (id: string, role: 'admin' | 'user', status: 'active' | 'disabled' = 'active') =>
  store.accounts.createUser({ id, username: id, usernameKey: id, displayName: `Name of ${id}`, role, status, securityVersion: 0, mustChangePassword: false, tempPasswordExpiresAt: null, webauthnUserId: `w-${id}`, createdAt: 1, updatedAt: 1, createdBy: 'setup', lastSignInAt: null })

const ctxOf = (id: string, role: 'admin' | 'user' = 'admin', state: AccountContext['state'] = 'full'): AccountContext =>
  ({ idHash: `s-${id}`, csrf: 'c', kind: 'account', state, user: { id, username: id, displayName: id, role, securityVersion: 0 }, ownerKey: `u:${id}`, mfaAt: 1, stepupAt: 1 }) as AccountContext

function make(envVars: Record<string, string> = {}): AssistantAdminService {
  return createAssistantAdminService({
    store: () => (withStore ? store.assistant : undefined),
    accounts: store.accounts,
    env: () => readAssistantEnv({ DBLOOM_AI_BASE_URL: 'https://ai.example.com/v1', DBLOOM_AI_API_KEY: 'sk-secret-key', DBLOOM_PII_COLUMNS: '*.*.ssn', ...envVars } as NodeJS.ProcessEnv),
    stepUp: {
      requireRecentFactor: (_ctx, purpose) => {
        stepUpPurposes.push(purpose)
        if (!stepUpOk) throw new AuthError('stepup_required')
      },
    },
    mode: () => mode,
    transaction: (fn) => {
      store.db.exec('BEGIN IMMEDIATE')
      try {
        const out = fn()
        store.db.exec('COMMIT')
        return out
      } catch (error) {
        store.db.exec('ROLLBACK')
        throw error
      }
    },
    auditIn: (event, fields) => {
      if (failAudit) throw new AuditUnavailable('sink down')
      audits.push({ event, fields })
      return () => void published++
    },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-asst-admin-'))
  store = openSqliteStore(join(dir, 'store.db'))
  audits = []
  published = 0
  stepUpOk = true
  stepUpPurposes = []
  mode = 'account'
  failAudit = false
  withStore = true
  user('a1', 'admin')
  user('a2', 'admin', 'disabled')
  user('u1', 'user')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const code = (fn: () => unknown) => {
  try {
    fn()
    return 'no error'
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
}

describe('who may do what', () => {
  it('only an active administrator of a full session in account mode; everybody else gets auth_failed', () => {
    const s = make()
    for (const [label, ctx] of [
      ['user', ctxOf('u1', 'user')],
      ['disabled admin', ctxOf('a2')],
      ['not full', ctxOf('a1', 'admin', 'pending_mfa')],
      ['unknown id', ctxOf('ghost')],
      ['claims admin, row says user', ctxOf('u1', 'admin')],
    ] as const) {
      expect(code(() => s.overview(ctx)), label).toBe('auth_failed')
      expect(code(() => s.addRule(ctx, { targetKey: '', rule: 'a.b.c' })), label).toBe('auth_failed')
      expect(code(() => s.removeRule(ctx, 1)), label).toBe('auth_failed')
      expect(code(() => s.setAck(ctx, { targetKey: '' })), label).toBe('auth_failed')
      expect(code(() => s.clearAck(ctx, { targetKey: '' })), label).toBe('auth_failed')
    }
    mode = 'direct'
    expect(code(() => s.overview(ctxOf('a1')))).toBe('auth_failed')
    mode = 'stateless'
    expect(code(() => s.overview(ctxOf('a1')))).toBe('auth_failed')
    expect(store.assistant.listPiiRules()).toEqual([])
  })

  it('every change needs a recent second factor with the declared purpose; reading does not', () => {
    const s = make()
    expect(isStepUpPurpose(ASSISTANT_STEP_UP_PURPOSE)).toBe(true)
    s.overview(ctxOf('a1'))
    expect(stepUpPurposes).toEqual([])
    stepUpOk = false
    for (const call of [() => s.addRule(ctxOf('a1'), { targetKey: '', rule: 'a.b.c' }), () => s.removeRule(ctxOf('a1'), 1), () => s.setAck(ctxOf('a1'), { targetKey: '' }), () => s.clearAck(ctxOf('a1'), { targetKey: '' })]) {
      expect(code(call)).toBe('stepup_required')
    }
    expect(stepUpPurposes).toEqual(Array(4).fill('assistant.rule'))
    expect(store.assistant.listPiiRules()).toEqual([])
    expect(audits).toEqual([])
  })
})

describe('overview', () => {
  it('shows the endpoint without the key, the environment markings, stored markings with names, and acknowledgements', () => {
    const s = make()
    s.addRule(ctxOf('a1'), { targetKey: 'db.example:3306', rule: 'Shop.Customers.Email' })
    s.setAck(ctxOf('a1'), { targetKey: 'other.example:3306' })
    const o = s.overview(ctxOf('a1'))
    expect(o.stored).toBe(true)
    expect(o.endpoint).toEqual({ configured: true, origin: 'https://ai.example.com', keySet: true, allowPrivate: false, problems: [] })
    expect(JSON.stringify(o)).not.toContain('sk-secret-key')
    expect(o.envRules).toEqual(['*.*.ssn'])
    expect(o.rules).toEqual([expect.objectContaining({ targetKey: 'db.example:3306', rule: 'shop.customers.email', createdBy: 'Name of a1' })])
    expect(o.acks).toEqual([expect.objectContaining({ targetKey: 'other.example:3306', acknowledgedBy: 'Name of a1' })])
  })

  it('without a store (stateless) there is nothing to keep: the page says so and every change is refused', () => {
    withStore = false
    const s = make()
    expect(s.overview(ctxOf('a1'))).toMatchObject({ stored: false, rules: [], acks: [], envRules: ['*.*.ssn'] })
    expect(s.addRule(ctxOf('a1'), { targetKey: '', rule: 'a.b.c' })).toEqual({ ok: false, error: 'unavailable' })
    expect(s.removeRule(ctxOf('a1'), 1)).toEqual({ ok: false, error: 'unavailable' })
    expect(s.setAck(ctxOf('a1'), { targetKey: '' })).toEqual({ ok: false, error: 'unavailable' })
    expect(s.clearAck(ctxOf('a1'), { targetKey: '' })).toEqual({ ok: false, error: 'unavailable' })
  })

  it('no endpoint is reported as not configured', () => {
    const o = make({ DBLOOM_AI_BASE_URL: '', DBLOOM_AI_API_KEY: '' }).overview(ctxOf('a1'))
    expect(o.endpoint).toMatchObject({ configured: false, origin: null, keySet: false })
  })
})

describe('markings', () => {
  it('add: validates, normalises, is idempotent, audits first and publishes after the commit', () => {
    const s = make()
    const first = s.addRule(ctxOf('a1'), { targetKey: 'db.example:3306', rule: ' Shop.Customers.* ' })
    expect(first).toMatchObject({ ok: true, created: true, rule: { rule: 'shop.customers.*', targetKey: 'db.example:3306' } })
    expect(audits).toEqual([{ event: 'assistant.rule', fields: { actor: 'a1', op: 'add', target: 'db.example:3306', rule: 'shop.customers.*' } }])
    expect(published).toBe(1)
    expect(s.addRule(ctxOf('a1'), { targetKey: 'db.example:3306', rule: 'shop.customers.*' })).toMatchObject({ ok: true, created: false })
    expect(store.assistant.listPiiRules()).toHaveLength(1)
    s.addRule(ctxOf('a1'), { targetKey: ALL_TARGETS, rule: '*.*.phone' })
    expect(audits.at(-1)!.fields.target).toBe('all')
  })

  it('refuses a rule that is not db.table.column and a target key that is not one', () => {
    const s = make()
    for (const rule of ['', 'email', 'a.b', 'a.b.c.d', 'a.b.c*', "a.b.'c'"]) expect(s.addRule(ctxOf('a1'), { targetKey: '', rule }), rule).toEqual({ ok: false, error: 'bad_rule' })
    for (const targetKey of ['has space:1', 'pipe|x', 'x'.repeat(201)]) expect(s.addRule(ctxOf('a1'), { targetKey, rule: 'a.b.c' }), targetKey).toEqual({ ok: false, error: 'bad_target' })
    expect(audits).toEqual([])
    expect(store.assistant.listPiiRules()).toEqual([])
  })

  it('stops at the limit; an existing rule can still be re-added', () => {
    const s = make()
    for (let i = 0; i < RULE_LIMIT; i++) store.assistant.addPiiRule('t:1', `d.t${i}.c`, 'a1')
    expect(s.addRule(ctxOf('a1'), { targetKey: 't:1', rule: 'd.extra.c' })).toEqual({ ok: false, error: 'too_many' })
    expect(s.addRule(ctxOf('a1'), { targetKey: 't:1', rule: 'd.t5.c' })).toMatchObject({ ok: true, created: false })
  })

  it('a row that cannot be audited is not changed and nothing is published', () => {
    const s = make()
    failAudit = true
    expect(s.addRule(ctxOf('a1'), { targetKey: '', rule: 'a.b.c' })).toEqual({ ok: false, error: 'audit_unavailable' })
    expect(store.assistant.listPiiRules()).toEqual([])
    expect(published).toBe(0)
    failAudit = false
    const { rule } = s.addRule(ctxOf('a1'), { targetKey: '', rule: 'a.b.c' }) as { rule: { id: number } }
    failAudit = true
    expect(s.removeRule(ctxOf('a1'), rule.id)).toEqual({ ok: false, error: 'audit_unavailable' })
    expect(store.assistant.listPiiRules()).toHaveLength(1)
    expect(s.setAck(ctxOf('a1'), { targetKey: 't:1' })).toEqual({ ok: false, error: 'audit_unavailable' })
    expect(store.assistant.getPiiAck('t:1')).toBeUndefined()
  })

  it('a failure inside the change rolls the audit row back too', () => {
    const s = make()
    const original = store.assistant.addPiiRule
    store.assistant.addPiiRule = () => {
      throw new Error('disk full')
    }
    expect(() => s.addRule(ctxOf('a1'), { targetKey: '', rule: 'a.b.c' })).toThrow('disk full')
    store.assistant.addPiiRule = original
    expect(published).toBe(0)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM pii_rules').get()).toEqual({ n: 0 })
  })

  it('remove: audits what was removed; an unknown id is not_found and audits nothing', () => {
    const s = make()
    const { rule } = s.addRule(ctxOf('a1'), { targetKey: 't:1', rule: 'a.b.c' }) as { rule: { id: number } }
    audits.length = 0
    expect(s.removeRule(ctxOf('a1'), rule.id)).toMatchObject({ ok: true, removed: { rule: 'a.b.c' } })
    expect(audits).toEqual([{ event: 'assistant.rule', fields: { actor: 'a1', op: 'remove', target: 't:1', rule: 'a.b.c' } }])
    expect(s.removeRule(ctxOf('a1'), rule.id)).toEqual({ ok: false, error: 'not_found' })
    expect(audits).toHaveLength(1)
  })
})

describe('acknowledgements', () => {
  it('set, replace by another administrator, clear; each audited', () => {
    const s = make()
    expect(s.setAck(ctxOf('a1'), { targetKey: 't:1' })).toMatchObject({ ok: true, ack: { targetKey: 't:1', acknowledgedBy: 'Name of a1' } })
    expect(audits.at(-1)).toEqual({ event: 'assistant.rule', fields: { actor: 'a1', op: 'ack', target: 't:1' } })
    expect(s.clearAck(ctxOf('a1'), { targetKey: 't:1' })).toEqual({ ok: true, cleared: true })
    expect(audits.at(-1)!.fields.op).toBe('unack')
    expect(s.clearAck(ctxOf('a1'), { targetKey: 't:1' })).toEqual({ ok: false, error: 'not_found' })
    expect(s.setAck(ctxOf('a1'), { targetKey: 'bad key' })).toEqual({ ok: false, error: 'bad_target' })
  })

  it('stops at the limit; an existing one can be set again', () => {
    const s = make()
    for (let i = 0; i < ACK_LIMIT; i++) store.assistant.setPiiAck(`t${i}:1`, 'a1')
    expect(s.setAck(ctxOf('a1'), { targetKey: 'one-more:1' })).toEqual({ ok: false, error: 'too_many' })
    expect(s.setAck(ctxOf('a1'), { targetKey: 't3:1' })).toMatchObject({ ok: true })
  })
})

describe('functions file', () => {
  it('validates strictly', () => {
    expect(addRuleInput.safeParse({ targetKey: '', rule: 'a.b.c' }).success).toBe(true)
    expect(addRuleInput.safeParse({ targetKey: '', rule: 'a.b.c', extra: 1 }).success).toBe(false)
    expect(addRuleInput.safeParse({ targetKey: '', rule: '' }).success).toBe(false)
    expect(removeRuleInput.safeParse({ id: 0 }).success).toBe(false)
    expect(removeRuleInput.safeParse({ id: 3 }).success).toBe(true)
    expect(ackInput.safeParse({ targetKey: 'x'.repeat(201) }).success).toBe(false)
  })

  it('imports only what a browser chunk may keep', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server', 'assistant-admin.functions.ts'), 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports.sort()).toEqual(['./assistant-admin-runtime', './auth/error-transport', './middleware', '@tanstack/react-start', 'zod'].sort())
  })
})

describe('suggestions', () => {
  const tables = [
    { db: 'shop', table: 'customers', columns: ['id', 'email', 'first_name', 'LastName', 'phone_number', 'dob', 'city', 'iban', 'ip_address', 'api_key'].map((name) => ({ name, type: 'varchar' })) },
    { db: 'shop', table: 'orders', columns: ['id', 'total', 'street', 'ssn', 'notes'].map((name) => ({ name, type: 'varchar' })) },
  ]
  it('finds columns that look like personal data, with a reason, and leaves marked and plain ones out', () => {
    const rules = compileRules(parseRuleList('shop.customers.email, *.*.ssn').rules)
    const { suggestions, more } = suggestFromOutline(tables, rules)
    expect(more).toBe(false)
    expect(suggestions.map((s) => `${s.table}.${s.column}:${s.reason}`)).toEqual([
      'customers.first_name:name',
      'customers.LastName:name',
      'customers.phone_number:phone',
      'customers.dob:birth',
      'customers.iban:finance',
      'customers.ip_address:network',
      'customers.api_key:secret',
      'orders.street:address',
    ])
  })
  it('does not flag harmless names and caps the list', () => {
    const plain = suggestFromOutline([{ db: 'd', table: 't', columns: ['id', 'total', 'description', 'status', 'mailbox_count_total', 'tele'].map((name) => ({ name, type: 'int' })) }], compileRules([]))
    expect(plain.suggestions).toEqual([])
    const many = Array.from({ length: SUGGESTION_LIMIT + 20 }, (_, i) => ({ name: `email_${i}`, type: 'varchar' }))
    const capped = suggestFromOutline([{ db: 'd', table: 't', columns: many }], compileRules([]))
    expect(capped.suggestions).toHaveLength(SUGGESTION_LIMIT)
    expect(capped.more).toBe(true)
  })
})
