/**
 * The only place the row form, dialogs, pickers and BLOB field get server data from (FR-ROW-026: typed
 * structured data only). The server functions of package B may not exist yet, so the components talk to the
 * small typed interface below; the app wires it once with `setFormsApi(createServerFormsApi({...}))`
 * and tests install a fake with `setFormsApi`.
 */
import { withSessionHeaders } from '~/lib/csrf'
import { t, type MessageKey } from '~/i18n'
import type {
  ChangeRowsInput,
  ChangeRowsResponse,
  ConfirmRowsInput,
  GetRowsInput,
  GetRowsResponse,
  LookupInput,
  LookupResponse,
  OpenCellInput,
  OpenCellResponse,
  PreviewRowsInput,
  PreviewRowsResponse,
  ReadCellInput,
  ReadCellResponse,
  ReadRowInput,
  ReadRowResponse,
  ReferencingRowsInput,
  ReferencingRowsResponse,
  UploadResponse,
} from '~/server/rows/types'
import { describeRefusal, type Refusal } from '~/components/structure/refusal'

export type FormsApi = {
  /** Used for the table model of a referenced table ("Create new row...") and nothing else. */
  getRows(input: GetRowsInput): Promise<GetRowsResponse>
  readRow(input: ReadRowInput): Promise<ReadRowResponse>
  readCell(input: ReadCellInput): Promise<ReadCellResponse>
  openCell(input: OpenCellInput): Promise<OpenCellResponse>
  lookup(input: LookupInput): Promise<LookupResponse>
  referencingRows(input: ReferencingRowsInput): Promise<ReferencingRowsResponse>
  previewRows(input: PreviewRowsInput): Promise<PreviewRowsResponse>
  changeRows(input: ChangeRowsInput): Promise<ChangeRowsResponse>
  confirmRows(input: ConfirmRowsInput): Promise<ChangeRowsResponse>
  /** `POST /api/rows/upload` (FR-ROW-012): stages the bytes on the server, returns an upload id. */
  uploadFile(file: File): Promise<UploadResponse>
}

/** A TanStack server function as the components call it: `fn({ data })`. */
type ServerFn<I, O> = (args: { data: I }) => Promise<O>

export type ServerFormsFns = {
  getRows: ServerFn<GetRowsInput, GetRowsResponse>
  readRow: ServerFn<ReadRowInput, ReadRowResponse>
  readCell: ServerFn<ReadCellInput, ReadCellResponse>
  openCell: ServerFn<OpenCellInput, OpenCellResponse>
  lookup: ServerFn<LookupInput, LookupResponse>
  referencingRows: ServerFn<ReferencingRowsInput, ReferencingRowsResponse>
  previewRows: ServerFn<PreviewRowsInput, PreviewRowsResponse>
  changeRows: ServerFn<ChangeRowsInput, ChangeRowsResponse>
  confirmRows: ServerFn<ConfirmRowsInput, ChangeRowsResponse>
}

/** Transport of the upload; kept as one small function so the route contract is easy to adjust. */
export async function postUpload(file: File): Promise<UploadResponse> {
  const headers = withSessionHeaders({
    'content-type': file.type || 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name),
  })
  const response = await fetch('/api/rows/upload', { method: 'POST', headers, body: file })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    // Same shape as a refusal (`code: message`) so describeRowsRefusal can translate it.
    throw new Error(`${body?.error ?? 'upload-failed'}: upload failed (${response.status})`)
  }
  return (await response.json()) as UploadResponse
}

export function createServerFormsApi(
  fns: ServerFormsFns,
  upload: (file: File) => Promise<UploadResponse> = postUpload,
): FormsApi {
  return {
    getRows: (data) => fns.getRows({ data }),
    readRow: (data) => fns.readRow({ data }),
    readCell: (data) => fns.readCell({ data }),
    openCell: (data) => fns.openCell({ data }),
    lookup: (data) => fns.lookup({ data }),
    referencingRows: (data) => fns.referencingRows({ data }),
    previewRows: (data) => fns.previewRows({ data }),
    changeRows: (data) => fns.changeRows({ data }),
    confirmRows: (data) => fns.confirmRows({ data }),
    uploadFile: upload,
  }
}

const notWired = (): never => {
  throw new Error('rows server functions are not wired (setFormsApi)')
}

let current: FormsApi = {
  getRows: notWired,
  readRow: notWired,
  readCell: notWired,
  openCell: notWired,
  lookup: notWired,
  referencingRows: notWired,
  previewRows: notWired,
  changeRows: notWired,
  confirmRows: notWired,
  uploadFile: postUpload,
}

export function setFormsApi(api: FormsApi): void {
  current = api
}

/** Read at call time, so a test can swap the implementation between renders. */
export const formsApi = (): FormsApi => current

// ---- Refusals -------------------------------------------------------------------------------------------

const ROW_REFUSALS: Record<string, MessageKey> = {
  'no-identity': 'rows.form.refusal.noIdentity',
  'unknown-column': 'rows.form.refusal.unknownColumn',
  'unknown-table': 'rows.form.refusal.unknownTable',
  'invalid-value': 'rows.form.refusal.invalidValue',
  'operator-not-allowed': 'rows.form.refusal.operator',
  'bulk-limit': 'rows.form.refusal.bulkLimit',
  'unknown-upload': 'rows.form.refusal.unknownUpload',
  'plan-missing': 'rows.form.refusal.planMissing',
  'not-editable': 'rows.form.refusal.notEditable',
  'view-read-only': 'rows.form.refusal.viewReadOnly',
  'too-large': 'rows.blob.tooLargeServer',
  'upload-failed': 'rows.blob.uploadFailed',
}

/** Codes after which a fresh attempt from the current state is the way forward. */
const RETRY_CODES = new Set(['plan-missing', 'token-expired', 'token-used', 'plan_expired'])

/**
 * Error of a rows server function as text for people. Rows codes get their own strings, the shared codes
 * (read-only, token errors, timeout) come from the structure mapper, any other error shows its own text.
 */
export function describeRowsRefusal(error: unknown): Refusal {
  const base = describeRefusal(error)
  const key = base.code ? ROW_REFUSALS[base.code] : undefined
  const message = key ? t(key) : base.message
  return {
    ...base,
    message,
    offerNewPreview: base.offerNewPreview || RETRY_CODES.has(base.code ?? ''),
  }
}
