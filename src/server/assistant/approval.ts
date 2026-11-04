/**
 * Approval records and the turn rate limit (SPEC/34 FR-AST-003, FR-AST-005, FR-AST-013). A pending call is a server-side
 * record bound to user, session, conversation, call id and the hash of the exact statement; the browser only ever names
 * the call id and the decision. A record is used once and expires. In memory: a restart drops every pending call, which is
 * the same as denying it. Pure apart from the clock.
 */
import { createHash } from 'node:crypto'

export const APPROVAL_TTL_MS = 10 * 60_000

export type PendingCall = {
  callId: string
  conversationId: string
  userId: string
  sessionId: string
  /** The statement as it will run (tokens replaced by values): what the user sees and approves. */
  sqlReal: string
  /** The statement as the model wrote it (tokenized): what the audit log keeps. */
  sqlModel: string
  db?: string
  access: 'read' | 'write'
  createdAt: number
  expiresAt: number
}

export type ApprovalFailure = 'unknown' | 'expired' | 'wrong_user' | 'wrong_session' | 'wrong_conversation' | 'changed'
export type ApprovalCheck = { userId: string; sessionId: string; conversationId: string }

export const statementHash = (sql: string): string => createHash('sha256').update(sql).digest('hex')

export type ApprovalStore = {
  issue(p: Omit<PendingCall, 'createdAt' | 'expiresAt'>): PendingCall
  get(callId: string): PendingCall | undefined
  /** Takes the record out for good when it fits the caller and the statement; any failure other than "expired" leaves it. */
  consume(callId: string, check: ApprovalCheck & { sqlReal: string }): { ok: true; call: PendingCall } | { ok: false; reason: ApprovalFailure }
  /** Same checks without a statement: a denial. */
  deny(callId: string, check: ApprovalCheck): { ok: true; call: PendingCall } | { ok: false; reason: ApprovalFailure }
  /** Drops every record of a conversation (stop, new message, delete). */
  clearConversation(conversationId: string): number
  forConversation(conversationId: string): PendingCall[]
  size(): number
}

export function createApprovalStore(now: () => number = Date.now, ttlMs = APPROVAL_TTL_MS): ApprovalStore {
  const records = new Map<string, PendingCall & { hash: string }>()
  const sweep = () => {
    const t = now()
    for (const [id, r] of records) if (r.expiresAt <= t) records.delete(id)
  }
  const bound = (callId: string, check: ApprovalCheck): { ok: true; rec: PendingCall & { hash: string } } | { ok: false; reason: ApprovalFailure } => {
    const rec = records.get(callId)
    if (!rec) return { ok: false, reason: 'unknown' }
    if (rec.expiresAt <= now()) {
      records.delete(callId)
      return { ok: false, reason: 'expired' }
    }
    if (rec.userId !== check.userId) return { ok: false, reason: 'wrong_user' }
    if (rec.sessionId !== check.sessionId) return { ok: false, reason: 'wrong_session' }
    if (rec.conversationId !== check.conversationId) return { ok: false, reason: 'wrong_conversation' }
    return { ok: true, rec }
  }
  return {
    issue(p) {
      sweep()
      const at = now()
      const rec = { ...p, createdAt: at, expiresAt: at + ttlMs, hash: statementHash(p.sqlReal) }
      records.set(p.callId, rec)
      const { hash: _hash, ...call } = rec
      void _hash
      return call
    },
    // no sweep: an expired record is still found so the answer can say it expired
    get: (callId) => {
      const r = records.get(callId)
      if (!r) return undefined
      const { hash: _hash, ...call } = r
      void _hash
      return call
    },
    consume(callId, check) {
      const b = bound(callId, check)
      if (!b.ok) return b
      if (statementHash(check.sqlReal) !== b.rec.hash) return { ok: false, reason: 'changed' }
      records.delete(callId)
      const { hash: _hash, ...call } = b.rec
      void _hash
      return { ok: true, call }
    },
    deny(callId, check) {
      const b = bound(callId, check)
      if (!b.ok) return b
      records.delete(callId)
      const { hash: _hash, ...call } = b.rec
      void _hash
      return { ok: true, call }
    },
    clearConversation(conversationId) {
      let n = 0
      for (const [id, r] of records) {
        if (r.conversationId === conversationId) {
          records.delete(id)
          n++
        }
      }
      return n
    },
    forConversation(conversationId) {
      sweep()
      return [...records.values()].filter((r) => r.conversationId === conversationId).map(({ hash: _hash, ...c }) => (void _hash, c))
    },
    size: () => {
      sweep()
      return records.size
    },
  }
}

export type RateLimiter = { take(key: string): { ok: true } | { ok: false; retryAfterMs: number } }

/** A sliding window: at most `max` takes per key in `windowMs`. */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>()
  return {
    take(key) {
      const t = now()
      const list = (hits.get(key) ?? []).filter((x) => x > t - windowMs)
      if (list.length >= max) {
        hits.set(key, list)
        return { ok: false, retryAfterMs: list[0]! + windowMs - t }
      }
      list.push(t)
      hits.set(key, list)
      return { ok: true }
    },
  }
}
