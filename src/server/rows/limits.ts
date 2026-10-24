import {
  DEFAULT_ROW_LIMITS,
  MAX_BULK_ROWS,
  MAX_INSERT_ROWS,
  MAX_PAGE_SIZE,
  type PrefKey,
  type RowLimits,
} from './types'

/**
 * `resolveRowLimits` (FR-ROW-029): each limit is the minimum of the `.env` bound and the user preference;
 * defaults come from `DEFAULT_ROW_LIMITS` until the settings module exists. Preferences only ever lower a
 * bound (exact-count threshold, cell bytes, page size); a value above the bound is clamped, never raised.
 */

export type RowLimitBounds = {
  maxPageSize: number
  exactCountThreshold: number
  viewCountCap: number
  cellBytes: number
  uploadBytes: number
  bulkSize: number
  insertRows: number
}

const intOf = (v: string | undefined, fallback: number, min: number, max: number): number => {
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isInteger(n) && n >= min ? Math.min(n, max) : fallback
}

/** Bounds of the deployment: defaults, lowered by `DBLOOM_ROWS_*` variables (ST-118, ST-115, Q6). */
export function boundsFromEnv(env: NodeJS.ProcessEnv = process.env): RowLimitBounds {
  const d = DEFAULT_ROW_LIMITS
  return {
    maxPageSize: intOf(env.DBLOOM_ROWS_MAX_PAGE_SIZE, d.maxPageSize, 1, MAX_PAGE_SIZE),
    exactCountThreshold: intOf(
      env.DBLOOM_ROWS_EXACT_COUNT_THRESHOLD,
      d.exactCountThreshold,
      0,
      1_000_000_000,
    ),
    viewCountCap: intOf(env.DBLOOM_ROWS_VIEW_COUNT_CAP, d.viewCountCap, 1, 1_000_000_000),
    cellBytes: intOf(env.DBLOOM_ROWS_CELL_BYTES, d.cellBytes, 1024, 16 * 1024 * 1024),
    uploadBytes: intOf(env.DBLOOM_ROWS_UPLOAD_BYTES, d.uploadBytes, 1, 256 * 1024 * 1024),
    bulkSize: intOf(env.DBLOOM_ROWS_BULK_SIZE, d.bulkSize, 1, MAX_BULK_ROWS),
    insertRows: intOf(env.DBLOOM_ROWS_INSERT_ROWS, MAX_INSERT_ROWS, 1, MAX_INSERT_ROWS),
  }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined

export function resolveRowLimits(
  prefs: Partial<Record<PrefKey, unknown>> = {},
  bounds: RowLimitBounds = boundsFromEnv(),
): RowLimits {
  const d = DEFAULT_ROW_LIMITS
  const maxPageSize = bounds.maxPageSize
  const pageSizes = d.pageSizes.filter((s) => s <= maxPageSize)
  if (!pageSizes.includes(maxPageSize) && maxPageSize < d.maxPageSize) pageSizes.push(maxPageSize)
  const pageSize = num(prefs['rows.pageSize'])
  const threshold = num(prefs['rows.countThreshold'])
  const displayChars = num(prefs['rows.displayChars'])
  const insertRows = num(prefs['rows.insertRows'])
  return {
    pageSizes,
    defaultPageSize: Math.min(Math.max(1, pageSize ?? d.defaultPageSize), maxPageSize),
    maxPageSize,
    exactCountThreshold: Math.min(
      bounds.exactCountThreshold,
      Math.max(0, threshold ?? bounds.exactCountThreshold),
    ),
    viewCountCap: bounds.viewCountCap,
    cellBytes: bounds.cellBytes,
    displayChars: Math.min(1000, Math.max(20, displayChars ?? d.displayChars)),
    uploadBytes: bounds.uploadBytes,
    bulkSize: bounds.bulkSize,
    insertRows: Math.min(Math.max(1, insertRows ?? d.insertRows), bounds.insertRows),
  }
}
