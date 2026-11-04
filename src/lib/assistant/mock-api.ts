/**
 * In-memory assistant for the mock layer (SPEC/34 task 5): a scripted conversation partner so the sidebar can be built and
 * tested without a server, a model or a database. Keywords in the user's message choose the scenario:
 *   "customers"  a SELECT with an email column: asks (manual) or runs (auto), real rows on screen, an answer with a value;
 *   "update"     an UPDATE: always asks, also in auto mode;
 *   "delete"     refused, for the SQL tab;
 *   "like"       refused as an inference attempt;
 *   "slow"       keeps running until it is stopped;
 *   "fail"       the AI service fails;
 *   anything else is answered with a short text.
 * Flags in this tab's session storage (`dbloom.authMock.flags`): `assistant-off`, `assistant-auto-off`, `assistant-unconfigured`.
 * Turn timing is short (a few hundred ms) so the polling path is exercised.
 */
import type { Opened, Poll, Status, Summary } from '~/server/assistant/service'
import type { ScreenEvent } from '~/server/assistant/service'
import type { AssistantMode } from '~/server/assistant/store'
import type { AssistantApi } from './api'

type Conv = { id: string; title: string; mode: AssistantMode; log: ScreenEvent[]; status: Poll['status']; updatedAt: number; timer?: ReturnType<typeof setTimeout> }

const STEP_MS = 350
const EMAIL = 'anna.meyer@example.com'
const SELECT_SQL = 'SELECT id, email, city FROM customers LIMIT 3'
const ROWS = [
  ['1', EMAIL, 'Paris'],
  ['2', 'ben.lopez@example.com', 'Berlin'],
  ['3', EMAIL, 'Rome'],
]
const UPDATE_SQL = "UPDATE customers SET city = 'Oslo' WHERE id = 1"

const flag = (name: string): boolean => {
  try {
    return (window.sessionStorage.getItem('dbloom.authMock.flags') ?? '').split(',').includes(name)
  } catch {
    return false
  }
}

const failure = (code: string, message: string) => new Error(`${code}: ${message}`)

