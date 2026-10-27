import { z } from 'zod'
import {
  MAX_TEMPLATES,
  MAX_TEMPLATE_NAME,
  compression,
  csvExportOptions,
  ioFormat,
  jsonExportOptions,
  sqlExportOptions,
} from './types'

/**
 * Store side of module `io` (FR-IO-011, section 5.9): per-user defaults (`io.*` keys in `ui_prefs`) and named
 * export templates (`io_templates`). SQLite (`sqlite-store.ts`) and memory (stateless mode) implement the same
 * interfaces with the same limits. Values are choices and options only: no secrets, no data, no SQL.
 */

export class IoStoreError extends Error {
  constructor(
    public code: 'invalid-value' | 'template-limit' | 'invalid-name' | 'invalid-kind',
    message: string,
  ) {
    super(message)
    this.name = 'IoStoreError'
  }
}

// ---- Preferences -------------------------------------------------------------------------------------

export const IO_PREF_KEYS = [
  'io.exportFormat',
  'io.exportCompression',
  'io.importFormat',
  'io.mode',
  'io.fileName.server',
  'io.fileName.database',
  'io.fileName.table',
  'io.fileName.result',
  'io.options.sql',
  'io.options.csv',
  'io.options.json',
  'io.lastExport',
  'io.lastImport',
  'io.uploadMiB',
  'io.decompressedMiB',
  'io.jobSeconds',
  'io.maxExportMiB',
  'io.concurrentImports',
  'io.formats',
  'io.compressions',
  'io.serverFolder',
  'io.formulaNeutralisation',
  'io.dragDrop',
] as const
export type IoPrefKey = (typeof IO_PREF_KEYS)[number]
export type IoPrefValues = Partial<Record<IoPrefKey, unknown>>

export const IO_PREF_VALUE_MAX_BYTES = 8192

const template = z.string().max(MAX_TEMPLATE_NAME)
const lastValues = z.record(z.string().max(64), z.unknown())

const PREF_SCHEMAS: Record<IoPrefKey, z.ZodType> = {
  'io.exportFormat': ioFormat,
  'io.exportCompression': compression,
  'io.importFormat': ioFormat,
  'io.mode': z.enum(['quick', 'custom']),
  'io.fileName.server': template,
  'io.fileName.database': template,
  'io.fileName.table': template,
  'io.fileName.result': template,
  'io.options.sql': sqlExportOptions,
  'io.options.csv': csvExportOptions,
  'io.options.json': jsonExportOptions,
  'io.lastExport': lastValues,
  'io.lastImport': lastValues,
  'io.uploadMiB': z.number().int().min(1).max(2048),
  'io.decompressedMiB': z.number().int().min(1).max(4096),
  'io.jobSeconds': z.number().int().min(60).max(7200),
  'io.maxExportMiB': z.number().int().min(1).max(8192),
  'io.concurrentImports': z.number().int().min(1).max(3),
  'io.formats': z.array(ioFormat).max(3),
  'io.compressions': z.array(compression).max(3),
  'io.serverFolder': z.boolean(),
  'io.formulaNeutralisation': z.boolean(),
  'io.dragDrop': z.boolean(),
}

const isKey = (k: string): k is IoPrefKey => (IO_PREF_KEYS as readonly string[]).includes(k)
export const isIoPrefKey = isKey

/** Checks key and value; returns the parsed value (defaults of option objects filled in). */
export function parseIoPref(key: string, value: unknown): unknown {
  if (!isKey(key)) throw new IoStoreError('invalid-value', 'Unknown preference')
  const parsed = PREF_SCHEMAS[key].safeParse(value)
  if (!parsed.success) throw new IoStoreError('invalid-value', 'Invalid value')
  if (JSON.stringify(parsed.data).length > IO_PREF_VALUE_MAX_BYTES) {
    throw new IoStoreError('invalid-value', 'Value too large')
  }
  return parsed.data
}

/** Drops stored values that no longer pass their schema; returns the valid ones and the dropped keys (FR-UPD-004). */
export function validateStoredPrefs(raw: IoPrefValues): {
  values: IoPrefValues
  invalid: IoPrefKey[]
} {
  const values: IoPrefValues = {}
  const invalid: IoPrefKey[] = []
  for (const key of IO_PREF_KEYS) {
    if (!(key in raw)) continue
    const parsed = PREF_SCHEMAS[key].safeParse(raw[key])
    if (parsed.success) values[key] = parsed.data
    else invalid.push(key)
  }
  return { values, invalid }
}

export interface IoPrefsStore {
  get(ownerKey: string, targetKey: string): IoPrefValues
  /** `value` is checked by `parseIoPref` by the caller of the store, not here. */
  set(ownerKey: string, targetKey: string, key: IoPrefKey, value: unknown): void
}

/** Checked write: use this from server functions. */
export function setIoPref(
  store: IoPrefsStore,
  ownerKey: string,
  targetKey: string,
  key: string,
  value: unknown,
) {
  store.set(ownerKey, targetKey, key as IoPrefKey, parseIoPref(key, value))
}

