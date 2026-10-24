/**
 * The only functions the grid package (C) calls on the server, typed from the frozen contracts so tests can
 * hand in a mock (SPEC 24, FR-ROW-006, 007, 010, 029). `server-api-grid.tsx` builds the real one from
 * package B's server functions; components never import server code themselves.
 */
import type {
  CancelCountInput,
  CountRowsInput,
  CountRowsResponse,
  GetPrefsInput,
  GetRowsInput,
  GetRowsResponse,
  PrefsResponse,
  RowLimitsResponse,
  SetPrefInput,
} from '~/server/rows/types'

export type RowsApi = {
  getRows(input: GetRowsInput): Promise<GetRowsResponse>
  /** Exact count under the statement timeout; cancellable by `cancelCount` with the same request id. */
  countRows(input: CountRowsInput): Promise<CountRowsResponse>
  cancelCount(input: CancelCountInput): Promise<void>
  getLimits(): Promise<RowLimitsResponse>
  getPrefs(input: GetPrefsInput): Promise<PrefsResponse>
  setPref(input: SetPrefInput): Promise<void>
}
