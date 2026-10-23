import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete'
import type { CompletionSchema, CompletionSchemaInput } from '~/server/sql/types'
import { splitLocal, statementAt } from './helpers'

const KEYWORDS = [
  'SELECT',
  'DISTINCT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'EXISTS',
  'BETWEEN',
  'LIKE',
  'REGEXP',
  'IS NULL',
  'IS NOT NULL',
  'AS',
  'ON',
  'USING',
  'UNION',
  'UNION ALL',
  'LIMIT',
  'OFFSET',
  'HAVING',
  'INSERT INTO',
  'VALUES',
  'ON DUPLICATE KEY UPDATE',
  'REPLACE INTO',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'CREATE DATABASE',
  'CREATE INDEX',
  'TRUNCATE TABLE',
  'RENAME TABLE',
  'ADD COLUMN',
  'DROP COLUMN',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
  'DEFAULT',
  'AUTO_INCREMENT',
  'UNIQUE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'WITH RECURSIVE',
  'OVER',
  'PARTITION BY',
  'ASC',
  'DESC',
  'SHOW TABLES',
  'SHOW DATABASES',
  'SHOW COLUMNS FROM',
  'SHOW CREATE TABLE',
  'SHOW PROCESSLIST',
  'DESCRIBE',
  'EXPLAIN',
  'USE',
  'START TRANSACTION',
  'COMMIT',
  'ROLLBACK',
  'CALL',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'CROSS JOIN',
  'LEFT OUTER JOIN',
  'GROUP BY',
  'ORDER BY',
  'FOR UPDATE',
  'RETURNING',
]

const FUNCTIONS = [
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'COALESCE',
  'IFNULL',
  'NULLIF',
  'IF',
  'CONCAT',
  'CONCAT_WS',
  'SUBSTRING',
  'LENGTH',
  'CHAR_LENGTH',
  'LOWER',
  'UPPER',
  'TRIM',
  'REPLACE',
  'ROUND',
  'FLOOR',
  'CEIL',
  'ABS',
  'NOW',
  'CURDATE',
  'CURTIME',
  'DATE',
  'DATE_FORMAT',
  'DATE_ADD',
  'DATE_SUB',
  'DATEDIFF',
  'TIMESTAMPDIFF',
  'YEAR',
  'MONTH',
  'DAY',
  'CAST',
  'CONVERT',
  'JSON_EXTRACT',
  'JSON_OBJECT',
  'JSON_ARRAY',
  'JSON_TABLE',
  'SHA2',
  'MD5',
  'UUID',
  'ROW_NUMBER',
  'RANK',
  'DENSE_RANK',
  'LAG',
  'LEAD',
  'SLEEP',
  'LAST_INSERT_ID',
  'DATABASE',
  'VERSION',
]
const MARIADB_FUNCTIONS = [
  'JSON_VALUE',
  'JSON_QUERY',
  'REGEXP_REPLACE',
  'NATURAL_SORT_KEY',
  'SFORMAT',
]
const MYSQL_FUNCTIONS = [
  'JSON_VALUE',
  'JSON_SCHEMA_VALID',
  'REGEXP_REPLACE',
  'BIN_TO_UUID',
  'UUID_TO_BIN',
]

/** Lowest score is the best match; undefined means no match (prefix, then substring, then subsequence). */
export function matchScore(query: string, candidate: string): number | undefined {
  if (query === '') return 0
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  if (c.startsWith(q)) return c.length - q.length
  const at = c.indexOf(q)
  if (at >= 0) return 1000 + at
  let k = 0
  let gaps = 0
  for (let i = 0; i < c.length && k < q.length; i++) {
    if (c[i] === q[k]) k++
    else if (k > 0) gaps++
  }
  return k === q.length ? 2000 + gaps : undefined
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9_$]*$/
export const quoteIfNeeded = (name: string) =>
  PLAIN.test(name) ? name : `\`${name.replace(/`/g, '``')}\``
const unquote = (s: string) => s.replace(/^`|`$/g, '').replace(/``/g, '`')

export type CompletionHost = {
  db: () => string | undefined
  product: () => 'mysql' | 'mariadb' | undefined
  enabled: () => boolean
  fetchSchema: (input: CompletionSchemaInput) => Promise<CompletionSchema>
}

const NOT_ALIAS =
  /^(where|join|left|right|inner|cross|on|set|using|group|order|limit|values|select|union|natural|straight_join|for)$/i

