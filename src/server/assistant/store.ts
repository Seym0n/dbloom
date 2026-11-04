/**
 * Store of the assistant (SPEC/34 FR-AST-015, FR-AST-006): conversations of a user, their messages, PII markings and the
 * "no PII on this target" acknowledgements. Result rows and the token map are never stored: a message keeps the text as it
 * went to the model (tokenized), the SQL, the outcome and the row count only. Every conversation query is scoped by user.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export const ASSISTANT_MODES = ['manual', 'auto'] as const
export type AssistantMode = (typeof ASSISTANT_MODES)[number]
export type MessageRole = 'user' | 'assistant' | 'tool'

export type Conversation = {
  id: string
  userId: string
  targetKey: string
  title: string
  mode: AssistantMode
  createdAt: number
  updatedAt: number
}

export type StoredMessage = {
  id: number
  conversationId: string
  seq: number
  role: MessageRole
  /** Text as sent to or received from the model (tokenized). Empty for a tool message. */
  content: string
  sql: string | null
  outcome: string | null
  rowCount: number | null
  createdAt: number
}

export type NewMessage = { role: MessageRole; content: string; sql?: string | null; outcome?: string | null; rowCount?: number | null }

export type PiiRuleRow = { id: number; targetKey: string; rule: string; createdAt: number; createdBy: string }
export type PiiAck = { targetKey: string; acknowledgedAt: number; acknowledgedBy: string }

/** The `target_key` value of a marking or acknowledgement that applies to every target. */
export const ALL_TARGETS = ''

export type AssistantStore = {
  createConversation(c: Omit<Conversation, 'createdAt' | 'updatedAt'> & { at?: number }): Conversation
  getConversation(userId: string, id: string): Conversation | undefined
  listConversations(userId: string, opts?: { targetKey?: string; limit?: number }): Conversation[]
  updateConversation(userId: string, id: string, patch: { title?: string; mode?: AssistantMode }): boolean
  deleteConversation(userId: string, id: string): boolean
  /** Removes conversations not touched since `before` (retention); returns how many. */
  purgeConversations(before: number): number
  addMessage(userId: string, conversationId: string, m: NewMessage): StoredMessage | undefined
  listMessages(userId: string, conversationId: string): StoredMessage[]

  listPiiRules(targetKey?: string): PiiRuleRow[]
  addPiiRule(targetKey: string, rule: string, by: string): { row: PiiRuleRow; created: boolean }
  removePiiRule(id: number): PiiRuleRow | undefined
  getPiiAck(targetKey: string): PiiAck | undefined
  listPiiAcks(): PiiAck[]
  setPiiAck(targetKey: string, by: string): void
  clearPiiAck(targetKey: string): boolean
}

type ConvRow = { id: string; user_id: string; target_key: string; title: string; mode: AssistantMode; created_at: number; updated_at: number }
type MsgRow = { id: number; conversation_id: string; seq: number; role: MessageRole; content: string; sql: string | null; outcome: string | null; row_count: number | null; created_at: number }
type RuleRow = { id: number; target_key: string; rule: string; created_at: number; created_by: string }

const conv = (r: ConvRow): Conversation => ({
  id: r.id,
  userId: r.user_id,
  targetKey: r.target_key,
  title: r.title,
  mode: r.mode,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})
const msg = (r: MsgRow): StoredMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: r.seq,
  role: r.role,
  content: r.content,
  sql: r.sql,
  outcome: r.outcome,
  rowCount: r.row_count,
  createdAt: r.created_at,
})
const rule = (r: RuleRow): PiiRuleRow => ({ id: r.id, targetKey: r.target_key, rule: r.rule, createdAt: r.created_at, createdBy: r.created_by })

/** Migration 9 (called from the store's migration list). */
export const ASSISTANT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS assistant_conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_key TEXT NOT NULL,
    title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','auto')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS assistant_conversations_user ON assistant_conversations(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')), content TEXT NOT NULL,
    sql TEXT, outcome TEXT, row_count INTEGER, created_at INTEGER NOT NULL, UNIQUE (conversation_id, seq)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS pii_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL, rule TEXT NOT NULL,
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL, UNIQUE (target_key, rule)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS pii_ack (
    target_key TEXT PRIMARY KEY, acknowledged_at INTEGER NOT NULL, acknowledged_by TEXT NOT NULL
  ) STRICT;
