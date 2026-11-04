/**
 * The assistant service (SPEC/34 FR-AST-001, 003, 004, 015, 018, 020): conversations of one user on one target, started and
 * answered in the background, polled by the browser. Plain functions over injected dependencies, so tests pass fakes; the
 * server functions are in `assistant.functions.ts` and the runtime wiring in `assistant-runtime.ts`.
 *
 * Turns run in the background and the page polls: a turn can take several model calls and a long statement, longer than a
 * proxy keeps one request open. The log of a live conversation (with the real rows for the screen) is memory only and
 * capped; the store keeps text, SQL in tokenized form, outcomes and row counts, never rows (SPEC/34 Q4).
 */
import { randomBytes } from 'node:crypto'
import type { TargetPool } from '../db/target-pool'
import type { SqlRunEnv } from '../sql/run'
import { serverInfoOf } from '../sql/run'
import { inspectForAssistant, runForAssistant } from '../sql/assistant'
import { StructureRefusal } from '../structure/errors'
import type { TargetKey } from '../target'
import type { ApprovalStore, RateLimiter } from './approval'
import type { AiClient } from './client'
import { effectiveMode, resolveAvailability, type AssistantEnv, type AssistantSettings, type Availability } from './config'
import { createEngineState, resolveCall, sendMessage, stopTurn, type AuditName, type EngineDeps, type EngineState, type TurnEvent, type TurnOutcome } from './orchestrator'
import { createNameHider } from './pii/names'
import { compileRules, mergeRules, parseRule, type CompiledRules } from './pii/rules'
import type { SchemaLookup } from './pii/taint'
import { schemaKey, type SchemaSource } from './schema-source'
import { ALL_TARGETS, type AssistantMode, type AssistantStore, type StoredMessage } from './store'
import { suggestFromOutline, type Suggestion } from './suggest'
import { buildOutline } from './tools'

export type AssistantSession = {
  /** Scope key of the session's registries (`idHash` of the target session). */
  scopeKey: string
  /** The real session id hash: approvals are bound to it. */
  sessionId: string
  /** The one owner key of per-user data (`u:<user id>`, target owner or session hash). */
  ownerKey: string
  /** Account mode: the user the conversations are stored for; null keeps them in memory only. */
  userId: string | null
  target: TargetKey
  pool: TargetPool
  readOnly: boolean
}

export type ServiceDeps = {
  env: () => AssistantEnv
  settings: () => AssistantSettings
  /** Undefined in stateless mode: conversations then live in memory only. */
  store: () => AssistantStore | undefined
  schema: SchemaSource
  sqlEnv: (s: AssistantSession, signal: AbortSignal) => SqlRunEnv
  createClient: (env: AssistantEnv) => AiClient
  /** Throws when a required row cannot be written. */
  audit: (event: AuditName, fields: Record<string, unknown>) => void
  approvals: ApprovalStore
  rateLimit: RateLimiter
  productOf?: (pool: TargetPool) => Promise<'mysql' | 'mariadb'>
  /** Test seams: the SQL hook. Default: the real one over the session's pool. */
  inspect?: (env: SqlRunEnv, sql: string) => ReturnType<typeof inspectForAssistant>
  run?: (env: SqlRunEnv, req: Parameters<typeof runForAssistant>[1]) => ReturnType<typeof runForAssistant>
  now?: () => number
  newId?: () => string
}

export type Summary = { id: string; title: string; mode: AssistantMode; updatedAt: number; live: boolean }
export type Status = {
  available: boolean
  reason?: Exclude<Availability, { available: true }>['reason']
  autoAllowed: boolean
  hideNames: boolean
  model: string | null
  /** No markings and no acknowledgement for the target: results reach the AI as column names and row counts only. */
  piiUnconfigured: boolean
}

export type ScreenEvent = TurnEvent | { type: 'user'; text: string }
export type RunStatus = 'idle' | 'running' | 'awaiting_approval'
export type Poll = { events: ScreenEvent[]; next: number; status: RunStatus; mode: AssistantMode }
export type DisplayItem = ScreenEvent | { type: 'tool'; label: string; sql: string | null; outcome: string | null; rowCount: number | null }
export type Opened = { summary: Summary; items: DisplayItem[]; next: number; status: RunStatus; mode: AssistantMode }

type Live = {
  id: string
  ownerKey: string
  userId: string | null
  targetKey: string
  state: EngineState
  title: string
  stored: boolean
  log: ScreenEvent[]
  base: number
  status: RunStatus
  abort?: AbortController
  turn?: Promise<void>
  createdAt: number
  lastUsed: number
}