/** Tables named after FROM, JOIN, UPDATE or INTO in one statement, with their optional alias. */
export function tablesInStatement(sql: string): { db?: string; table: string; alias?: string }[] {
  const out: { db?: string; table: string; alias?: string }[] = []
  const re =
    /\b(?:from|join|update|into)\s+(`[^`]+`|\w+)(?:\s*\.\s*(`[^`]+`|\w+))?(?:\s+(?:as\s+)?(\w+))?/gi
  for (const m of sql.matchAll(re)) {
    const [, a, b, alias] = m
    if (!a) continue
    const aliasOk = alias && !NOT_ALIAS.test(alias) ? { alias } : {}
    out.push(
      b ? { db: unquote(a), table: unquote(b), ...aliasOk } : { table: unquote(a), ...aliasOk },
    )
  }
  return out
}

/**
 * Lazy completion source (FR-SQL-023). Static words come first; databases, tables and columns are
 * fetched with `getCompletionSchema` only when the caret needs them, cached per key, and a failure is
 * cached too (no retry loop). At most 200 items; matching by prefix, substring and subsequence.
 */
export function createSqlCompletion(host: CompletionHost): {
  source: CompletionSource
  reset: () => void
} {
  const cache = new Map<string, Promise<CompletionSchema | null>>()
  const load = (input: CompletionSchemaInput) => {
    const key = `${input.db ?? ''}\u0000${input.table ?? ''}`
    let hit = cache.get(key)
    if (!hit) {
      hit = host.fetchSchema(input).catch(() => null)
      cache.set(key, hit)
    }
    return hit
  }

  const source: CompletionSource = async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    if (!host.enabled()) return null
    const m = context.matchBefore(/(?:`[^`]*`|[\w$]+)?\.?`?[\w$]*/)
    if (!m || (m.from === m.to && !context.explicit)) return null
    const raw = m.text
    const dot = raw.lastIndexOf('.')
    const qualifier = dot > 0 ? unquote(raw.slice(0, dot)) : undefined
    const typedRaw = dot >= 0 ? raw.slice(dot + 1) : raw
    const from = m.from + (dot >= 0 ? dot + 1 : 0)
    const opensQuote = typedRaw.startsWith('`')
    const typed = unquote(typedRaw)
    const items: { c: Completion; s: number }[] = []
    const push = (label: string, type: string, boost: number, detail?: string, apply?: string) => {
      const s = matchScore(typed, label)
      if (s === undefined) return
      const isName = type === 'class' || type === 'property' || type === 'namespace'
      const insert = apply ?? (isName ? quoteIfNeeded(label) : label)
      items.push({
        c: {
          label,
          type,
          boost,
          ...(detail ? { detail } : {}),
          apply: opensQuote && isName ? `\`${label.replace(/`/g, '``')}\`` : insert,
        },
        s,
      })
    }

    const db = host.db()
    const text = context.state.doc.toString()
    const stmt = statementAt(splitLocal(text).statements, context.pos)?.text ?? ''
    const tables = tablesInStatement(stmt)

    if (qualifier !== undefined) {
      const root = await load({})
      if (root?.databases.includes(qualifier)) {
        const schema = await load({ db: qualifier })
        for (const t of schema?.tables ?? []) push(t.name, 'class', 0, t.kind)
      } else {
        const ref = tables.find((t) => t.alias === qualifier || t.table === qualifier)
        const schema = await load({ db: ref?.db ?? db, table: ref?.table ?? qualifier })
        for (const c of schema?.columns ?? []) push(c.name, 'property', 0, c.type)
      }
    } else {
      for (const k of KEYWORDS) push(k, 'keyword', -10, undefined, k)
      const fns = [
        ...FUNCTIONS,
        ...(host.product() === 'mariadb' ? MARIADB_FUNCTIONS : MYSQL_FUNCTIONS),
      ]
      for (const f of fns) push(f, 'function', -5, undefined, `${f}()`)
      const root = await load(db ? { db } : {})
      for (const t of tables.slice(0, 4)) {
        const schema = await load({ db: t.db ?? db, table: t.table })
        for (const c of schema?.columns ?? []) push(c.name, 'property', 10, c.type)
      }
      for (const t of root?.tables ?? []) push(t.name, 'class', 5, t.kind)
      for (const d of root?.databases ?? []) push(d, 'namespace', 0)
    }

    items.sort(
      (a, b) =>
        a.s - b.s || (b.c.boost ?? 0) - (a.c.boost ?? 0) || a.c.label.localeCompare(b.c.label),
    )
    const options = items.slice(0, 200).map((i) => i.c)
    if (options.length === 0) return null
    return { from, options, filter: false }
  }
  return { source, reset: () => cache.clear() }
}
