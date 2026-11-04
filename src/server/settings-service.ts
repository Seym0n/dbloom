/**
 * Administrator side of the settings page (SPEC/32 FR-ASE-005): role check, step-up, then the writer. Reading needs the
 * administrator role only; every write and reset also needs a recent factor (purpose `settings.write`). A refusal of the
 * writer is an answer (`{ ok: false, error }`), not a thrown error: the page shows it next to the row. Authentication
 * failures (`auth_failed`, `stepup_required`) are thrown as `AuthError`, like every other admin function.
 */
import { AuthError, type AccountContext, type AccountStore, type SettingDescription, type StepUp } from './auth/types'
import { SettingsError, type SettingsErrorCode, type SettingsWriter } from './auth/settings-write'

export type SettingsRefusal = { code: SettingsErrorCode; detail?: string; count?: number }
export type SettingsAnswer = { ok: true; changed: boolean; updatedAt: number | null } | { ok: false; error: SettingsRefusal }
export type PreviewAnswer = { ok: true; strandedUsers: number } | { ok: false; error: SettingsRefusal }
export type SettingsView = { settings: SettingDescription[] }

export type SettingsServiceDeps = {
  store: Pick<AccountStore, 'getUser'>
  writer: SettingsWriter
  describe: () => SettingDescription[]
  stepUp: Pick<StepUp, 'requireRecentFactor'>
  /** Account mode only: direct and stateless installs have no administrators and no store to write. */
  mode: () => 'account' | 'direct' | 'setup' | 'stateless'
}

export interface SettingsService {
  get(ctx: AccountContext): SettingsView
  set(ctx: AccountContext, key: string, value: unknown, basedOn: number | null): SettingsAnswer
  reset(ctx: AccountContext, key: string, basedOn: number | null): SettingsAnswer
  preview(ctx: AccountContext, key: string, value: unknown): PreviewAnswer
}

export const SETTINGS_STEP_UP_PURPOSE = 'settings.write'

export function createSettingsService(d: SettingsServiceDeps): SettingsService {
  /** Active administrator of a `full` session whose row still says so, in account mode; else `auth_failed`. */
  const adminOf = (ctx: AccountContext): string => {
    const actor = ctx.user
    const row = actor ? d.store.getUser(actor.id) : undefined
    if (d.mode() !== 'account' || ctx.state !== 'full' || !actor || actor.role !== 'admin' || !row || row.role !== 'admin' || row.status !== 'active') throw new AuthError('auth_failed')
    return actor.id
  }
  const refused = (error: unknown): { ok: false; error: SettingsRefusal } => {
    if (!(error instanceof SettingsError)) throw error
    return { ok: false, error: { code: error.code, ...(error.detail ? { detail: error.detail } : {}), ...(error.count !== undefined ? { count: error.count } : {}) } }
  }
  return {
    get(ctx) {
      adminOf(ctx)
      // `updatedBy` is a user id (or `setup`, `cli`); the page shows a name.
      const names = new Map<string, string>()
      const nameOf = (id: string): string => {
        if (id === 'setup' || id === 'cli') return id
        if (!names.has(id)) {
          const u = d.store.getUser(id)
          names.set(id, u ? u.displayName || u.username : 'a removed user')
        }
        return names.get(id)!
      }
      return { settings: d.describe().map((s) => (s.updatedBy ? { ...s, updatedBy: nameOf(s.updatedBy) } : s)) }
    },
    set(ctx, key, value, basedOn) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, SETTINGS_STEP_UP_PURPOSE)
      try {
        const r = d.writer.set(key, value, basedOn, actor)
        return { ok: true, changed: r.changed, updatedAt: r.updatedAt }
      } catch (error) {
        return refused(error)
      }
    },
    reset(ctx, key, basedOn) {
      const actor = adminOf(ctx)
      d.stepUp.requireRecentFactor(ctx, SETTINGS_STEP_UP_PURPOSE)
      try {
        const r = d.writer.reset(key, basedOn, actor)
        return { ok: true, changed: r.changed, updatedAt: r.updatedAt }
      } catch (error) {
        return refused(error)
      }
    },
    preview(ctx, key, value) {
      adminOf(ctx)
      try {
        return { ok: true, ...d.writer.preview(key, value) }
      } catch (error) {
        return refused(error)
      }
    },
  }
}
