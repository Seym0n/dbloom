/** Export formats; a separate file with no imports because the client chunk of `audit.functions.ts` needs the list (zod enum). */
export type ExportFormat = 'csv' | 'ndjson'
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'ndjson']
