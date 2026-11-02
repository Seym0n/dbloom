/** Wires the setup service from the real parts (store, key ring, password service, WebAuthn). Used by the runtime and tests. */
import { lazyBreachedList } from './breached'
import { createRecoveryCodeService } from './codes'
import { createPasswordService } from './password'
import { loadSecretKey } from './secret-key'
import { createAuthSettingsResolver } from './settings'
import { createSetupService, type SetupApi } from './setup'
import { createThrottle } from './throttle'
import { tokens } from './tokens'
import { totp } from './totp'
import { createWebAuthnService } from './webauthn'
import { challenges as sharedChallenges } from './challenges'
import type { AccountStore, Throttle, WebAuthnService } from './types'

export type SetupRuntimeOptions = {
  accounts: AccountStore
  dataDir: string
  env?: NodeJS.ProcessEnv
  /** Override for tests or for the shared service of task 6; the default builds one on the shared challenge store. */
  webauthn?: () => WebAuthnService | undefined
  /** The runtime-wide throttle (sign-in, vault, setup share it, FR-AUT-007); a private one when absent. */
  throttle?: Throttle
  now?: () => number
  log?: (line: string) => void
}

export function createSetupRuntime(opts: SetupRuntimeOptions): SetupApi {
  const env = opts.env ?? process.env
  const resolver = createAuthSettingsResolver(opts.accounts, env)
  const key = loadSecretKey(env)
  const ring = key.ok ? key.ring : undefined
  const passwords = createPasswordService(lazyBreachedList(() => resolver.resolve().breachedListPath))
  const webauthn =
    opts.webauthn ??
    (() => {
      const s = resolver.resolve()
      if (!s.rpId || !s.publicOrigin) return undefined
      return (cached ??= createWebAuthnService({
        challenges: sharedChallenges,
        relyingParty: () => {
          const r = resolver.resolve()
          return { rpId: r.rpId ?? '', origin: new URL(r.publicOrigin ?? 'http://localhost').origin, rpName: 'DBLoom' }
        },
      }))
    })
  let cached: WebAuthnService | undefined
  return createSetupService({
    accounts: opts.accounts,
    dataDir: opts.dataDir,
    env,
    stateless: env.DBLOOM_STORE === 'none',
    resolver,
    tokens,
    passwords,
    totp,
    recoveryCodes: ring ? createRecoveryCodeService(ring) : undefined,
    ring,
    webauthn,
    throttle: opts.throttle ?? createThrottle(),
    now: opts.now,
    log: opts.log,
  })
}