export function createMockAssistantApi(): AssistantApi {
  const convs = new Map<string, Conv>()
  let seq = 0
  let call = 0

  const own = (id: string): Conv => {
    const c = convs.get(id)
    if (!c) throw failure('assistant_not_found', 'This conversation does not exist.')
    return c
  }
  const summary = (c: Conv): Summary => ({ id: c.id, title: c.title, mode: c.mode, updatedAt: c.updatedAt, live: true })
  const later = (c: Conv, fn: () => void, ms = STEP_MS) => {
    clearTimeout(c.timer)
    c.timer = setTimeout(() => {
      c.timer = undefined
      fn()
      c.updatedAt = Date.now()
    }, ms)
  }
  const callId = () => `call_${++call}`

  const resultEvent = (id: string, sql: string): ScreenEvent => ({
    type: 'result',
    callId: id,
    sql,
    sqlModel: sql.replace(EMAIL, '<email:ab12:1>'),
    db: 'shop',
    ok: true,
    result: {
      columns: [{ name: 'id', type: 'int' }, { name: 'email', type: 'varchar(120)' }, { name: 'city', type: 'varchar(40)' }],
      rows: ROWS,
      rowCount: ROWS.length,
      truncated: false,
      durationMs: 4,
    },
    modelSaw: 'rows',
    anonymizedColumns: ['email'],
  })

  const startTurn = (c: Conv, text: string) => {
    const t = text.toLowerCase()
    c.status = 'running'
    if (t.includes('slow')) return // runs until stop
    if (t.includes('fail')) {
      later(c, () => {
        c.log.push({ type: 'error', code: 'ai', message: 'The AI service could not be reached.', detail: 'unreachable' })
        c.status = 'idle'
      })
      return
    }
    if (t.includes('delete')) {
      later(c, () => {
        c.log.push({ type: 'refused', callId: callId(), code: 'user-only', message: 'This statement cannot be run by the assistant. Only one SELECT, INSERT or UPDATE (with a restricting WHERE) per call is allowed; the user can run anything else in an SQL tab.', sql: 'DELETE FROM customers WHERE id = 1', db: 'shop' })
        c.log.push({ type: 'assistant', text: 'I cannot delete rows. You can run that statement in an SQL tab.' })
        c.status = 'idle'
      })
      return
    }
    if (t.includes('like')) {
      later(c, () => {
        c.log.push({ type: 'refused', callId: callId(), code: 'inference', message: 'This statement uses a column with personal data in a way that could reveal its values (a comparison other than equality with a token, a function or a range). Rewrite it without that, or ask the user to run it in an SQL tab.' })
        c.log.push({ type: 'assistant', text: 'I cannot search inside personal data. Ask me for a count instead.' })
        c.status = 'idle'
      })
      return
    }
    if (t.includes('update')) {
      later(c, () => {
        const id = callId()
        c.log.push({ type: 'approval', callId: id, sql: UPDATE_SQL, sqlModel: UPDATE_SQL, db: 'shop', access: 'write', purpose: 'Move customer 1 to Oslo.', metadataOnly: false, expiresAt: Date.now() + 10 * 60_000 })
        c.status = 'awaiting_approval'
      })
      return
    }
    if (t.includes('customers')) {
      later(c, () => {
        const id = callId()
        if (c.mode === 'auto') {
          c.log.push(resultEvent(id, SELECT_SQL))
          c.log.push({ type: 'assistant', text: `The first customer is **${EMAIL}** in Paris.` })
          c.status = 'idle'
          return
        }
        c.log.push({ type: 'approval', callId: id, sql: SELECT_SQL, sqlModel: SELECT_SQL, db: 'shop', access: 'read', purpose: 'List three customers with their city.', metadataOnly: false, expiresAt: Date.now() + 10 * 60_000 })
        c.status = 'awaiting_approval'
      })
      return
    }
    later(c, () => {
      c.log.push({ type: 'assistant', text: 'I can look into your data. Ask for example about your **customers**.' })
      c.status = 'idle'
    })
  }

  return {
    async status(): Promise<Status> {
      if (flag('assistant-off')) return { available: false, reason: 'no-endpoint', autoAllowed: false, hideNames: false, model: null, piiUnconfigured: false }
      return { available: true, autoAllowed: !flag('assistant-auto-off'), hideNames: false, model: 'mock-model', piiUnconfigured: flag('assistant-unconfigured') }
    },
    async list() {
      return [...convs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary)
    },
    async create() {
      const c: Conv = { id: `cv_mock${++seq}`, title: 'New conversation', mode: 'manual', log: [], status: 'idle', updatedAt: Date.now() }
      convs.set(c.id, c)
      return summary(c)
    },
    async open(id): Promise<Opened> {
      const c = own(id)
      return { summary: summary(c), items: [...c.log], next: c.log.length, status: c.status, mode: c.mode }
    },
    async send(id, text) {
      const c = own(id)
      if (c.status !== 'idle') throw failure('assistant_busy', 'The assistant is still working on the previous message.')
      if (c.title === 'New conversation') c.title = text.slice(0, 60)
      c.log.push({ type: 'user', text })
      startTurn(c, text)
      return { next: c.log.length }
    },
    async poll(id, after): Promise<Poll> {
      const c = own(id)
      return { events: c.log.slice(after), next: c.log.length, status: c.status, mode: c.mode }
    },
    async resolve(id, callIdArg, decision) {
      const c = own(id)
      if (c.status !== 'awaiting_approval') throw failure('assistant_not_waiting', 'No call is waiting for approval.')
      const approval = [...c.log].reverse().find((e) => e.type === 'approval' && e.callId === callIdArg)
      if (!approval || approval.type !== 'approval') throw failure('assistant_not_waiting', 'No call is waiting for approval.')
      c.status = 'running'
      later(c, () => {
        if (decision === 'deny') {
          c.log.push({ type: 'denied', callId: callIdArg, reason: 'user' })
          c.log.push({ type: 'assistant', text: 'Understood, I did not run it.' })
        } else if (approval.access === 'write') {
          c.log.push({ type: 'result', callId: callIdArg, sql: approval.sql, sqlModel: approval.sqlModel, db: 'shop', ok: true, result: { columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: 1, durationMs: 3 }, modelSaw: 'affected', anonymizedColumns: [] })
          c.log.push({ type: 'assistant', text: 'Done: one row was updated.' })
        } else {
          c.log.push(resultEvent(callIdArg, approval.sql))
          c.log.push({ type: 'assistant', text: `The first customer is **${EMAIL}** in Paris.` })
        }
        c.status = 'idle'
      })
      return { next: c.log.length }
    },
    async setMode(id, mode) {
      const c = own(id)
      if (c.status === 'running') throw failure('assistant_busy', 'Wait for the assistant to finish first.')
      if (mode === 'auto' && flag('assistant-auto-off')) throw failure('assistant_auto_not_allowed', 'The administrators have not allowed auto mode.')
      c.mode = mode
      return { mode }
    },
    async stop(id) {
      const c = own(id)
      clearTimeout(c.timer)
      c.timer = undefined
      if (c.status === 'awaiting_approval') {
        const approval = [...c.log].reverse().find((e) => e.type === 'approval')
        if (approval && approval.type === 'approval') c.log.push({ type: 'denied', callId: approval.callId, reason: 'stopped' })
      }
      c.status = 'idle'
      return { next: c.log.length }
    },
    async rename(id, title) {
      const c = own(id)
      c.title = title.trim().slice(0, 80) || c.title
      return summary(c)
    },
    async remove(id) {
      own(id)
      convs.delete(id)
      return { ok: true as const }
    },
  }
}