`

export function createSqliteAssistantStore(db: DatabaseSync, now: () => number = Date.now): AssistantStore {
  const one = <T>(q: string, ...p: SQLInputValue[]) => db.prepare(q).get(...p) as T | undefined
  const many = <T>(q: string, ...p: SQLInputValue[]) => db.prepare(q).all(...p) as T[]
  const run = (q: string, ...p: SQLInputValue[]) => db.prepare(q).run(...p)
  const owns = (userId: string, id: string) => one<{ n: number }>('SELECT 1 AS n FROM assistant_conversations WHERE id=? AND user_id=?', id, userId) !== undefined

  return {
    createConversation: (c) => {
      const at = c.at ?? now()
      run('INSERT INTO assistant_conversations(id,user_id,target_key,title,mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', c.id, c.userId, c.targetKey, c.title, c.mode, at, at)
      return { id: c.id, userId: c.userId, targetKey: c.targetKey, title: c.title, mode: c.mode, createdAt: at, updatedAt: at }
    },
    getConversation: (userId, id) => {
      const r = one<ConvRow>('SELECT * FROM assistant_conversations WHERE id=? AND user_id=?', id, userId)
      return r ? conv(r) : undefined
    },
    listConversations: (userId, opts = {}) =>
      many<ConvRow>(
        `SELECT * FROM assistant_conversations WHERE user_id=? ${opts.targetKey === undefined ? '' : 'AND target_key=?'} ORDER BY updated_at DESC, id LIMIT ?`,
        userId,
        ...(opts.targetKey === undefined ? [] : [opts.targetKey]),
        Math.min(Math.max(opts.limit ?? 50, 1), 200),
      ).map(conv),
    updateConversation: (userId, id, patch) => {
      if (!owns(userId, id)) return false
      const sets: string[] = []
      const params: SQLInputValue[] = []
      if (patch.title !== undefined) {
        sets.push('title=?')
        params.push(patch.title)
      }
      if (patch.mode !== undefined) {
        sets.push('mode=?')
        params.push(patch.mode)
      }
      sets.push('updated_at=?')
      params.push(now())
      run(`UPDATE assistant_conversations SET ${sets.join(',')} WHERE id=? AND user_id=?`, ...params, id, userId)
      return true
    },
    deleteConversation: (userId, id) => run('DELETE FROM assistant_conversations WHERE id=? AND user_id=?', id, userId).changes === 1,
    purgeConversations: (before) => Number(run('DELETE FROM assistant_conversations WHERE updated_at < ?', before).changes),
    addMessage: (userId, conversationId, m) => {
      if (!owns(userId, conversationId)) return undefined
      const at = now()
      const seq = (one<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM assistant_messages WHERE conversation_id=?', conversationId)?.n ?? 1)
      const r = run(
        'INSERT INTO assistant_messages(conversation_id,seq,role,content,sql,outcome,row_count,created_at) VALUES(?,?,?,?,?,?,?,?)',
        conversationId, seq, m.role, m.content, m.sql ?? null, m.outcome ?? null, m.rowCount ?? null, at,
      )
      run('UPDATE assistant_conversations SET updated_at=? WHERE id=?', at, conversationId)
      return { id: Number(r.lastInsertRowid), conversationId, seq, role: m.role, content: m.content, sql: m.sql ?? null, outcome: m.outcome ?? null, rowCount: m.rowCount ?? null, createdAt: at }
    },
    listMessages: (userId, conversationId) =>
      owns(userId, conversationId) ? many<MsgRow>('SELECT * FROM assistant_messages WHERE conversation_id=? ORDER BY seq', conversationId).map(msg) : [],

    listPiiRules: (targetKey) =>
      many<RuleRow>(
        targetKey === undefined ? 'SELECT * FROM pii_rules ORDER BY id' : 'SELECT * FROM pii_rules WHERE target_key IN (?, ?) ORDER BY id',
        ...(targetKey === undefined ? [] : [targetKey, ALL_TARGETS]),
      ).map(rule),
    addPiiRule: (targetKey, text, by) => {
      const at = now()
      const r = run('INSERT INTO pii_rules(target_key,rule,created_at,created_by) VALUES(?,?,?,?) ON CONFLICT(target_key,rule) DO NOTHING', targetKey, text, at, by)
      const row = rule(one<RuleRow>('SELECT * FROM pii_rules WHERE target_key=? AND rule=?', targetKey, text)!)
      return { row, created: r.changes === 1 }
    },
    removePiiRule: (id) => {
      const r = one<RuleRow>('SELECT * FROM pii_rules WHERE id=?', id)
      if (!r) return undefined
      run('DELETE FROM pii_rules WHERE id=?', id)
      return rule(r)
    },
    getPiiAck: (targetKey) => {
      const r = one<{ target_key: string; acknowledged_at: number; acknowledged_by: string }>('SELECT * FROM pii_ack WHERE target_key=?', targetKey)
      return r ? { targetKey: r.target_key, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by } : undefined
    },
    listPiiAcks: () => many<{ target_key: string; acknowledged_at: number; acknowledged_by: string }>('SELECT * FROM pii_ack ORDER BY target_key').map((r) => ({ targetKey: r.target_key, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by })),
    setPiiAck: (targetKey, by) =>
      void run('INSERT INTO pii_ack(target_key,acknowledged_at,acknowledged_by) VALUES(?,?,?) ON CONFLICT(target_key) DO UPDATE SET acknowledged_at=excluded.acknowledged_at,acknowledged_by=excluded.acknowledged_by', targetKey, now(), by),
    clearPiiAck: (targetKey) => run('DELETE FROM pii_ack WHERE target_key=?', targetKey).changes === 1,
  }
}
