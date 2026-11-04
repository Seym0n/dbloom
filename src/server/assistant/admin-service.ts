/**
 * Administrator side of the assistant page (SPEC/34 FR-AST-006, FR-AST-019): the markings of PII columns, the "no PII on
 * this target" acknowledgements and the endpoint status. Reading needs the administrator role; every change also needs a
 * recent second factor (purpose `assistant.rule`) and writes its audit row in the same transaction as the change, so a row
 * that cannot be audited is not changed. A refusal is an answer (`{ ok: false, error }`), like the settings page.
 * The four on/off, model, auto and hide-names settings are edited on the settings page machinery (`setSetting`), not here.
 */
import { AuthError, type AccountContext, type AccountStore, type StepUp } from '../auth/types'
import { describeEndpoint, type AssistantEnv } from './config'
import { parseRule, ruleText, type PiiRule } from './pii/rules'
import { ALL_TARGETS, type AssistantStore, type PiiAck, type PiiRuleRow } from './store'

export const RULE_LIMIT = 500
export const ACK_LIMIT = 100
const TARGET_KEY = /^[^\s|]{1,200}$/

export type AdminRefusal = 'bad_rule' | 'bad_target' | 'too_many' | 'unavailable' | 'audit_unavailable' | 'not_found'
export type AdminAnswer<T> = ({ ok: true } & T) | { ok: false; error: AdminRefusal }

export type RuleView = { id: number; targetKey: string; rule: string; createdAt: number; createdBy: string }
export type AckView = { targetKey: string; acknowledgedAt: number; acknowledgedBy: string }
export type AdminOverview = {
  /** False in stateless mode: there is no store, so nothing can be kept; only the environment list applies. */
  stored: boolean
  endpoint: ReturnType<typeof describeEndpoint>
  envRules: string[]
  rules: RuleView[]
  acks: AckView[]
}

export type AdminServiceDeps = {
  store: () => AssistantStore | undefined
  accounts: Pick<AccountStore, 'getUser'>
  env: () => AssistantEnv
  stepUp: Pick<StepUp, 'requireRecentFactor'>
  mode: () => 'account' | 'direct' | 'setup' | 'stateless'
  /** Runs `fn` in one transaction and returns what it returns; throws what `fn` throws after rolling back. */
  transaction: <T>(fn: () => T) => T
  /** The required audit row inside the open transaction; returns the publisher to call after commit. Throws when it cannot be written. */
  auditIn: (event: 'assistant.rule', fields: Record<string, string | number | boolean>) => () => void
  now?: () => number
}

export type AssistantAdminService = ReturnType<typeof createAssistantAdminService>

export const ASSISTANT_STEP_UP_PURPOSE = 'assistant.rule'

