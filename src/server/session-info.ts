/**
 * `getSessionInfo`: one function, mode-appropriate answer (SPEC/26 5.5, FR-AUT-024). Pure over its dependencies so it
 * is unit-testable; `session.functions.ts` wires the runtime. `null` without a valid session; never throws for that.
 */
import { appearanceOf } from './auth/prefs/runtime'
import { ownerKeyOf } from './sql/state'
import type { Runtime } from './runtime'
import { loginModeOf } from './session-context'
import type { AccountContext, AccountSessionInfo, ConnectionInfo, ResolvedAuthSettings, VaultStatus } from './auth/types'
import type { PrefsServiceExt } from './auth/prefs/service'

export type DirectSessionInfo = {
  mode: 'direct'
  csrf: string
  readOnly: boolean
  target: { host: string; port: number; username: string }
  theme: AccountSessionInfo['theme']
  language: string
}
export type SessionInfoResult = DirectSessionInfo | AccountSessionInfo

export type SessionInfoDeps = {
  runtime: Pick<Runtime, 'sessions' | 'config' | 'store' | 'setup'>
  token: string | undefined
  settings: () => Pick<ResolvedAuthSettings, 'adminSessionIdleMs' | 'stepUpWindowMs'>
  prefs: (stateless: boolean) => Pick<PrefsServiceExt, 'get'>
  stateless: boolean
  connections: (ctx: AccountContext) => ConnectionInfo[]
  vaultStatus: (ctx: AccountContext) => VaultStatus
}

const NO_VAULT: VaultStatus = { exists: false, unlocked: false, autoLockAt: null, enabled: false }

export function buildSessionInfo(d: SessionInfoDeps): SessionInfoResult | null {
  const { sessions, config, store } = d.runtime
  if (loginModeOf(d.runtime) === 'account') {
    const context = sessions.resolveAccount(d.token, { background: true })
    if (!context) return null
    const row = store.accounts.getAccountSession(context.idHash)
    if (!row) return null
    const settings = d.settings()
    const idleMs = context.user?.role === 'admin' ? settings.adminSessionIdleMs : config.sessionIdleMs
    const full = context.state === 'full'
    return {
      mode: 'account',
      csrf: context.csrf,
      state: context.state,
      user: context.user,
      // Targets, vault and preferences belong to a fully signed-in session only.
      connections: full ? d.connections(context) : [],
      vault: full ? d.vaultStatus(context) : NO_VAULT,
      ...(full ? appearanceOf(d.prefs(false), context.ownerKey) : { theme: 'system' as const, language: 'en' }),
      idleExpiresAt: row.lastSeenAt + idleMs,
      absoluteExpiresAt: row.expiresAt,
      stepUpUntil: context.stepupAt === null ? null : context.stepupAt + settings.stepUpWindowMs,
    }
  }
  const session = sessions.resolve(d.token)
  if (!session) return null
  const ownerKey = d.stateless ? session.idHash : ownerKeyOf(session.target)
  return {
    mode: 'direct',
    csrf: session.csrf,
    readOnly: config.readOnly || session.readOnly,
    target: { host: session.target.host, port: session.target.port, username: session.target.username },
    ...appearanceOf(d.prefs(d.stateless), ownerKey),
  }
}
