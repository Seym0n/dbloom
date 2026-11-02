import { z } from 'zod'
import { DEFAULT_TEMPLATES } from '../../io/filename'
import { IO_DEFAULTS } from '../../io/limits'
import { IO_PREF_KEYS, parseIoPref, type IoPrefKey } from '../../io/store'
import { PREF_KEYS, type PrefKey as RowsPrefKey } from '../../rows/types'
import { parsePrefValue } from '../../rows/prefs'
import {
  AUTH_PREF_KEYS,
  AUTH_PREF_SCHEMAS,
  PREFS_SCOPE,
  type PrefDefinition,
  type PrefsRegistry,
} from '../types'

/**
 * The registry of preference keys (FR-AUT-024): every module declares key, scope, schema and default in one
 * place. Rows and io keep their stored rows (`storedAs`): scope `global` / `io`, key unchanged, target key of
 * the session. Auth keys live under the scope `prefs`.
 */

/** Interface languages that ship with the application (FR-AUT-024); a new file in `src/i18n` adds one. */
export const SHIPPED_LANGUAGES: readonly string[] = ['en']

export class PrefsRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrefsRegistryError'
  }
}

export function createPrefsRegistry(): PrefsRegistry {
  const defs = new Map<string, PrefDefinition>()
  return {
    register(def) {
      if (defs.has(def.key)) throw new PrefsRegistryError(`Preference ${def.key} is already registered`)
      defs.set(def.key, def)
    },
    get: (key) => defs.get(key),
    all: () => [...defs.values()],
  }
}

/** Wraps an existing throwing parser (rows, io) into a schema that reports a plain issue. */
function fromParser(parse: (v: unknown) => unknown): z.ZodType<unknown> {
  return z.unknown().transform((v, ctx) => {
    try {
      return parse(v)
    } catch {
      ctx.issues.push({ code: 'custom', message: 'Invalid value', input: v })
      return z.NEVER
    }
  })
}

const authDefs: PrefDefinition[] = [
  def('theme', 'auth', 'user', 'features', AUTH_PREF_SCHEMAS.theme, 'system'),
  def(
    'language',
    'auth',
    'user',
    'features',
    AUTH_PREF_SCHEMAS.language.refine((l) => SHIPPED_LANGUAGES.includes(l), 'Language not available'),
    'en',
  ),
  def('loginLanding', 'auth', 'user', 'features', AUTH_PREF_SCHEMAS.loginLanding, true),
  def('navWidth', 'auth', 'user', 'navigation', AUTH_PREF_SCHEMAS.navWidth, 244),
  def('hiddenDatabases', 'auth', 'user+target', 'navigation', AUTH_PREF_SCHEMAS.hiddenDatabases, []),
  def('collation', 'auth', 'user+target', 'features', AUTH_PREF_SCHEMAS.collation, null),
]

function def(
  key: string,
  module: PrefDefinition['module'],
  scope: PrefDefinition['scope'],
  category: PrefDefinition['category'],
  schema: z.ZodType,
  dflt: unknown,
  storedAs?: PrefDefinition['storedAs'],
): PrefDefinition {
  return { key, module, scope, category, schema, default: dflt, label: `prefs.${key}`, storedAs: storedAs ?? { scope: PREFS_SCOPE, key } }
}

/** `rows.columns` and `rows.sort` are per table (scope `table:<db>.<table>`) and stay with the rows module. */
const ROWS_DEFAULTS: Partial<Record<RowsPrefKey, unknown>> = {
  'rows.pageSize': 50,
  'rows.displayChars': 100,
  'rows.fullText': false,
  'rows.protectBinary': true,
  'rows.relationMode': 'full',
  'rows.fkDisplay': {},
  'rows.defaultStringOperator': 'contains',
  'rows.gridEditing': true,
  'rows.insertRows': 1,
  'rows.countThreshold': 50_000,
}
export const ROWS_REGISTERED_KEYS = PREF_KEYS.filter((k) => k in ROWS_DEFAULTS)

const rowsDefs: PrefDefinition[] = ROWS_REGISTERED_KEYS.map((k) =>
  def(k, 'rows', 'user+target', 'main', fromParser((v) => parsePrefValue(k, v, { kind: 'global' })), ROWS_DEFAULTS[k], { scope: 'global', key: k }),
)

const IO_META: Record<IoPrefKey, { category: PrefDefinition['category']; default: unknown }> = {
  'io.exportFormat': { category: 'export', default: 'sql' },
  'io.exportCompression': { category: 'export', default: 'none' },
  'io.importFormat': { category: 'import', default: 'sql' },
  'io.mode': { category: 'export', default: 'quick' },
  'io.fileName.server': { category: 'export', default: DEFAULT_TEMPLATES.server },
  'io.fileName.database': { category: 'export', default: DEFAULT_TEMPLATES.database },
  'io.fileName.table': { category: 'export', default: DEFAULT_TEMPLATES.table },
  'io.fileName.result': { category: 'export', default: DEFAULT_TEMPLATES.result },
  'io.options.sql': { category: 'export', default: parseIoPref('io.options.sql', {}) },
  'io.options.csv': { category: 'export', default: parseIoPref('io.options.csv', {}) },
  'io.options.json': { category: 'export', default: parseIoPref('io.options.json', {}) },
  'io.lastExport': { category: 'export', default: {} },
  'io.lastImport': { category: 'import', default: {} },
  'io.uploadMiB': { category: 'import', default: IO_DEFAULTS.uploadBytes / 1048576 },
  'io.decompressedMiB': { category: 'import', default: IO_DEFAULTS.decompressedBytes / 1048576 },
  'io.jobSeconds': { category: 'import', default: IO_DEFAULTS.jobMs / 1000 },
  'io.maxExportMiB': { category: 'export', default: IO_DEFAULTS.maxExportBytes / 1048576 },
  'io.concurrentImports': { category: 'import', default: IO_DEFAULTS.concurrentImports },
  'io.formats': { category: 'export', default: ['sql', 'csv', 'json'] },
  'io.compressions': { category: 'export', default: ['none', 'gzip', 'zip'] },
  'io.serverFolder': { category: 'import', default: false },
  'io.formulaNeutralisation': { category: 'export', default: true },
  'io.dragDrop': { category: 'import', default: true },
}

const ioDefs: PrefDefinition[] = IO_PREF_KEYS.map((k) =>
  def(k, 'io', 'user+target', IO_META[k].category, fromParser((v) => parseIoPref(k, v)), IO_META[k].default, { scope: 'io', key: k }),
)

/** The registry with the keys of auth, rows and io registered. Other modules call `register` at start-up. */
export function createDefaultPrefsRegistry(): PrefsRegistry {
  const registry = createPrefsRegistry()
  for (const d of [...authDefs, ...rowsDefs, ...ioDefs]) registry.register(d)
  return registry
}

export const isAuthPrefKey = (k: string): boolean => (AUTH_PREF_KEYS as readonly string[]).includes(k)
