/**
 * The only place the io screens get server data from. The server functions of module `io` (names fixed in
 * `server/io/types.ts`, IO_SERVER_FUNCTIONS) do not exist yet, so the components talk to the small typed
 * interface below. The app wires it once with `setIoApi(createServerIoApi({...}))`; until then a mock
 * (`mock-api.ts`) answers, and tests install fakes with `setIoApi`.
 */
import { withConnectionParam, withSessionHeaders } from '~/lib/csrf'
import type {
  Compression,
  ExportRequest,
  ImportAnalysis,
  IoCapabilities,
  IoFormat,
  IoJob,
  RowImportOptions,
  StartImportRequest,
} from '~/server/io/types'
import { TEXT_VIEW_MAX_BYTES } from '~/server/io/types'
import type { TableDefinition } from '~/server/structure/types'
import { createMockIoApi } from './mock-api'

export type OptionValue = string | number | boolean
export type OptionValues = Record<string, OptionValue>

export type JobRef = { jobId: string }

export type ExportTemplate = { name: string; format: IoFormat; options: OptionValues }

export type ExportScopeKey = 'server' | 'database' | 'table' | 'result'

export type IoPrefs = {
  mode: 'quick' | 'custom'
  exportFormat: IoFormat
  exportCompression: Compression
  importFormat: IoFormat
  /** File name template per scope (FR-IO-011). */
  fileNameTemplates: Partial<Record<ExportScopeKey, string>>
  /** Drop files on the navigation panel (FR-IO-025). */
  dragDrop: boolean
}

export const DEFAULT_PREFS: IoPrefs = {
  mode: 'quick',
  exportFormat: 'sql',
  exportCompression: 'none',
  importFormat: 'sql',
  fileNameTemplates: {},
  dragDrop: true,
}

export type FolderFile = { id: string; name: string; bytes: number }

export type IoApi = {
  getCapabilities(): Promise<IoCapabilities>
  startExport(req: ExportRequest): Promise<JobRef>
  getJob(jobId: string): Promise<IoJob>
  cancelJob(jobId: string): Promise<void>
  /** Text of a finished `view: 'text'` export, at most TEXT_VIEW_MAX_BYTES (FR-IO-009). */
  readText(jobId: string): Promise<{ text: string; truncated: boolean }>
  analyseImport(req: {
    uploadId: string
    format: IoFormat
    charset?: string
    rowOptions?: RowImportOptions
  }): Promise<ImportAnalysis>
  startImport(req: StartImportRequest): Promise<JobRef>
  resumeImport(jobId: string): Promise<JobRef>
  listImportFolder(): Promise<FolderFile[]>
  listTemplates(): Promise<ExportTemplate[]>
  saveTemplate(template: ExportTemplate): Promise<void>
  deleteTemplate(input: { format: IoFormat; name: string }): Promise<void>
  getPrefs(): Promise<IoPrefs>
  setPrefs(prefs: Partial<IoPrefs>): Promise<IoPrefs>
  /** SQL of the CREATE TABLE of a new-table import, from the structure builder (FR-IO-019). */
  previewNewTable(def: TableDefinition): Promise<{ statements: string[] }>
}

/** A TanStack server function as the components call it: `fn({ data })`. */
type ServerFn<I, O> = (args: { data: I }) => Promise<O>
type NoArgFn<O> = (args?: unknown) => Promise<O>

export type ServerIoFns = {
  getIoCapabilities: NoArgFn<IoCapabilities>
  startExport: ServerFn<ExportRequest, JobRef>
  getJob: ServerFn<{ jobId: string }, IoJob>
  cancelJob: ServerFn<{ jobId: string }, unknown>
  analyseImport: ServerFn<
    { uploadId: string; format: IoFormat; charset?: string; rowOptions?: RowImportOptions },
    ImportAnalysis
  >
  startImport: ServerFn<StartImportRequest, JobRef>
  resumeImport: ServerFn<{ jobId: string }, JobRef>
  listImportFolder: NoArgFn<FolderFile[]>
  listTemplates: NoArgFn<ExportTemplate[]>
  saveTemplate: ServerFn<ExportTemplate, unknown>
  deleteTemplate: ServerFn<{ format: IoFormat; name: string }, unknown>
  getIoPrefs: NoArgFn<IoPrefs>
  setIoPrefs: ServerFn<Partial<IoPrefs>, IoPrefs>
  /** Not in the frozen list: preview of the structure module for a new table (FR-IO-019). */
  previewNewTable: ServerFn<TableDefinition, { statements: string[] }>
}

export const downloadUrl = (jobId: string) => withConnectionParam(`/api/io/download/${encodeURIComponent(jobId)}`)

async function fetchText(jobId: string): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(downloadUrl(jobId), { headers: withSessionHeaders() })
  if (!response.ok) throw new Error(`export_failed: download failed (${response.status})`)
  const text = await response.text()
  return { text, truncated: new TextEncoder().encode(text).length >= TEXT_VIEW_MAX_BYTES }
}

export function createServerIoApi(fns: ServerIoFns, readText = fetchText): IoApi {
  return {
    getCapabilities: () => fns.getIoCapabilities(),
    startExport: (data) => fns.startExport({ data }),
    getJob: (jobId) => fns.getJob({ data: { jobId } }),
    cancelJob: async (jobId) => {
      await fns.cancelJob({ data: { jobId } })
    },
    readText,
    analyseImport: (data) => fns.analyseImport({ data }),
    startImport: (data) => fns.startImport({ data }),
    resumeImport: (jobId) => fns.resumeImport({ data: { jobId } }),
    listImportFolder: () => fns.listImportFolder(),
    listTemplates: () => fns.listTemplates(),
    saveTemplate: async (data) => {
      await fns.saveTemplate({ data })
    },
    deleteTemplate: async (data) => {
      await fns.deleteTemplate({ data })
    },
    getPrefs: () => fns.getIoPrefs(),
    setPrefs: (data) => fns.setIoPrefs({ data }),
    previewNewTable: (data) => fns.previewNewTable({ data }),
  }
}

let current: IoApi = createMockIoApi()

export function setIoApi(api: IoApi): void {
  current = api
}

/** Read at call time, so a test can swap the implementation between renders. */
export const ioApi = (): IoApi => current

// ---- Catalog (databases, tables, columns) ------------------------------------------------------------

export type IoCatalog = {
  databases(): Promise<string[]>
  tables(db: string): Promise<{ name: string; kind: 'table' | 'view' }[]>
  columns(db: string, table: string): Promise<{ name: string; type: string; generated?: boolean }[]>
}

let catalog: IoCatalog = {
  databases: async () => [],
  tables: async () => [],
  columns: async () => [],
}

/** The shell wires the real catalog (browse and structure server functions) once. */
export function setIoCatalog(value: IoCatalog): void {
  catalog = value
}
export const ioCatalog = (): IoCatalog => catalog
