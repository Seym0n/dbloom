/**
 * Administrator side of the settings page (SPEC/32 FR-ASE-005): role check, step-up, then the writer. Reading needs the
 * administrator role only; every write and reset also needs a recent factor (purpose `settings.write`). A refusal of the
 * writer is an answer (`{ ok: false, error }`), not a thrown error: the page shows it next to the row. Authentication
 * failures (`auth_failed`, `stepup_required`) are thrown as `AuthError`, like every other admin function.
 */
import { AuthError, type AccountContext, type AccountStore, type AuthSettingKey, type SettingDescription, type StepUp } from './auth/types'
import type { PendingSettings } from './settings-pending'
import { SettingsError, type SettingsErrorCode, type SettingsWriter } from './auth/settings-write'

export type SettingsRefusal = { code: SettingsErrorCode; detail?: string; count?: number }
export type SettingsAnswer = { ok: true; changed: boolean; updatedAt: number | null } | { ok: false; error: SettingsRefusal }
export type PreviewAnswer = { ok: true; strandedUsers: number } | { ok: false; error: SettingsRefusal }
export type SettingsView = { settings: SettingDescription[] }
/** Answer of confirm and cancel (SPEC/33). A refusal is an answer, like the writer's. */
export type PendingAnswer = { ok: true } | { ok: false; error: SettingsRefusal }

export type SettingsServiceDeps = {
  store: Pick<AccountStore, 'getUser' | 'getAccountSession'>
  /** Guarded changes (SPEC/33): swept at the start of every call, confirmed and cancelled here. Absent: nothing is ever pending. */
  pending?: Pick<PendingSettings, 'sweep' | 'confirm' | 'cancel'>
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
  /** Keeps a guarded change: needs an administrator session that signed in after the change; no step-up. */
  confirm(ctx: AccountContext, key: string): PendingAnswer
  /** Reverts a guarded change at once; no step-up. */
  cancel(ctx: AccountContext, key: string): PendingAnswer
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
      d.pending?.sweep()
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
      d.pending?.sweep()
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
      d.pending?.sweep()
      try {
        const r = d.writer.reset(key, basedOn, actor)
        return { ok: true, changed: r.changed, updatedAt: r.updatedAt }
      } catch (error) {
        return refused(error)
      }
    },
    preview(ctx, key, value) {
      adminOf(ctx)
      d.pending?.sweep()
      try {
        return { ok: true, ...d.writer.preview(key, value) }
      } catch (error) {
        return refused(error)
      }
    },
    confirm(ctx, key) {
      const actor = adminOf(ctx)
      // The session's creation time is what proves a sign-in under the new settings; a step-up keeps it (renameSession).
      const createdAt = d.store.getAccountSession(ctx.idHash)?.createdAt
      if (createdAt === undefined) throw new AuthError('auth_failed')
      try {
        if (!d.pending) throw new SettingsError('settings_no_pending')
        d.pending.confirm(key as AuthSettingKey, createdAt, actor)
        return { ok: true }
      } catch (error) {
        return refused(error)
      }
    },
    cancel(ctx, key) {
      const actor = adminOf(ctx)
      try {
        if (!d.pending) throw new SettingsError('settings_no_pending')
        d.pending.cancel(key as AuthSettingKey, actor)
        return { ok: true }
      } catch (error) {
        return refused(error)
      }
    },
  }
}
