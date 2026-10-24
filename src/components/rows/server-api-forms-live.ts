/**
 * The real wiring of `FormsApi` to the server functions of package B. Kept apart from `server-api-forms.ts`
 * so unit tests of the components never load server-function code.
 */
import {
  changeRows,
  confirmRows,
  getRows,
  lookupRows,
  openCell,
  previewRows,
  readCell,
  readRow,
  referencingRows,
} from '~/server/rows.functions'
import { createServerFormsApi, setFormsApi } from './server-api-forms'

export const liveFormsApi = createServerFormsApi({
  getRows,
  readRow,
  readCell,
  openCell,
  lookup: lookupRows,
  referencingRows,
  previewRows,
  changeRows,
  confirmRows,
})

/** Call once when the table tab mounts its editing hooks. */
export const useLiveFormsApi = () => setFormsApi(liveFormsApi)