export const MESSAGE_MAX = 8000
export const LOG_MAX = 400
export const LIVE_PER_OWNER = 20
export const LIVE_IDLE_MS = 2 * 3_600_000
const DEFAULT_TITLE = 'New conversation'

const refuse = (code: string, message: string): never => {
  throw new StructureRefusal(code, message)
}

export const targetKeyOf = (t: TargetKey): string => `${t.host}${t.zone ?? ''}:${t.port}`

export function createAssistantService(deps: ServiceDeps) {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `cv_${randomBytes(8).toString('hex')}`)
  const live = new Map<string, Live>()

  const sweepIdle = () => {
    const cutoff = now() - LIVE_IDLE_MS
    for (const [id, l] of live) {
      if (l.status === 'idle' && l.lastUsed < cutoff) {
        deps.approvals.clearConversation(id)
        live.delete(id)
      }
    }
  }

  const storeFor = (userId: string | null): AssistantStore | undefined => (userId ? deps.store() : undefined)

  const own = (s: AssistantSession, id: string): Live => {
    const l = live.get(id)
    if (!l || l.ownerKey !== s.ownerKey) return refuse('assistant_not_found', 'This conversation does not exist.')
    if (l.targetKey !== targetKeyOf(s.target)) return refuse('assistant_wrong_target', 'This conversation belongs to another database connection.')
    return l
  }

  const available = (): Extract<Availability, { available: true }> => {
    const a = resolveAvailability(deps.env(), deps.settings())
    if (!a.available) return refuse('assistant_unavailable', 'The assistant is not available.')
    return a
  }

  // ---- Rules --------------------------------------------------------------------------------------------------

  const rulesFor = (s: AssistantSession): { rules: CompiledRules; unconfigured: boolean } => {
    const store = deps.store()
    const targetKey = targetKeyOf(s.target)
    const stored = (store?.listPiiRules(targetKey) ?? []).flatMap((r) => {
      const p = parseRule(r.rule)
      return p ? [p] : []
    })
    const rules = compileRules(mergeRules(deps.env().piiColumns, stored))
    const acknowledged = !!(store?.getPiiAck(targetKey) ?? store?.getPiiAck(ALL_TARGETS))
    return { rules, unconfigured: rules.count === 0 && !acknowledged }
  }

  // ---- Engine dependencies (rebuilt per request: the pool and the session belong to the caller) -------------------

  const engineDeps = async (l: Live, s: AssistantSession, signal: AbortSignal): Promise<EngineDeps> => {
    const a = available()
    const env = deps.env()
    const sqlEnv = deps.sqlEnv(s, signal)
    const product = deps.productOf ? await deps.productOf(s.pool) : (await serverInfoOf(s.pool)).product
    const client = deps.createClient(env)
    const current = () => rulesFor(s)
    return {
      chat: (req, sig) => client.chat(req, sig),
      model: a.model,
      product,
      maxSteps: a.maxSteps,
      maxRows: a.maxRows,
      autoAllowed: () => deps.settings().assistantAutoAllowed,
      hideNames: () => deps.settings().assistantHidePiiNames,
      rules: () => current().rules,
      unconfigured: () => current().unconfigured,
      loadSchema: async (db, refs): Promise<SchemaLookup> => {
        const pairs = refs.flatMap((r) => {
          const d = r.db ?? db
          return d ? [{ db: d, table: r.table }] : []
        })
        let found = new Map<string, { columns: { name: string; type: string }[]; view: boolean }>()
        try {
          if (pairs.length > 0) found = await deps.schema.columns(s.pool, pairs)
        } catch {
          // an unreadable schema leaves the tables opaque: columns are then read by name against the markings
        }
        return (d, table) => (d ? found.get(schemaKey(d, table)) : undefined)
      },
      describeTables: async (db, tables) => {
        const found = await deps.schema.columns(s.pool, tables.map((table) => ({ db, table })))
        return tables.map((table) => {
          const hit = found.get(schemaKey(db, table))
          return { table, found: !!hit, ...(hit?.view ? { view: true } : {}), columns: hit?.columns ?? [] }
        })
      },
      inspect: (sql) => (deps.inspect ?? inspectForAssistant)(sqlEnv, sql),
      run: (sql, db, approvedWrite) => (deps.run ?? runForAssistant)(sqlEnv, { ...(db ? { db } : {}), text: sql, conversationId: l.id, approvedWrite, maxRows: a.maxRows }),
      audit: deps.audit,
      approvals: deps.approvals,
      rateLimit: deps.rateLimit,
      now,
    }
  }

  // ---- Log and persistence ------------------------------------------------------------------------------------

  const push = (l: Live, e: ScreenEvent) => {
    l.log.push(e)
    if (l.log.length > LOG_MAX) {
      const drop = l.log.length - LOG_MAX
      l.log.splice(0, drop)
      l.base += drop
    }
  }

  /** The screen sees the real value where the model wrote a token. */
  const forScreen = (l: Live, e: TurnEvent): ScreenEvent => (e.type === 'assistant' ? { ...e, text: l.state.tokens.revealText(e.text) } : e)

  const persistEvent = (l: Live, e: TurnEvent) => {
    const store = storeFor(l.userId)
    if (!store || !l.stored || !l.userId) return
    try {
      switch (e.type) {
        case 'assistant':
          store.addMessage(l.userId, l.id, { role: 'assistant', content: e.text })
          break
        case 'step':
          store.addMessage(l.userId, l.id, { role: 'tool', content: `describe ${e.db}.${e.tables.join(', ')}`, outcome: 'ok' })
          break
        case 'result':
          store.addMessage(l.userId, l.id, {
            role: 'tool',
            content: 'run_query',
            sql: e.sqlModel,
            outcome: e.ok ? 'ok' : 'failed',
            rowCount: e.ok ? (e.result.affectedRows ?? e.result.rowCount) : null,
          })
          break
        case 'refused':
          store.addMessage(l.userId, l.id, { role: 'tool', content: 'run_query', outcome: `refused: ${e.code}` })
          break
        case 'denied':
          store.addMessage(l.userId, l.id, { role: 'tool', content: 'run_query', outcome: `declined: ${e.reason}` })
          break
        default:
          break
      }
    } catch {
      // the conversation goes on in memory when the store cannot take a row
    }
  }

  const absorb = (l: Live, events: TurnEvent[]) => {
    for (const e of events) {
      push(l, forScreen(l, e))
      persistEvent(l, e)
    }
  }

  const runInBackground = (l: Live, s: AssistantSession, fn: (d: EngineDeps, signal: AbortSignal) => Promise<TurnOutcome>) => {
    l.status = 'running'
    const controller = new AbortController()
    l.abort = controller
    l.turn = (async () => {
      try {
        const d = await engineDeps(l, s, controller.signal)
        const outcome = await fn(d, controller.signal)
        absorb(l, outcome.events)
        // a refused answer (wrong session, stale statement) leaves the call waiting
        l.status = outcome.status === 'awaiting_approval' || l.state.awaiting ? 'awaiting_approval' : 'idle'
      } catch {
        absorb(l, [{ type: 'error', code: 'ai', message: 'The assistant failed unexpectedly.' }])
        l.status = 'idle'
      } finally {
        l.turn = undefined
        l.abort = undefined
        l.lastUsed = now()
      }
    })()
  }

  // ---- Conversations ------------------------------------------------------------------------------------------

  const summaryOf = (l: Live): Summary => ({ id: l.id, title: l.title, mode: l.state.mode, updatedAt: l.lastUsed, live: true })

  const makeLive = async (s: AssistantSession, id: string, init: { title: string; mode: AssistantMode; stored: boolean; createdAt: number }): Promise<Live> => {
    const { rules } = rulesFor(s)
    const hider = createNameHider()
    const hide = deps.settings().assistantHidePiiNames
    let tables = await deps.schema.outline(s.pool).catch(() => [])
    if (hide) {
      tables = tables.map((t) => ({
        ...t,
        columns: t.columns.map((c) => (rules.isPiiColumn(t.db, t.table, c.name) ? { ...c, name: hider.register({ db: t.db, table: t.table, column: c.name }) } : c)),
      }))
    }
    const state = createEngineState({ id, userId: s.ownerKey, sessionId: s.sessionId, targetKey: targetKeyOf(s.target), mode: init.mode, outline: buildOutline(tables), hider })
    return { id, ownerKey: s.ownerKey, userId: s.userId, targetKey: targetKeyOf(s.target), state, title: init.title, stored: init.stored, log: [], base: 0, status: 'idle', createdAt: init.createdAt, lastUsed: init.createdAt }
  }

  const evictFor = (ownerKey: string) => {
    const mine = [...live.values()].filter((l) => l.ownerKey === ownerKey && l.status === 'idle').sort((a, b) => a.lastUsed - b.lastUsed)
    const all = [...live.values()].filter((l) => l.ownerKey === ownerKey).length
    for (let i = 0; i < mine.length && all - i >= LIVE_PER_OWNER; i++) {
      deps.approvals.clearConversation(mine[i]!.id)
      live.delete(mine[i]!.id)
    }
  }

  return {
    status(s: AssistantSession): Status {
      const a = resolveAvailability(deps.env(), deps.settings())
      const { unconfigured } = rulesFor(s)
      return a.available
        ? { available: true, autoAllowed: a.autoAllowed, hideNames: a.hideNames, model: a.model, piiUnconfigured: unconfigured }
        : { available: false, reason: a.reason, autoAllowed: false, hideNames: false, model: null, piiUnconfigured: unconfigured }
    },

    async create(s: AssistantSession): Promise<Summary> {
      available()
      sweepIdle()
      evictFor(s.ownerKey)
      const id = newId()
      const at = now()
      const store = storeFor(s.userId)
      const l = await makeLive(s, id, { title: DEFAULT_TITLE, mode: 'manual', stored: !!store, createdAt: at })
      if (store && s.userId) store.createConversation({ id, userId: s.userId, targetKey: l.targetKey, title: DEFAULT_TITLE, mode: 'manual', at })
      live.set(id, l)
      return summaryOf(l)
    },

    list(s: AssistantSession): Summary[] {
      sweepIdle()
      const targetKey = targetKeyOf(s.target)
      const store = storeFor(s.userId)
      const out = new Map<string, Summary>()
      for (const c of store && s.userId ? store.listConversations(s.userId, { targetKey }) : []) out.set(c.id, { id: c.id, title: c.title, mode: c.mode, updatedAt: c.updatedAt, live: live.has(c.id) })
      for (const l of live.values()) if (l.ownerKey === s.ownerKey && l.targetKey === targetKey) out.set(l.id, summaryOf(l))
      return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    },

    /** A live conversation shows its screen log; a stored one is brought back from the store (text, no rows, no tokens). */
    async open(s: AssistantSession, id: string): Promise<Opened> {
      let l = live.get(id)
      if (l) l = own(s, id)
      if (!l) {
        const store = storeFor(s.userId)
        const c = store && s.userId ? store.getConversation(s.userId, id) : undefined
        if (!c || !store || !s.userId) return refuse('assistant_not_found', 'This conversation does not exist.')
        if (c.targetKey !== targetKeyOf(s.target)) return refuse('assistant_wrong_target', 'This conversation belongs to another database connection.')
        available()
        evictFor(s.ownerKey)
        l = await makeLive(s, id, { title: c.title, mode: c.mode, stored: true, createdAt: c.createdAt })
        const messages: StoredMessage[] = store.listMessages(s.userId, id)
        // The model gets the text of the conversation back; tool calls and their rows are gone (the tokens of the old map too).
        for (const m of messages) if (m.role === 'user' || m.role === 'assistant') l.state.messages.push({ role: m.role, content: m.content })
        for (const m of messages) {
          if (m.role === 'user') l.log.push({ type: 'user', text: m.content })
          else if (m.role === 'assistant') l.log.push({ type: 'assistant', text: m.content })
          else l.log.push({ type: 'tool', label: m.content, sql: m.sql, outcome: m.outcome, rowCount: m.rowCount } as unknown as ScreenEvent)
        }
        l.lastUsed = c.updatedAt
        live.set(id, l)
      }
      return { summary: summaryOf(l), items: [...l.log] as DisplayItem[], next: l.base + l.log.length, status: l.status, mode: l.state.mode }
    },

    async send(s: AssistantSession, id: string, text: string): Promise<{ next: number }> {
      available()
      const l = own(s, id)
      const body = text.trim()
      if (body === '') return refuse('assistant_empty', 'Write a message first.')
      if (body.length > MESSAGE_MAX) return refuse('assistant_message_too_long', `A message may have at most ${MESSAGE_MAX} characters.`)
      if (l.status !== 'idle') return refuse('assistant_busy', 'The assistant is still working on the previous message.')
      const store = storeFor(l.userId)
      push(l, { type: 'user', text: body })
      if (store && l.stored && l.userId) {
        try {
          store.addMessage(l.userId, l.id, { role: 'user', content: body })
          if (l.title === DEFAULT_TITLE) {
            l.title = body.replace(/\s+/g, ' ').slice(0, 60)
            store.updateConversation(l.userId, l.id, { title: l.title })
          }
        } catch {
          // memory only from here on
        }
      } else if (l.title === DEFAULT_TITLE) l.title = body.replace(/\s+/g, ' ').slice(0, 60)
      l.lastUsed = now()
      runInBackground(l, s, (d, signal) => sendMessage(l.state, d, body, signal))
      return { next: l.base + l.log.length }
    },

    poll(s: AssistantSession, id: string, after: number): Poll {
      const l = own(s, id)
      const from = Math.max(0, after - l.base)
      return { events: l.log.slice(from), next: l.base + l.log.length, status: l.status, mode: l.state.mode }
    },

    async resolve(s: AssistantSession, id: string, callId: string, decision: 'approve' | 'deny'): Promise<{ next: number }> {
      available()
      const l = own(s, id)
      if (l.status !== 'awaiting_approval') return refuse('assistant_not_waiting', 'No call is waiting for approval.')
      l.lastUsed = now()
      runInBackground(l, s, (d, signal) => resolveCall(l.state, d, callId, decision, { userId: s.ownerKey, sessionId: s.sessionId }, signal))
      return { next: l.base + l.log.length }
    },

    setMode(s: AssistantSession, id: string, mode: AssistantMode): { mode: AssistantMode } {
      const a = available()
      const l = own(s, id)
      if (l.status === 'running') return refuse('assistant_busy', 'Wait for the assistant to finish first.')
      if (mode === 'auto' && !a.autoAllowed) return refuse('assistant_auto_not_allowed', 'The administrators have not allowed auto mode.')
      const next = effectiveMode(mode, a.autoAllowed)
      if (next === l.state.mode) return { mode: next }
      deps.audit('assistant.mode', { conversationId: l.id, userId: s.ownerKey, from: l.state.mode, to: next })
      l.state.mode = next
      const store = storeFor(l.userId)
      if (store && l.stored && l.userId) {
        try {
          store.updateConversation(l.userId, l.id, { mode: next })
        } catch {
          // the mode is held in memory
        }
      }
      return { mode: next }
    },

    stop(s: AssistantSession, id: string): { next: number } {
      const l = own(s, id)
      l.abort?.abort()
      absorb(l, stopTurn(l.state, deps))
      if (l.status === 'awaiting_approval') l.status = 'idle'
      return { next: l.base + l.log.length }
    },

    rename(s: AssistantSession, id: string, title: string): Summary {
      const l = own(s, id)
      const t = title.replace(/\s+/g, ' ').trim().slice(0, 80)
      if (t === '') return refuse('assistant_empty', 'A title cannot be empty.')
      l.title = t
      const store = storeFor(l.userId)
      if (store && l.stored && l.userId) store.updateConversation(l.userId, l.id, { title: t })
      return summaryOf(l)
    },

    delete(s: AssistantSession, id: string): { ok: true } {
      const l = live.get(id)
      if (l) own(s, id)
      l?.abort?.abort()
      deps.approvals.clearConversation(id)
      live.delete(id)
      const store = storeFor(s.userId)
      if (store && s.userId) store.deleteConversation(s.userId, id)
      else if (!l) return refuse('assistant_not_found', 'This conversation does not exist.')
      return { ok: true }
    },

    /** Retention: conversations not touched since `before` leave the store and memory. */
    purge(before: number): number {
      let n = deps.store()?.purgeConversations(before) ?? 0
      for (const [id, l] of live) {
        if (l.status === 'idle' && l.lastUsed < before) {
          deps.approvals.clearConversation(id)
          live.delete(id)
          n++
        }
      }
      return n
    },

    /** Columns of the connected target that look like personal data and are not marked yet. The administrator picks; nothing is applied. */
    async suggest(s: AssistantSession): Promise<{ suggestions: Suggestion[]; more: boolean }> {
      const tables = await deps.schema.outline(s.pool)
      return suggestFromOutline(tables, rulesFor(s).rules)
    },

    /** Test hook: waits for the running turn of a conversation. */
    async settled(id: string): Promise<void> {
      await live.get(id)?.turn
    },
    liveCount: () => live.size,
  }
}

export type AssistantService = ReturnType<typeof createAssistantService>

export function assistantSessionOf(
  session: { idHash: string; sessionIdHash?: string; target: TargetKey; pool: TargetPool; readOnly: boolean; ownerKey?: string; user?: { id: string } | null },
  ownerKey: string,
): AssistantSession {
  return {
    scopeKey: session.idHash,
    sessionId: session.sessionIdHash ?? session.idHash,
    ownerKey,
    userId: session.user?.id ?? null,
    target: session.target,
    pool: session.pool,
    readOnly: session.readOnly,
  }
}
