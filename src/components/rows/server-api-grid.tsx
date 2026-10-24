import { useMemo } from 'react'
import {
  cancelCount,
  countRows,
  getRowLimits,
  getRows,
  getRowPrefs,
  setRowPref,
} from '~/server/rows.functions'
import { RowsGrid, type RowsGridProps } from './rows-grid'
import type { RowsApi } from './rows-api'

/**
 * The real API of the grid: package B's server functions behind the typed `RowsApi`. This file is the only
 * place of package C that imports server functions, so every test can mount `RowsGrid` with a mock instead.
 */
export const serverRowsApi: RowsApi = {
  getRows: (data) => getRows({ data }),
  countRows: (data) => countRows({ data }),
  cancelCount: async (data) => {
    await cancelCount({ data })
  },
  getLimits: () => getRowLimits(),
  getPrefs: (data) => getRowPrefs({ data }),
  setPref: async (data) => {
    await setRowPref({ data })
  },
}

export function ServerApiGrid(props: Omit<RowsGridProps, 'api'>) {
  const api = useMemo(() => serverRowsApi, [])
  return <RowsGrid {...props} api={api} />
}
