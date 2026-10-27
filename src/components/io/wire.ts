/** Real catalog and server functions for the io screens: the browse, structure and io server functions behind the shell. */
import { getDatabases, getTables } from '~/server/browse.functions'
import { getTableDefinition, previewStructure } from '~/server/structure.functions'
import {
  cancelJob,
  deleteTemplate,
  getIoCapabilities,
  getIoPrefs,
  getJob,
  listTemplates,
  saveTemplate,
  setIoPrefs,
  startExport,
} from '~/server/io/export.functions'
import {
  analyseImport,
  listImportFolder,
  resumeImport,
  startImport,
} from '~/server/import.functions'
import { createServerIoApi, setIoApi, setIoCatalog, type ServerIoFns } from '~/lib/io/api'

let wired = false

export function wireIoCatalog(): void {
  if (wired) return
  wired = true
  setIoCatalog({
    databases: async () => (await getDatabases()).map((d) => d.name),
    tables: async (db) =>
      (await getTables({ data: { db } })).map((x) => ({
        name: x.name,
        kind: x.kind === 'view' ? ('view' as const) : ('table' as const),
      })),
    columns: async (db, table) =>
      (await getTableDefinition({ data: { db, table } })).def.columns.map((c) => ({
        name: c.name,
        type: c.type,
        ...(c.generated ? { generated: true } : {}),
      })),
  })
  const fns: ServerIoFns = {
    getIoCapabilities: () => getIoCapabilities(),
    startExport,
    getJob,
    cancelJob,
    analyseImport,
    startImport,
    resumeImport,
    listImportFolder: () => listImportFolder(),
    listTemplates: () => listTemplates(),
    saveTemplate,
    deleteTemplate,
    getIoPrefs: () => getIoPrefs(),
    setIoPrefs,
    previewNewTable: async ({ data }) => {
      const plan = await previewStructure({ data: { action: 'createTable', table: data } })
      return { statements: plan.statements.map((s) => s.sql) }
    },
  }
  setIoApi(createServerIoApi(fns))
}
