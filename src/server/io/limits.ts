import type { Config } from '../config'
import { COMPRESSIONS, EXPORT_FORMATS, GiB, MiB, type IoLimits } from './types'
import { validateStoredPrefs, type IoPrefValues, type IoPrefsStore } from './store'

/**
 * `resolveIoLimits` (FR-IO-022, section 5.8): each value is the minimum or intersection of the `.env` bound
 * and the user preference; defaults come from this file until the settings module exists. A preference
 * above its bound is clamped, never raised past it.
 */

export type IoLimitBounds = {
  uploadMaxBytes: number
  decompressedMaxBytes: number
  jobMaxMs: number
  exportMaxBytes: number
  concurrentImportsMax: number
  formats: readonly (typeof EXPORT_FORMATS)[number][]
  compressions: readonly (typeof COMPRESSIONS)[number][]
  /** `DBLOOM_IMPORT_DIR` set. */
  serverFolderAvailable: boolean
  /** Whether a user may switch formula neutralisation off (ST-157). */
  formulaOptOut: boolean
  tempQuotaBytes: number
  /** Body limit of a reverse proxy in front, when known (ST-150). */
  proxyBodyBytes?: number
}

export const IO_DEFAULTS = {
  uploadBytes: 64 * MiB,
  decompressedBytes: 1 * GiB,
  jobMs: 900_000,
  maxExportBytes: 1 * GiB,
  concurrentImports: 1,
} as const

/** Floors from file 12 (F column): a preference never goes below them. */
export const IO_FLOORS = {
  uploadBytes: 1 * MiB,
  decompressedBytes: 1 * MiB,
  jobMs: 60_000,
  maxExportBytes: 1 * MiB,
  concurrentImports: 1,
} as const

export const IO_CEILINGS = {
  uploadBytes: 2 * GiB,
  decompressedBytes: 4 * GiB,
  jobMs: 7_200_000,
  maxExportBytes: 8 * GiB,
  concurrentImports: 3,
} as const

export const DEFAULT_TEMP_QUOTA_MIB = 10_240

/** Bounds of the deployment: ceilings, lowered by the `DBLOOM_*` variables that are set. */
export function ioBoundsFromConfig(
  config: Pick<Config, 'tempQuotaMiB' | 'importMaxMiB' | 'importDir'> = {},
): IoLimitBounds {
  const c = IO_CEILINGS
  return {
    uploadMaxBytes: Math.min(c.uploadBytes, (config.importMaxMiB ?? c.uploadBytes / MiB) * MiB),
    decompressedMaxBytes: c.decompressedBytes,
    jobMaxMs: c.jobMs,
    exportMaxBytes: c.maxExportBytes,
    concurrentImportsMax: c.concurrentImports,
    formats: EXPORT_FORMATS,
    compressions: COMPRESSIONS,
    serverFolderAvailable: config.importDir !== undefined,
    formulaOptOut: true,
    tempQuotaBytes: (config.tempQuotaMiB ?? DEFAULT_TEMP_QUOTA_MIB) * MiB,
  }
}

export type IoLimitsResolved = IoLimits & {
  /** Where the effective upload limit comes from, for the text on the import page. */
  uploadLimitedBy: 'default' | 'preference' | 'environment' | 'proxy'
}

const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi))

const pick = <T extends string>(pref: unknown, bound: readonly T[]): T[] => {
  if (!Array.isArray(pref)) return [...bound]
  const chosen = bound.filter((b) => pref.includes(b))
  // An empty choice would disable the page; it falls back to the bound (the UI never sends one).
  return chosen.length > 0 ? chosen : [...bound]
}

