import { z } from 'zod'
import {
  MAX_TABLE_SCOPES,
  PREF_KEYS,
  PREF_VALUE_MAX_BYTES,
  sortEntry,
  type ColumnLayout,
  type PrefKey,
} from './types'

/**
 * Display preferences of module rows (FR-ROW-010, section 5.9). Values are layout and display choices only:
 * never filter values, search text, cell values or SQL. Keys come from a fixed allow-list; the value of
 * each key is checked by `parsePrefValue` before it is stored.
 */

export class PrefsError extends Error {
  constructor(
    public code: 'invalid-value' | 'scope-required' | 'scope-forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'PrefsError'
  }
}

export type PrefScope = { kind: 'global' } | { kind: 'table'; db: string; table: string }

const enc = (s: string) => encodeURIComponent(s).replaceAll('.', '%2E')

/** `global` or `table:<db>.<table>` (names percent-encoded, so a dot in a name cannot collide). */
export function scopeKey(scope: PrefScope): string {
  return scope.kind === 'global' ? 'global' : `table:${enc(scope.db)}.${enc(scope.table)}`
}

export type PrefValues = Partial<Record<PrefKey, unknown>>

/** The store seen by the service; SQLite (`ui_prefs`) and memory (stateless mode) implement it. */
export interface PrefsStore {
  /** Global scope overlaid by the table scope when one is given. */
  get(ownerKey: string, targetKey: string, table?: { db: string; table: string }): PrefValues
  set(ownerKey: string, targetKey: string, scope: PrefScope, key: PrefKey, value: unknown): void
  /** Table scopes held for this owner and target (for tests and pruning). */
  tableScopeCount(ownerKey: string, targetKey: string): number
}

// ---- Value schemas ---------------------------------------------------------------------------------

const name = z.string().min(1).max(64)
const layout: z.ZodType<ColumnLayout> = z
  .object({
    order: z.array(name).max(4096),
    hidden: z.array(name).max(4096),
    widths: z.record(name, z.number().int().min(20).max(4000)),
  })
  .strict()

const VALUE_SCHEMAS: Record<PrefKey, z.ZodType> = {
  'rows.pageSize': z.number().int().min(1).max(1000),
  'rows.displayChars': z.number().int().min(20).max(1000),
  'rows.fullText': z.boolean(),
  'rows.protectBinary': z.boolean(),
  'rows.columns': layout,
  'rows.sort': z.array(sortEntry).max(4),
  'rows.relationMode': z.enum(['full', 'links', 'none']),
  'rows.fkDisplay': z
    .record(z.string().max(140), z.array(name).max(8))
    .refine((r) => Object.keys(r).length <= 200, 'too many entries'),
  'rows.defaultStringOperator': z.enum(['contains', 'starts with']),
  'rows.gridEditing': z.boolean(),
  'rows.insertRows': z.number().int().min(1).max(100),
  'rows.countThreshold': z.number().int().min(0).max(1_000_000_000),
}

/** Keys that only make sense for one table. */
const TABLE_ONLY = new Set<PrefKey>(['rows.columns', 'rows.sort'])

const isKey = (k: string): k is PrefKey => (PREF_KEYS as readonly string[]).includes(k)

/** Validates the value of a key and the scope it may live in; returns the parsed value. */
export function parsePrefValue(key: string, value: unknown, scope: PrefScope): unknown {
  if (!isKey(key)) throw new PrefsError('invalid-value', 'Unknown preference')
  if (TABLE_ONLY.has(key) && scope.kind !== 'table') {
    throw new PrefsError('scope-required', 'This preference belongs to one table')
  }
  const parsed = VALUE_SCHEMAS[key].safeParse(value)
  if (!parsed.success) throw new PrefsError('invalid-value', 'Invalid value')
  if (JSON.stringify(parsed.data).length > PREF_VALUE_MAX_BYTES) {
    throw new PrefsError('invalid-value', 'Value too large')
  }
  return parsed.data
}

/** Drops names of dropped columns from a stored layout or sort; other entries stay (DATA-ISS-114). */
export function pruneLayout(layoutValue: unknown, columns: string[]): ColumnLayout | undefined {
  const parsed = layout.safeParse(layoutValue)
  if (!parsed.success) return undefined
  const known = new Set(columns)
  const l = parsed.data
  return {
    order: l.order.filter((c) => known.has(c)),
    hidden: l.hidden.filter((c) => known.has(c)),
    widths: Object.fromEntries(Object.entries(l.widths).filter(([c]) => known.has(c))),
  }
}

export function pruneSort(
  sortValue: unknown,
  columns: string[],
): { column: string; direction: 'asc' | 'desc' }[] | undefined {
  const parsed = z.array(sortEntry).safeParse(sortValue)
  if (!parsed.success) return undefined
  const known = new Set(columns)
  return parsed.data.filter((s) => known.has(s.column))
}

// ---- Memory store (stateless mode, section 5.9) -----------------------------------------------------

type Entry = { json: string; updatedAt: number }

/** Preferences of one session in process memory, bounded; owner key is the session id hash. */
export class MemoryPrefs implements PrefsStore {
  private owners = new Map<string, Map<string, Map<string, Entry>>>() // owner|target -> scope -> key -> entry

  constructor(
    private now: () => number = Date.now,
    private maxOwners = 1000,
    private maxTableScopes = MAX_TABLE_SCOPES,
  ) {}

  private bucket(ownerKey: string, targetKey: string, create: boolean) {
    const id = `${ownerKey}\u0000${targetKey}`
    let b = this.owners.get(id)
    if (!b && create) {
      if (this.owners.size >= this.maxOwners) {
        const oldest = this.owners.keys().next().value
        if (oldest !== undefined) this.owners.delete(oldest)
      }
      b = new Map()
      this.owners.set(id, b)
    }
    return b
  }

  dropOwner(ownerKey: string): void {
    for (const id of [...this.owners.keys()]) {
      if (id.startsWith(`${ownerKey}\u0000`)) this.owners.delete(id)
    }
  }

  get(ownerKey: string, targetKey: string, table?: { db: string; table: string }): PrefValues {
    const b = this.bucket(ownerKey, targetKey, false)
    const out: PrefValues = {}
    if (!b) return out
    const scopes = ['global']
    if (table) scopes.push(scopeKey({ kind: 'table', ...table }))
    for (const s of scopes) {
      for (const [k, e] of b.get(s) ?? []) {
        if (isKey(k)) out[k] = JSON.parse(e.json) as unknown
      }
    }
    return out
  }

  set(ownerKey: string, targetKey: string, scope: PrefScope, key: PrefKey, value: unknown): void {
    const b = this.bucket(ownerKey, targetKey, true)!
    const s = scopeKey(scope)
    let keys = b.get(s)
    if (!keys) {
      keys = new Map()
      b.set(s, keys)
    }
    keys.set(key, { json: JSON.stringify(value), updatedAt: this.now() })
    if (scope.kind === 'table') this.prune(b)
  }

  private prune(b: Map<string, Map<string, Entry>>): void {
    const tables = [...b.entries()]
      .filter(([s]) => s !== 'global')
      .map(([s, keys]) => ({ s, at: Math.max(...[...keys.values()].map((e) => e.updatedAt)) }))
      .sort((a, c) => c.at - a.at || (a.s < c.s ? 1 : -1))
    for (const t of tables.slice(this.maxTableScopes)) b.delete(t.s)
  }

  tableScopeCount(ownerKey: string, targetKey: string): number {
    const b = this.bucket(ownerKey, targetKey, false)
    return b ? [...b.keys()].filter((s) => s !== 'global').length : 0
  }
}
