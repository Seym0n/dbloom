/**
 * Export part of the io server functions (FR-IO-001/002/009/011/021): job start, polling, cancel, capabilities,
 * templates and defaults. Thin wrappers in `export.functions.ts` call these with the environment of the session;
 * tests call them with a hand-made environment. Audit lines carry names, counts and outcome only.
 */
import { createReadStream } from 'node:fs'
import { z, ZodError } from 'zod'
import { auditIo } from '../audit'
import type { TargetPool } from '../db/target-pool'
import { StructureRefusal } from '../structure/errors'
import { readServerInfo } from '../structure/introspect'
import { COMMON_CHARSETS } from './charset'
import { ExportRefusal, checkExportRequest, runExport, type ExportOutcome } from './export'
import { JobError, isTerminal, type JobRegistry, type SpoolSource } from './jobs'
import { ioBoundsFromConfig, type IoLimitsResolved } from './limits'
import {
  IoStoreError,
  checkTemplate,
  setIoPref,
  validateStoredPrefs,
  type IoPrefKey,
  type IoPrefsStore,
  type IoTemplateStore,
  type TemplateKind,
} from './store'
import type { TempStore } from './temp'
import type { ResultStream } from '../sql/export-source'
import {
  TEXT_VIEW_MAX_BYTES,
  compression,
  csvExportOptions,
  ioFormat,
  jsonExportOptions,
  sqlExportOptions,
  type Compression,
  type ExportRequest,
  type IoCapabilities,
  type IoFormat,
  type IoJob,
  type JobResult,
} from './types'

// ---- Environment ---------------------------------------------------------------------------------------------

export type ExportServiceEnv = {
  pool: TargetPool
  temp: TempStore
  jobs: JobRegistry
  /** Session and DBLoom user (owner key as in sql-tab); also the key of prefs and templates. */
  owner: { sessionId: string; user: string }
  limits: IoLimitsResolved
  /** Administrator allows users to switch formula neutralisation off (ST-157). */
  mayDisableFormulaNeutralisation: boolean
  prefs: IoPrefsStore
  templates: IoTemplateStore
  /** `host:port` for audit lines and the prefs key. */
  targetLabel: string
  /** Host part, for `@SERVER@`. */
  serverName: string
  httpHost?: string
  /** FR-SQL-026 hook bound to the session; absent when the SQL tab is disabled. */
  openResult?: (req: { db?: string; text: string; statementIndex: number; timeoutMs: number }) => Promise<ResultStream>
}

/** Plain `code: message` error the client shows (same style as the other server functions). */
export function ioClientError(e: unknown): Error {
  if (e instanceof ExportRefusal) return new Error(`${e.code}: ${e.message}`)
  if (e instanceof JobError)
    return new Error(e.code === 'busy' ? `busy: ${e.message}` : 'invalid_request: Unknown job')
  if (e instanceof IoStoreError) return new Error(`invalid_request: ${e.message}`)
  if (e instanceof ZodError) return new Error('invalid_request: The request is not valid')
  if (e instanceof StructureRefusal) return new Error(`${e.code}: ${e.message}`)
  return new Error('export_failed: The request could not be handled')
}

// ---- Start ---------------------------------------------------------------------------------------------------

const MAX_SPOOLS_PER_OWNER = 4
const spools = new Map<string, string[]>()

/** Keeps the newest spool files of an owner; older finished exports are removed to stay inside the per-owner file limit. */
async function trackSpool(env: ExportServiceEnv, id: string): Promise<void> {
  const list = spools.get(env.owner.user) ?? []
  list.push(id)
  while (list.length > MAX_SPOOLS_PER_OWNER) await env.temp.remove(list.shift() as string)
  spools.set(env.owner.user, list)
}

/** For tests. */
export function resetExportState(): void {
  spools.clear()
}

const dbOf = (req: ExportRequest): string | undefined =>
  req.scope.kind === 'database' || req.scope.kind === 'table' ? req.scope.db : req.scope.kind === 'result' ? req.scope.db : undefined

