/**
 * PII markings (SPEC/34 FR-AST-006). A marking is `db.table.column`; each part may be `*`. Matching is case-insensitive
 * (a wider match only ever marks more). Markings come from `DBLOOM_PII_COLUMNS` and, in account mode, from the store.
 * Pure: no I/O.
 */

export type PiiRule = { db: string; table: string; column: string }

export type RuleListResult = { rules: PiiRule[]; errors: string[] }

const PART = /^(\*|[^.*\s`'"\\][^.*\s`'"\\]*)$/

/** Parses `db.table.column`; `undefined` for anything else (wrong part count, quotes, spaces, empty parts). */
export function parseRule(text: string): PiiRule | undefined {
  const parts = text.trim().split('.')
  if (parts.length !== 3) return undefined
  if (!parts.every((p) => PART.test(p))) return undefined
  const [db, table, column] = parts.map((p) => p.toLowerCase()) as [string, string, string]
  return { db, table, column }
}

export const ruleText = (r: PiiRule): string => `${r.db}.${r.table}.${r.column}`

/** A comma separated list (the environment form). Bad entries are reported and skipped, never guessed. */
export function parseRuleList(text: string | undefined): RuleListResult {
  const rules: PiiRule[] = []
  const errors: string[] = []
  for (const raw of (text ?? '').split(',')) {
    const t = raw.trim()
    if (t === '') continue
    const r = parseRule(t)
    if (r) rules.push(r)
    else errors.push(t)
  }
  return { rules: dedupe(rules), errors }
}

/** The union of several lists, without duplicates, in first-seen order. */
export function mergeRules(...lists: PiiRule[][]): PiiRule[] {
  return dedupe(lists.flat())
}

function dedupe(rules: PiiRule[]): PiiRule[] {
  const seen = new Set<string>()
  const out: PiiRule[] = []
  for (const r of rules) {
    const k = ruleText(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

const fits = (pattern: string, value: string | undefined): boolean =>
  pattern === '*' || (value !== undefined && pattern === value.toLowerCase())

export type CompiledRules = {
  readonly count: number
  /** `db` may be unknown (no default database): then any database part matches, which only marks more. */
  isPiiColumn(db: string | undefined, table: string, column: string): boolean
  /** Some marking could apply to a column of this table (used when the table's columns are unknown). */
  tableMayHavePii(db: string | undefined, table: string): boolean
}

export function compileRules(rules: PiiRule[]): CompiledRules {
  const list = mergeRules(rules)
  const dbFits = (p: string, db: string | undefined) => db === undefined || fits(p, db)
  return {
    count: list.length,
    isPiiColumn: (db, table, column) =>
      list.some((r) => dbFits(r.db, db) && fits(r.table, table) && fits(r.column, column)),
    tableMayHavePii: (db, table) => list.some((r) => dbFits(r.db, db) && fits(r.table, table)),
  }
}