export function resolveIoLimits(
  prefs: IoPrefValues = {},
  bounds: IoLimitBounds = ioBoundsFromConfig(),
): IoLimitsResolved {
  const d = IO_DEFAULTS
  const f = IO_FLOORS
  const upPref = int(prefs['io.uploadMiB'])
  const upWanted = upPref !== undefined ? upPref * MiB : d.uploadBytes
  const upBound = Math.min(bounds.uploadMaxBytes, bounds.proxyBodyBytes ?? Infinity)
  const uploadBytes = clamp(upWanted, f.uploadBytes, upBound)
  const uploadLimitedBy: IoLimitsResolved['uploadLimitedBy'] =
    upWanted > upBound
      ? bounds.proxyBodyBytes !== undefined && bounds.proxyBodyBytes < bounds.uploadMaxBytes
        ? 'proxy'
        : 'environment'
      : upPref !== undefined
        ? 'preference'
        : 'default'

  const decPref = int(prefs['io.decompressedMiB'])
  const jobPref = int(prefs['io.jobSeconds'])
  const expPref = int(prefs['io.maxExportMiB'])
  const conPref = int(prefs['io.concurrentImports'])
  return {
    uploadBytes,
    uploadLimitedBy,
    decompressedBytes: clamp(
      decPref !== undefined ? decPref * MiB : d.decompressedBytes,
      f.decompressedBytes,
      bounds.decompressedMaxBytes,
    ),
    jobMs: clamp(jobPref !== undefined ? jobPref * 1000 : d.jobMs, f.jobMs, bounds.jobMaxMs),
    maxExportBytes: clamp(
      expPref !== undefined ? expPref * MiB : d.maxExportBytes,
      f.maxExportBytes,
      bounds.exportMaxBytes,
    ),
    concurrentImports: clamp(
      conPref ?? d.concurrentImports,
      f.concurrentImports,
      bounds.concurrentImportsMax,
    ),
    formats: pick(prefs['io.formats'], bounds.formats),
    compressions: pick(prefs['io.compressions'], bounds.compressions),
    // The user may only switch the folder off (ST-153).
    serverFolderEnabled: bounds.serverFolderAvailable && prefs['io.serverFolder'] !== false,
    formulaNeutralisation: bounds.formulaOptOut
      ? prefs['io.formulaNeutralisation'] !== false
      : true,
    tempQuotaBytes: bounds.tempQuotaBytes,
  }
}

/** Preferences of the owner, with stored values that fail their schema left out (and reported once by the caller). */
export function loadIoPrefs(
  store: IoPrefsStore,
  ownerKey: string,
  targetKey: string,
): { values: IoPrefValues; invalid: string[] } {
  const { values, invalid } = validateStoredPrefs(store.get(ownerKey, targetKey))
  return { values, invalid }
}

/** The limits of one owner: stored preferences inside the bounds of the deployment. */
export function limitsFor(
  store: IoPrefsStore,
  ownerKey: string,
  targetKey: string,
  config: Pick<Config, 'tempQuotaMiB' | 'importMaxMiB' | 'importDir'>,
  overrides: Partial<IoLimitBounds> = {},
): IoLimitsResolved {
  return resolveIoLimits(loadIoPrefs(store, ownerKey, targetKey).values, {
    ...ioBoundsFromConfig(config),
    ...overrides,
  })
}

/** Text for the import page when the effective limit does not come from the user's own choice (FR-IO-022). */
export function uploadLimitNote(
  l: Pick<IoLimitsResolved, 'uploadLimitedBy' | 'uploadBytes'>,
): string {
  const size = formatBytes(l.uploadBytes)
  switch (l.uploadLimitedBy) {
    case 'environment':
      return `Files up to ${size} (limit set by the server administrator).`
    case 'proxy':
      return `Files up to ${size} (limit of the web server in front of DBLoom).`
    default:
      return `Files up to ${size}.`
  }
}

export function formatBytes(n: number): string {
  if (n >= GiB) return `${+(n / GiB).toFixed(1)} GiB`
  if (n >= MiB) return `${+(n / MiB).toFixed(1)} MiB`
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KiB`
  return `${n} B`
}
