/**
 * Hide the names of PII columns from the model (SPEC/34 FR-AST-016). The model sees `col_n`; the server turns `col_n` in
 * its SQL back into the real, quoted name before the statement is shown or run. Columns can be registered while a
 * conversation goes on (a table is described later); an alias never changes once given. Pure.
 */
import { tokenize } from '~/lib/sql/lexer'

export type HiddenColumn = { db: string; table: string; column: string }

export type NameHider = {
  /** Registers a hidden column (idempotent) and returns its alias. */
  register(c: HiddenColumn): string
  /** The name the model sees for a column of the schema outline. */
  aliasOf(db: string, table: string, column: string): string
  /** A result column name as the model should see it (a hidden real name becomes its alias). */
  hideResultName(name: string): string
  /** The model's SQL with every alias replaced by the real quoted column name; words inside strings and comments stay. */
  restoreSql(sql: string): string
}

const quote = (name: string): string => `\`${name.replace(/`/g, '``')}\``

export function createNameHider(initial: HiddenColumn[] = []): NameHider {
  const alias = new Map<string, string>()
  const real = new Map<string, string>()
  const byName = new Map<string, string>()
  const keyOf = (db: string, table: string, column: string) => `${db}\u0000${table}\u0000${column}`.toLowerCase()

  const register: NameHider['register'] = (c) => {
    const key = keyOf(c.db, c.table, c.column)
    const known = alias.get(key)
    if (known) return known
    const a = `col_${alias.size + 1}`
    alias.set(key, a)
    real.set(a, c.column)
    if (!byName.has(c.column.toLowerCase())) byName.set(c.column.toLowerCase(), a)
    return a
  }
  for (const c of initial) register(c)

  return {
    register,
    aliasOf: (db, table, column) => alias.get(keyOf(db, table, column)) ?? column,
    hideResultName: (name) => byName.get(name.toLowerCase()) ?? name,
    restoreSql: (sql) => {
      const { tokens } = tokenize(sql)
      let out = ''
      for (const t of tokens) {
        const text = sql.slice(t.start, t.end)
        if (t.type === 'word' && real.has(text.toLowerCase())) out += quote(real.get(text.toLowerCase())!)
        else if (t.type === 'quotedIdent' && real.has(text.slice(1, -1).toLowerCase())) out += quote(real.get(text.slice(1, -1).toLowerCase())!)
        else out += text
      }
      return out
    },
  }
}
