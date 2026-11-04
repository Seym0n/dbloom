/**
 * Mock of the assistant administrator functions (SPEC/34 task 6): the markings of PII columns, the acknowledgements, the
 * endpoint status and the suggestions. State lives in this tab's session storage. Flags (`dbloom.authMock.flags`):
 * `assistant-off` (no endpoint), `stateless` (nothing can be kept), `assistant-audit-fail` (every change answers
 * `audit_unavailable`), `assistant-suggest-empty` (no suggestions).
 */
import type { AckView, AdminAnswer, AdminOverview, RuleView } from '~/server/assistant/admin-service'
import { parseRule, ruleText } from '~/server/assistant/pii/rules'
import type { Suggestion } from '~/server/assistant/suggest'
import type { AuthApi } from './api'

const KEY = 'dbloom.authMock.assistantAdmin'
type State = { seq: number; rules: RuleView[]; acks: AckView[] }

const read = (): State => {
  try {
    return { seq: 0, rules: [], acks: [], ...(JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}') as Partial<State>) }
  } catch {
    return { seq: 0, rules: [], acks: [] }
  }
}
const write = (s: State) => {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* in-memory only */
  }
}

type Deps = { flag: (name: string) => boolean; wait: <T>(v: T) => Promise<T>; needStepUp: () => void; who: () => string }
const TARGET_OK = /^[^\s|]{1,200}$/

const SUGGESTIONS: Suggestion[] = [
  { db: 'shop', table: 'customers', column: 'first_name', reason: 'name' },
  { db: 'shop', table: 'customers', column: 'last_name', reason: 'name' },
  { db: 'shop', table: 'customers', column: 'phone', reason: 'phone' },
  { db: 'shop', table: 'orders', column: 'shipping_address', reason: 'address' },
]

export function createMockAssistantAdmin(d: Deps): Pick<AuthApi, 'getAssistantAdmin' | 'addPiiRule' | 'removePiiRule' | 'setPiiAck' | 'clearPiiAck' | 'suggestPiiColumns'> {
  const stored = () => !d.flag('stateless')
  const failAudit = () => d.flag('assistant-audit-fail')
  return {
    getAssistantAdmin: () =>
      d.wait<AdminOverview>({
        stored: stored(),
        endpoint: d.flag('assistant-off')
          ? { configured: false, origin: null, keySet: false, allowPrivate: false, problems: [] }
          : { configured: true, origin: 'https://ai.example.com', keySet: true, allowPrivate: false, problems: d.flag('assistant-endpoint-problem') ? ['DBLOOM_AI_MAX_ROWS is not a whole number; 50 is used'] : [] },
        envRules: ['*.*.ssn'],
        rules: stored() ? read().rules : [],
        acks: stored() ? read().acks : [],
      }),

    addPiiRule: async (input): Promise<AdminAnswer<{ rule: RuleView; created: boolean }>> => {
      d.needStepUp()
      if (!stored()) return d.wait({ ok: false, error: 'unavailable' })
      const parsed = parseRule(input.rule)
      if (!parsed) return d.wait({ ok: false, error: 'bad_rule' })
      if (input.targetKey !== '' && !TARGET_OK.test(input.targetKey)) return d.wait({ ok: false, error: 'bad_target' })
      if (failAudit()) return d.wait({ ok: false, error: 'audit_unavailable' })
      const s = read()
      const text = ruleText(parsed)
      const hit = s.rules.find((r) => r.targetKey === input.targetKey && r.rule === text)
      if (hit) return d.wait({ ok: true, rule: hit, created: false })
      const rule: RuleView = { id: ++s.seq, targetKey: input.targetKey, rule: text, createdAt: Date.now(), createdBy: d.who() }
      s.rules.push(rule)
      write(s)
      return d.wait({ ok: true, rule, created: true })
    },

    removePiiRule: async (id): Promise<AdminAnswer<{ removed: RuleView }>> => {
      d.needStepUp()
      if (!stored()) return d.wait({ ok: false, error: 'unavailable' })
      const s = read()
      const row = s.rules.find((r) => r.id === id)
      if (!row) return d.wait({ ok: false, error: 'not_found' })
      if (failAudit()) return d.wait({ ok: false, error: 'audit_unavailable' })
      s.rules = s.rules.filter((r) => r.id !== id)
      write(s)
      return d.wait({ ok: true, removed: row })
    },

    setPiiAck: async (targetKey): Promise<AdminAnswer<{ ack: AckView }>> => {
      d.needStepUp()
      if (!stored()) return d.wait({ ok: false, error: 'unavailable' })
      if (targetKey !== '' && !TARGET_OK.test(targetKey)) return d.wait({ ok: false, error: 'bad_target' })
      if (failAudit()) return d.wait({ ok: false, error: 'audit_unavailable' })
      const s = read()
      const ack: AckView = { targetKey, acknowledgedAt: Date.now(), acknowledgedBy: d.who() }
      s.acks = [...s.acks.filter((a) => a.targetKey !== targetKey), ack]
      write(s)
      return d.wait({ ok: true, ack })
    },

    clearPiiAck: async (targetKey): Promise<AdminAnswer<{ cleared: boolean }>> => {
      d.needStepUp()
      if (!stored()) return d.wait({ ok: false, error: 'unavailable' })
      const s = read()
      if (!s.acks.some((a) => a.targetKey === targetKey)) return d.wait({ ok: false, error: 'not_found' })
      if (failAudit()) return d.wait({ ok: false, error: 'audit_unavailable' })
      s.acks = s.acks.filter((a) => a.targetKey !== targetKey)
      write(s)
      return d.wait({ ok: true, cleared: true })
    },

    suggestPiiColumns: () => {
      const marked = new Set(read().rules.map((r) => r.rule))
      const list = d.flag('assistant-suggest-empty') ? [] : SUGGESTIONS.filter((s) => !marked.has(`${s.db}.${s.table}.${s.column}`))
      return d.wait({ suggestions: list, more: false })
    },
  }
}