const objectsOf = (req: ExportRequest): string | undefined => {
  const s = req.scope
  const list = s.kind === 'database' ? s.tables : s.kind === 'server' ? s.databases : s.kind === 'table' ? [s.table] : undefined
  return list === undefined ? undefined : list.slice(0, 50).join(',').slice(0, 500)
}

export async function startExportImpl(env: ExportServiceEnv, req: ExportRequest): Promise<{ jobId: string }> {
  checkExportRequest(req, env.limits)
  if (req.scope.kind === 'result' && !env.openResult)
    throw new ExportRefusal('invalid_request', 'Exporting a result is not available here')
  const job = env.jobs.create(env.owner, 'export')
  void runJob(env, job.id, req)
  return { jobId: job.id }
}

function spoolSource(outcome: ExportOutcome): SpoolSource {
  const file = outcome.file!
  return {
    fileName: outcome.fileName as string,
    contentType: outcome.contentType as string,
    size: () => (outcome.textView ? Math.min(file.bytes, TEXT_VIEW_MAX_BYTES) : file.bytes),
    open: () =>
      createReadStream(file.path, outcome.textView ? { start: 0, end: Math.max(0, TEXT_VIEW_MAX_BYTES - 1) } : {}),
  }
}

const failedOutcome = (message: string): ExportOutcome => ({
  state: 'failed',
  textView: false,
  result: {
    skipped: [],
    rejected: [],
    rejectedCount: 0,
    notes: [],
    error: { code: 'export_failed', message },
    durationMs: 0,
  } satisfies JobResult,
})

async function runJob(env: ExportServiceEnv, id: string, req: ExportRequest): Promise<void> {
  const { jobs, owner } = env
  const base = { user: owner.user, target: env.targetLabel, jobId: id }
  const started = Date.now()
  let outcome: ExportOutcome
  try {
    jobs.start(id)
    auditIo('io.export.start', {
      ...base,
      kind: 'export',
      scope: req.scope.kind,
      format: req.format,
      compression: req.compression,
      db: dbOf(req),
      objects: objectsOf(req),
    })
    const csv = req.format === 'csv' ? (req.options as { neutraliseFormulas?: boolean }) : undefined
    outcome = await runExport({
      pool: env.pool,
      temp: env.temp,
      owner: env.owner,
      request: req,
      limits: { maxExportBytes: env.limits.maxExportBytes, jobMs: env.limits.jobMs },
      signal: jobs.signal(id),
      serverLabel: env.serverName,
      httpHost: env.httpHost,
      neutraliseFormulas: env.mayDisableFormulaNeutralisation
        ? (csv?.neutraliseFormulas ?? env.limits.formulaNeutralisation)
        : true,
      openResult: env.openResult
        ? (r) => env.openResult!({ ...r, timeoutMs: env.limits.jobMs })
        : undefined,
      onProgress: (p) => jobs.progress(id, p),
      onCancel: (hook) => jobs.setCancelHook(id, hook),
    })
  } catch {
    outcome = failedOutcome('The export failed')
  }
  const state = jobs.stateOf(id)
  if (state !== undefined && isTerminal(state)) {
    // cancelled while it finished: the output is not offered
    if (outcome.file) await env.temp.remove(outcome.file.id)
  } else if (state !== undefined) {
    if (outcome.file) {
      jobs.setOutput(id, spoolSource(outcome))
      await trackSpool(env, outcome.file.id)
    }
    try {
      jobs.finish(id, outcome.state, outcome.result)
    } catch {
      // the job was removed or cancelled in between
    }
  }
  const final = jobs.get(id, owner)
  auditIo('io.export.end', {
    ...base,
    kind: 'export',
    format: req.format,
    compression: req.compression,
    fileName: outcome.fileName,
    bytes: outcome.file?.bytes,
    rows: outcome.result.rows,
    state: final?.state ?? outcome.state,
    errorCode: outcome.result.error?.code,
    errno: outcome.result.error?.errno,
    durationMs: Date.now() - started,
  })
}