export function createAssistantAdminService(d: AdminServiceDeps) {
  const adminOf = (ctx: AccountContext): string => {
    const actor = ctx.user
    const row = actor ? d.accounts.getUser(actor.id) : undefined
    if (d.mode() !== 'account' || ctx.state !== 'full' || !actor || actor.role !== 'admin' || !row || row.role !== 'admin' || row.status !== 'active') throw new AuthError('auth_failed')
    return actor.id
  }
  const nameOf = (id: string): string => {
    if (id === 'setup' || id === 'cli') return id
    const u = d.accounts.getUser(id)
    return u ? u.displayName || u.username : 'a removed user'
  }
  const ruleView = (r: PiiRuleRow): RuleView => ({ id: r.id, targetKey: r.targetKey, rule: r.rule, createdAt: r.createdAt, createdBy: nameOf(r.createdBy) })
  const ackView = (a: PiiAck): AckView => ({ targetKey: a.targetKey, acknowledgedAt: a.acknowledgedAt, acknowledgedBy: nameOf(a.acknowledgedBy) })
  const targetOk = (t: string) => t === ALL_TARGETS || TARGET_KEY.test(t)
  const audited = <T>(event: 'assistant.rule', fields: Record<string, string | number | boolean>, change: () => T): AdminAnswer<{ value: T }> => {
    let publish: () => void
    let value: T
    try {
      const out = d.transaction(() => {
        const pub = d.auditIn(event, fields)
        return { pub, v: change() }
      })
      publish = out.pub
      value = out.v
    } catch (error) {
      if (error instanceof Error && error.name === 'AuditUnavailable') return { ok: false, error: 'audit_unavailable' }
      throw error
    }
    publish()
    return { ok: true, value }
  }

  return {
    overview(ctx: AccountContext): AdminOverview {
      adminOf(ctx)
      const store = d.store()
      return {
        stored: store !== undefined,
        endpoint: describeEndpoint(d.env()),
        envRules: d.env().piiColumns.map(ruleText),
        rules: (store?.listPiiRules() ?? []).map(ruleView),
        acks: store ? ackList(store) : [],
      }
    },

    addRule(ctx: AccountContext, input: { targetKey: string; rule: string }): AdminAnswer<{ rule: RuleView; created: boolean }> {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'assistant.rule')
      const store = d.store()
      if (!store) return { ok: false, error: 'unavailable' }
      const parsed: PiiRule | undefined = parseRule(input.rule)
      if (!parsed) return { ok: false, error: 'bad_rule' }
      if (!targetOk(input.targetKey)) return { ok: false, error: 'bad_target' }
      const text = ruleText(parsed)
      const known = store.listPiiRules().filter((r) => r.targetKey === input.targetKey)
      if (!known.some((r) => r.rule === text) && store.listPiiRules().length >= RULE_LIMIT) return { ok: false, error: 'too_many' }
      const r = audited('assistant.rule', { actor, op: 'add', target: input.targetKey === ALL_TARGETS ? 'all' : input.targetKey, rule: text }, () => store.addPiiRule(input.targetKey, text, actor))
      return r.ok ? { ok: true, rule: ruleView(r.value.row), created: r.value.created } : r
    },

    removeRule(ctx: AccountContext, id: number): AdminAnswer<{ removed: RuleView }> {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'assistant.rule')
      const store = d.store()
      if (!store) return { ok: false, error: 'unavailable' }
      const row = store.listPiiRules().find((r) => r.id === id)
      if (!row) return { ok: false, error: 'not_found' }
      const r = audited('assistant.rule', { actor, op: 'remove', target: row.targetKey === ALL_TARGETS ? 'all' : row.targetKey, rule: row.rule }, () => store.removePiiRule(id))
      return r.ok ? { ok: true, removed: ruleView(row) } : r
    },

    /** "No personal data on this target": the assistant then works with real values for it. */
    setAck(ctx: AccountContext, input: { targetKey: string }): AdminAnswer<{ ack: AckView }> {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'assistant.rule')
      const store = d.store()
      if (!store) return { ok: false, error: 'unavailable' }
      if (!targetOk(input.targetKey)) return { ok: false, error: 'bad_target' }
      if (!store.getPiiAck(input.targetKey) && ackList(store).length >= ACK_LIMIT) return { ok: false, error: 'too_many' }
      const r = audited('assistant.rule', { actor, op: 'ack', target: input.targetKey === ALL_TARGETS ? 'all' : input.targetKey }, () => {
        store.setPiiAck(input.targetKey, actor)
        return store.getPiiAck(input.targetKey)!
      })
      return r.ok ? { ok: true, ack: ackView(r.value) } : r
    },

    clearAck(ctx: AccountContext, input: { targetKey: string }): AdminAnswer<{ cleared: boolean }> {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, 'assistant.rule')
      const store = d.store()
      if (!store) return { ok: false, error: 'unavailable' }
      if (!store.getPiiAck(input.targetKey)) return { ok: false, error: 'not_found' }
      const r = audited('assistant.rule', { actor, op: 'unack', target: input.targetKey === ALL_TARGETS ? 'all' : input.targetKey }, () => store.clearPiiAck(input.targetKey))
      return r.ok ? { ok: true, cleared: r.value } : r
    },
  }

  function ackList(store: AssistantStore): AckView[] {
    return store.listPiiAcks().map(ackView)
  }
}
