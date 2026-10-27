/** In-memory stand-in for the io server functions: lets the screens run before the server side exists. */
import type { ImportAnalysis, IoCapabilities, IoJob, JobProgress } from '~/server/io/types'
import { GiB, MiB } from '~/server/io/types'
import type { ExportTemplate, IoApi, IoPrefs } from './api'

const CAPS: IoCapabilities = {
  formats: ['sql', 'csv', 'json'],
  compressions: ['none', 'gzip', 'zip'],
  limits: {
    uploadBytes: 64 * MiB,
    decompressedBytes: GiB,
    jobMs: 900_000,
    maxExportBytes: GiB,
    serverFolderEnabled: false,
    formulaNeutralisation: true,
    mayDisableFormulaNeutralisation: true,
  },
  charsets: [
    { name: 'utf-8', label: 'Unicode (UTF-8)' },
    { name: 'windows-1252', label: 'Western (Windows-1252)' },
    { name: 'iso-8859-1', label: 'Western (ISO-8859-1)' },
    { name: 'shift_jis', label: 'Japanese (Shift_JIS)' },
  ],
  target: { product: 'mysql', version: '8.4.0' },
}

type MockJob = { kind: 'export' | 'import'; startedAt: number; cancelled?: boolean }

export function createMockIoApi(now: () => number = Date.now, durationMs = 1500): IoApi {
  const jobs = new Map<string, MockJob>()
  const templates: ExportTemplate[] = []
  let prefs: IoPrefs = {
    mode: 'quick',
    exportFormat: 'sql',
    exportCompression: 'none',
    importFormat: 'sql',
    fileNameTemplates: {},
    dragDrop: true,
  }
  let seq = 0
  const start = (kind: 'export' | 'import') => {
    seq += 1
    const jobId = `mock-job-${seq}-${kind}`
    jobs.set(jobId, { kind, startedAt: now() })
    return { jobId }
  }
  return {
    getCapabilities: async () => CAPS,
    startExport: async () => start('export'),
    getJob: async (jobId): Promise<IoJob> => {
      const job = jobs.get(jobId)
      if (!job) throw new Error('invalid_request: unknown job')
      const fraction = Math.min(1, (now() - job.startedAt) / durationMs)
      const progress: JobProgress = {
        bytes: Math.round(fraction * 1_000_000),
        totalBytes: 1_000_000,
        rows: Math.round(fraction * 1000),
        object: { index: Math.min(3, Math.floor(fraction * 3) + 1), total: 3, name: 'customer' },
      }
      const common = { id: jobId, kind: job.kind, progress, startedAt: job.startedAt }
      if (job.cancelled) return { ...common, state: 'cancelled', endedAt: now() }
      if (fraction < 1) return { ...common, state: 'running' }
      return {
        ...common,
        state: 'done',
        result: {
          fileName: 'export.sql',
          skipped: [],
          rejected: [],
          rejectedCount: 0,
          notes: [],
          statements: { run: 1018, skipped: 0, failed: 0 },
          rows: 1000,
          durationMs,
        },
        endedAt: job.startedAt + durationMs,
      }
    },
    cancelJob: async (jobId) => {
      const job = jobs.get(jobId)
      if (job) job.cancelled = true
    },
    readText: async () => ({ text: '-- DBLoom mock export\nSELECT 1;\n', truncated: false }),
    analyseImport: async ({ uploadId, format, charset }): Promise<ImportAnalysis> => {
      const base = {
        uploadId,
        analysisHash: 'mock',
        fileName: `${uploadId}.${format}`,
        bytes: 1024,
        compression: 'none' as const,
        format,
        charset: charset ?? 'utf-8',
        confirmRequired: false,
      }
      if (format === 'sql')
        return {
          ...base,
          statements: {
            total: 3,
            byClass: { none: 2, soft: 1, hard: 0, refused: 0 },
            hardKinds: {},
            refusedKinds: {},
            createsDatabases: [],
            dropsDatabases: [],
            usesDatabase: false,
            needsDatabase: true,
          },
        }
      return {
        ...base,
        rows: { columns: ['id', 'name'], sample: [['1', 'Ada']], rowCount: 1, warnings: [] },
      }
    },
    startImport: async () => start('import'),
    resumeImport: async () => start('import'),
    listImportFolder: async () => [],
    listTemplates: async () => [...templates],
    saveTemplate: async (tpl) => {
      const i = templates.findIndex((x) => x.name === tpl.name && x.format === tpl.format)
      if (i >= 0) templates[i] = tpl
      else templates.push(tpl)
    },
    deleteTemplate: async ({ format, name }) => {
      const i = templates.findIndex((x) => x.name === name && x.format === format)
      if (i >= 0) templates.splice(i, 1)
    },
    getPrefs: async () => prefs,
    setPrefs: async (patch) => {
      prefs = { ...prefs, ...patch }
      return prefs
    },
    previewNewTable: async (def) => ({
      statements: [`CREATE TABLE \`${def.db}\`.\`${def.name}\` (...)`],
    }),
  }
}