// ---- Poll, cancel ----------------------------------------------------------------------------------------------

export function getJobImpl(env: ExportServiceEnv, jobId: string): IoJob {
  const job = env.jobs.get(jobId, env.owner)
  if (!job) throw new ExportRefusal('invalid_request', 'Unknown job')
  return job
}

export async function cancelJobImpl(env: ExportServiceEnv, jobId: string): Promise<IoJob> {
  const job = await env.jobs.cancel(jobId, env.owner)
  auditIo('io.job.cancel', { user: env.owner.user, target: env.targetLabel, jobId, kind: job.kind, state: job.state })
  return job
}

// ---- Capabilities -------------------------------------------------------------------------------------------------

export async function getIoCapabilitiesImpl(env: ExportServiceEnv): Promise<IoCapabilities> {
  const info = await readServerInfo(env.pool)
  const l = env.limits
  return {
    formats: l.formats,
    compressions: l.compressions,
    limits: {
      uploadBytes: l.uploadBytes,
      decompressedBytes: l.decompressedBytes,
      jobMs: l.jobMs,
      maxExportBytes: l.maxExportBytes,
      serverFolderEnabled: l.serverFolderEnabled,
      formulaNeutralisation: l.formulaNeutralisation,
      mayDisableFormulaNeutralisation: env.mayDisableFormulaNeutralisation,
    },
    charsets: COMMON_CHARSETS.map((name) => ({ name, label: name })),
    target: { product: info.product, version: info.version },
  }
}

// ---- Defaults (FR-IO-011) ------------------------------------------------------------------------------------------

const SCOPE_KEYS = ['server', 'database', 'table', 'result'] as const
type ScopeKey = (typeof SCOPE_KEYS)[number]

/** Shape the client works with (`src/lib/io/api.ts`); kept here as a server contract, not imported at run time. */
export type IoPrefsView = {
  mode: 'quick' | 'custom'
  exportFormat: IoFormat
  exportCompression: Compression
  importFormat: IoFormat
  fileNameTemplates: Partial<Record<ScopeKey, string>>
  dragDrop: boolean
}

export const ioPrefsPatch = z
  .object({
    mode: z.enum(['quick', 'custom']),
    exportFormat: ioFormat,
    exportCompression: compression,
    importFormat: ioFormat,
    fileNameTemplates: z.partialRecord(z.enum(SCOPE_KEYS), z.string().max(120)),
    dragDrop: z.boolean(),
  })
  .partial()
  .strict()

const DEFAULTS: IoPrefsView = {
  mode: 'quick',
  exportFormat: 'sql',
  exportCompression: 'none',
  importFormat: 'sql',
  fileNameTemplates: {},
  dragDrop: true,
}

export function getIoPrefsImpl(env: ExportServiceEnv): IoPrefsView {
  const { values, invalid } = validateStoredPrefs(env.prefs.get(env.owner.user, env.targetLabel))
  const fixed: Partial<Record<IoPrefKey, unknown>> = {
    'io.mode': DEFAULTS.mode,
    'io.exportFormat': DEFAULTS.exportFormat,
    'io.exportCompression': DEFAULTS.exportCompression,
    'io.importFormat': DEFAULTS.importFormat,
    'io.dragDrop': DEFAULTS.dragDrop,
  }
  // A stored value that fails its schema is replaced by the built-in default, visibly (FR-UPD-004).
  for (const key of invalid) {
    if (key in fixed) setIoPref(env.prefs, env.owner.user, env.targetLabel, key, fixed[key])
  }
  const enabledFormat = (f: IoFormat | undefined, fallback: IoFormat): IoFormat =>
    f !== undefined && env.limits.formats.includes(f) ? f : (env.limits.formats[0] ?? fallback)
  const enabledComp = (c: Compression | undefined): Compression =>
    c !== undefined && env.limits.compressions.includes(c) ? c : 'none'
  const templates: Partial<Record<ScopeKey, string>> = {}
  for (const s of SCOPE_KEYS) {
    const t = values[`io.fileName.${s}` as IoPrefKey]
    if (typeof t === 'string') templates[s] = t
  }
  return {
    mode: (values['io.mode'] as IoPrefsView['mode'] | undefined) ?? DEFAULTS.mode,
    exportFormat: enabledFormat(values['io.exportFormat'] as IoFormat | undefined, DEFAULTS.exportFormat),
    exportCompression: enabledComp(values['io.exportCompression'] as Compression | undefined),
    importFormat: enabledFormat(values['io.importFormat'] as IoFormat | undefined, DEFAULTS.importFormat),
    fileNameTemplates: templates,
    dragDrop: (values['io.dragDrop'] as boolean | undefined) ?? DEFAULTS.dragDrop,
  }
}

