/**
 * Server functions of package D (thin): connections, vault, profiles (SPEC/26 section 5.6). Every function uses
 * `accountMiddleware` (session cookie + CSRF); the services check `state === 'full'`. Errors cross the boundary as
 * the shared JSON error of `auth/error-transport.ts` (the code list is closed, 5.9).
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestIP } from '@tanstack/react-start/server'
import { accountMiddleware } from './middleware'
import { getRuntime } from './runtime'
import { getAccountServices } from './auth/account-runtime'
import { throwAuthError } from './auth/error-transport'
import {
  closeConnectionInput,
  openConnectionInput,
  profileIdOnlyInput,
  saveProfileInput,
  vaultChangePassphraseInput,
  vaultCreateInput,
  vaultLockInput,
  vaultRegenerateRecoveryKeyInput,
  vaultRotateKeyInput,
  vaultUnlockInput,
  vaultUseRecoveryKeyInput,
} from './auth/types'

const getServices = getAccountServices

/** `AuthError` becomes the shared JSON error (`error-transport.ts`); other errors pass unchanged (generic target message, session ended). */
async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    return throwAuthError(error)
  }
}

// ---- Connections (FR-AUT-018, 019) ---------------------------------------------------------------------------

export const listConnections = createServerFn({ method: 'GET' })
  .middleware([accountMiddleware])
  .handler(({ context }) => guarded(() => getServices().connections.list(context.account)))

export const openConnection = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(openConnectionInput)
  .handler(({ data, context }) =>
    guarded(() => getServices().connections.open(context.account, data, { address: getRequestIP({ xForwardedFor: getRuntime().config.trustProxy }) ?? 'unknown' })),
  )

export const closeConnection = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(closeConnectionInput)
  .handler(({ data, context }) => guarded(() => getServices().connections.close(context.account, data.connectionId)))

// ---- Vault (FR-AUT-021) ---------------------------------------------------------------------------------------

export const vaultStatus = createServerFn({ method: 'GET' })
  .middleware([accountMiddleware])
  .handler(({ context }) => guarded(() => getServices().vault.status(context.account)))

export const vaultCreate = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultCreateInput)
  .handler(({ data, context }) => guarded(() => getServices().vault.create(context.account, data.passphrase)))

export const vaultUnlock = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultUnlockInput)
  .handler(({ data, context }) => guarded(async () => {
    await getServices().vault.unlock(context.account, data.passphrase)
    return getServices().vault.status(context.account)
  }))

export const vaultLock = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultLockInput)
  .handler(({ context }) => guarded(() => {
    getServices().vault.lock(context.account)
    return getServices().vault.status(context.account)
  }))

export const vaultChangePassphrase = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultChangePassphraseInput)
  .handler(({ data, context }) => guarded(async () => {
    await getServices().vault.changePassphrase(context.account, data.currentPassphrase, data.newPassphrase)
    return { ok: true as const }
  }))

export const vaultUseRecoveryKey = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultUseRecoveryKeyInput)
  .handler(({ data, context }) => guarded(() => getServices().vault.useRecoveryKey(context.account, data.recoveryKey, data.newPassphrase)))

export const vaultRegenerateRecoveryKey = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultRegenerateRecoveryKeyInput)
  .handler(({ context }) => guarded(() => getServices().vault.regenerateRecoveryKey(context.account)))

export const vaultRotateKey = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(vaultRotateKeyInput)
  .handler(({ data, context }) => guarded(() => getServices().vault.rotateKey(context.account, data.passphrase)))

// ---- Profiles (FR-AUT-022) ------------------------------------------------------------------------------------

export const listProfiles = createServerFn({ method: 'GET' })
  .middleware([accountMiddleware])
  .handler(({ context }) => guarded(() => getServices().profiles.list(context.account)))

export const saveProfile = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(saveProfileInput)
  .handler(({ data, context }) => guarded(() => getServices().profiles.save(context.account, data)))

export const testProfile = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(saveProfileInput)
  .handler(({ data, context }) => guarded(() => getServices().profiles.test(context.account, data)))

export const deleteProfile = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(profileIdOnlyInput)
  .handler(({ data, context }) => guarded(() => {
    getServices().profiles.delete(context.account, data.id)
    return { ok: true as const }
  }))