export class MemoryIoPrefs implements IoPrefsStore {
  private data = new Map<string, Map<IoPrefKey, string>>()

  constructor(private maxOwners = 1000) {}

  get(ownerKey: string, targetKey: string): IoPrefValues {
    const out: IoPrefValues = {}
    for (const [k, json] of this.data.get(`${ownerKey}\u0000${targetKey}`) ?? []) {
      out[k] = JSON.parse(json) as unknown
    }
    return out
  }

  set(ownerKey: string, targetKey: string, key: IoPrefKey, value: unknown): void {
    const id = `${ownerKey}\u0000${targetKey}`
    let m = this.data.get(id)
    if (!m) {
      if (this.data.size >= this.maxOwners) {
        const oldest = this.data.keys().next().value
        if (oldest !== undefined) this.data.delete(oldest)
      }
      m = new Map()
      this.data.set(id, m)
    }
    m.set(key, JSON.stringify(value))
  }

  dropOwner(ownerKey: string): void {
    for (const id of [...this.data.keys()])
      if (id.startsWith(`${ownerKey}\u0000`)) this.data.delete(id)
  }
}

// ---- Templates -----------------------------------------------------------------------------------------

/** The export type a template belongs to (the scope kind). */
export const TEMPLATE_KINDS = ['server', 'database', 'table', 'result'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]
export const TEMPLATE_OPTIONS_MAX_BYTES = 16 * 1024

export type IoTemplate = {
  kind: TemplateKind
  name: string
  options: Record<string, unknown>
  updatedAt: number
}

export interface IoTemplateStore {
  /** Creates or replaces by name. A new name beyond `MAX_TEMPLATES` for this owner and kind is refused. */
  save(
    ownerKey: string,
    kind: TemplateKind,
    name: string,
    options: Record<string, unknown>,
  ): IoTemplate
  list(ownerKey: string, kind?: TemplateKind): IoTemplate[]
  delete(ownerKey: string, kind: TemplateKind, name: string): boolean
}

/** Validates the parts of a template save; returns the trimmed name and the options. */
export function checkTemplate(kind: string, name: string, options: unknown) {
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) {
    throw new IoStoreError('invalid-kind', 'Unknown template kind')
  }
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (
    trimmed === '' ||
    trimmed.length > MAX_TEMPLATE_NAME ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new IoStoreError('invalid-name', 'Invalid template name')
  }
  const parsed = z.record(z.string().max(64), z.unknown()).safeParse(options)
  if (!parsed.success || JSON.stringify(parsed.data).length > TEMPLATE_OPTIONS_MAX_BYTES) {
    throw new IoStoreError('invalid-value', 'Invalid template options')
  }
  return { kind: kind as TemplateKind, name: trimmed, options: parsed.data }
}

export class MemoryIoTemplates implements IoTemplateStore {
  private data = new Map<string, Map<string, IoTemplate>>() // owner|kind -> name -> template

  constructor(
    private now: () => number = Date.now,
    private maxTemplates = MAX_TEMPLATES,
    private maxOwners = 1000,
  ) {}

  save(
    ownerKey: string,
    kind: TemplateKind,
    name: string,
    options: Record<string, unknown>,
  ): IoTemplate {
    const t = checkTemplate(kind, name, options)
    const id = `${ownerKey}\u0000${t.kind}`
    let m = this.data.get(id)
    if (!m) {
      if (this.data.size >= this.maxOwners) {
        const oldest = this.data.keys().next().value
        if (oldest !== undefined) this.data.delete(oldest)
      }
      m = new Map()
      this.data.set(id, m)
    }
    if (!m.has(t.name) && m.size >= this.maxTemplates) {
      throw new IoStoreError('template-limit', 'Too many templates')
    }
    const saved: IoTemplate = {
      ...t,
      options: JSON.parse(JSON.stringify(t.options)),
      updatedAt: this.now(),
    }
    m.set(t.name, saved)
    return saved
  }

  list(ownerKey: string, kind?: TemplateKind): IoTemplate[] {
    const kinds = kind ? [kind] : TEMPLATE_KINDS
    return kinds
      .flatMap((k) => [...(this.data.get(`${ownerKey}\u0000${k}`)?.values() ?? [])])
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind < b.kind ? -1 : 1))
  }

  delete(ownerKey: string, kind: TemplateKind, name: string): boolean {
    return this.data.get(`${ownerKey}\u0000${kind}`)?.delete(name) ?? false
  }

  dropOwner(ownerKey: string): void {
    for (const id of [...this.data.keys()])
      if (id.startsWith(`${ownerKey}\u0000`)) this.data.delete(id)
  }
}

/** Stateless mode (`DBLOOM_STORE=none`): defaults and templates of a session live here, owner key = session id hash. */
export const memoryIoPrefs = new MemoryIoPrefs()
export const memoryIoTemplates = new MemoryIoTemplates()