export function setIoPrefsImpl(env: ExportServiceEnv, patch: z.infer<typeof ioPrefsPatch>): IoPrefsView {
  const put = (key: IoPrefKey, value: unknown) => setIoPref(env.prefs, env.owner.user, env.targetLabel, key, value)
  if (patch.mode !== undefined) put('io.mode', patch.mode)
  if (patch.exportFormat !== undefined) put('io.exportFormat', patch.exportFormat)
  if (patch.exportCompression !== undefined) put('io.exportCompression', patch.exportCompression)
  if (patch.importFormat !== undefined) put('io.importFormat', patch.importFormat)
  if (patch.dragDrop !== undefined) put('io.dragDrop', patch.dragDrop)
  for (const s of SCOPE_KEYS) {
    const t = patch.fileNameTemplates?.[s]
    if (t !== undefined) put(`io.fileName.${s}` as IoPrefKey, t)
  }
  return getIoPrefsImpl(env)
}

// ---- Templates (FR-IO-011) ------------------------------------------------------------------------------------------
// The store keys a template by (owner, kind, name). The client names a template per export format, so each
// format owns one fixed key bucket; the limit of 50 therefore applies per format.

const KIND_OF_FORMAT: Record<IoFormat, TemplateKind> = { sql: 'server', csv: 'database', json: 'table' }
const FORMAT_OF_KIND: Partial<Record<TemplateKind, IoFormat>> = { server: 'sql', database: 'csv', table: 'json' }
const OPTION_SCHEMA = { sql: sqlExportOptions, csv: csvExportOptions, json: jsonExportOptions } as const

export const templateInput = z.object({ name: z.string().min(1).max(120), format: ioFormat, options: z.record(z.string().max(64), z.unknown()) }).strict()
export const templateKey = z.object({ name: z.string().min(1).max(120), format: ioFormat }).strict()
export type TemplateInput = z.infer<typeof templateInput>
export type TemplateView = { name: string; format: IoFormat; options: Record<string, string | number | boolean> }

export function listTemplatesImpl(env: ExportServiceEnv): TemplateView[] {
  return env.templates
    .list(env.owner.user)
    .flatMap((t) => {
      const format = FORMAT_OF_KIND[t.kind]
      return format ? [{ name: t.name, format, options: t.options as TemplateView['options'] }] : []
    })
    .sort((a, b) => (a.format === b.format ? a.name.localeCompare(b.name) : a.format < b.format ? -1 : 1))
}

export function saveTemplateImpl(env: ExportServiceEnv, t: TemplateInput): { ok: true } {
  const parsed = OPTION_SCHEMA[t.format].safeParse(t.options)
  if (!parsed.success) throw new ExportRefusal('invalid_request', 'The template options are not valid for this format')
  const checked = checkTemplate(KIND_OF_FORMAT[t.format], t.name, parsed.data)
  env.templates.save(env.owner.user, checked.kind, checked.name, checked.options)
  return { ok: true }
}

export function deleteTemplateImpl(env: ExportServiceEnv, key: { name: string; format: IoFormat }): { ok: true } {
  env.templates.delete(env.owner.user, KIND_OF_FORMAT[key.format], key.name.trim())
  return { ok: true }
}

// ---- Limits bounds (re-exported for the environment builder) --------------------------------------------------------

export { ioBoundsFromConfig }
