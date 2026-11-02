/**
 * Preference store of the mock layer (src/lib/auth/mock-api.ts): the registry's defaults and a small validator per
 * kind, so the Preferences page can be built and tested without a server. The real rules live in
 * src/server/auth/prefs/registry.ts; this file only has to be close enough to show every state of the page.
 */
import { PREF_META, type PrefMeta } from './account-logic'

export const MOCK_PREF_DEFAULTS: Record<string, unknown> = {
  theme: 'system',
  language: 'en',
  loginLanding: true,
  navWidth: 244,
  hiddenDatabases: [],
  collation: null,
  'rows.pageSize': 50,
  'rows.displayChars': 100,
  'rows.fullText': false,
  'rows.protectBinary': true,
  'rows.relationMode': 'full',
  'rows.fkDisplay': {},
  'rows.defaultStringOperator': 'contains',
  'rows.gridEditing': true,
  'rows.insertRows': 1,
  'rows.countThreshold': 50000,
  'io.exportFormat': 'sql',
  'io.exportCompression': 'none',
  'io.importFormat': 'sql',
  'io.mode': 'quick',
  'io.fileName.server': '{server}_{date}',
  'io.fileName.database': '{database}_{date}',
  'io.fileName.table': '{table}_{date}',
  'io.fileName.result': 'result_{date}',
  'io.options.sql': {},
  'io.options.csv': {},
  'io.options.json': {},
  'io.lastExport': {},
  'io.lastImport': {},
  'io.uploadMiB': 50,
  'io.decompressedMiB': 500,
  'io.jobSeconds': 300,
  'io.maxExportMiB': 1024,
  'io.concurrentImports': 2,
  'io.formats': ['sql', 'csv', 'json'],
  'io.compressions': ['none', 'gzip', 'zip'],
  'io.serverFolder': false,
  'io.formulaNeutralisation': true,
  'io.dragDrop': true,
}

/** Keys that belong to one server (scope `user+target`); the others are per user. */
export const MOCK_USER_SCOPED = new Set(['theme', 'language', 'loginLanding', 'navWidth', 'hiddenDatabases'])

export function mockValid(key: string, value: unknown): boolean {
  const meta: PrefMeta | undefined = PREF_META[key]
  if (!meta) return false
  switch (meta.kind) {
    case 'select':
      return typeof value === 'string' && (meta.options?.includes(value) ?? false)
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      if (meta.kind === 'integer' && !Number.isInteger(value)) return false
      return (meta.min === undefined || value >= meta.min) && (meta.max === undefined || value <= meta.max)
    }
    case 'nullable-text':
      return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 64)
    case 'text':
      return typeof value === 'string' && value.length > 0 && value.length <= 200
    case 'tags':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0) && value.length <= 100
    case 'json':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
