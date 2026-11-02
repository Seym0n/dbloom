import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { accountMiddleware, publicMiddleware } from '../middleware'
import { getLinkServices } from './link-services'
import { preAuthOwner, requestAddress, requireAdminUser } from './link-http'
import { PRE_AUTH_COOKIE, issueRecoveryInput, recoveryPasskeyOptionsInput, redeemRecoveryInput } from './types'

/** For the admin module's screen; the CLI calls the service directly (ST-079). */
export const issueRecovery = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(issueRecoveryInput)
  .handler(({ data, context }) => {
    const { recovery, stepUp } = getLinkServices()
    const actor = requireAdminUser(context.account.user)
    stepUp.requireRecentFactor(context.account, 'recovery.issue')
    return recovery.issue(actor, data.userId)
  })

export const recoveryPasskeyOptions = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(recoveryPasskeyOptionsInput)
  // WebAuthn options are plain JSON; the cast only satisfies the serialisable-type check of server functions.
  .handler(async ({ data }) => (await getLinkServices().recovery.passkeyOptions(data.token, preAuthOwner())) as unknown as { challenge: string })

export const redeemRecovery = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(redeemRecoveryInput)
  .handler(({ data }) =>
    getLinkServices().recovery.redeem(data, { address: requestAddress(), preAuthOwner: getCookie(PRE_AUTH_COOKIE) }),
  )
