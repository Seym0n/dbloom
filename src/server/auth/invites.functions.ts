import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { publicMiddleware, accountMiddleware } from '../middleware'
import { preAuthOwner, requestAddress, requireAdminUser } from './link-http'
import { getLinkServices } from './link-services'
import { PRE_AUTH_COOKIE, invitePasskeyOptionsInput, issueInviteInput, redeemInviteInput, revokeInviteInput } from './types'
import { z } from 'zod'

const empty = z.object({}).strict()

export const issueInvite = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(issueInviteInput)
  .handler(({ data, context }) => {
    const { invites, stepUp } = getLinkServices()
    const actor = requireAdminUser(context.account.user)
    stepUp.requireRecentFactor(context.account, 'invite.issue')
    return invites.issue(actor, data)
  })

export const listInvites = createServerFn({ method: 'GET' })
  .middleware([accountMiddleware])
  .validator(empty)
  .handler(({ context }) => {
    requireAdminUser(context.account.user)
    return getLinkServices().invites.list()
  })

export const revokeInvite = createServerFn({ method: 'POST' })
  .middleware([accountMiddleware])
  .validator(revokeInviteInput)
  .handler(({ data, context }) => {
    const { invites, stepUp } = getLinkServices()
    const actor = requireAdminUser(context.account.user)
    stepUp.requireRecentFactor(context.account, 'invite.revoke')
    invites.revoke(actor, data.id)
    return { ok: true as const }
  })

export const invitePasskeyOptions = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(invitePasskeyOptionsInput)
  // WebAuthn options are plain JSON; the cast only satisfies the serialisable-type check of server functions.
  .handler(async ({ data }) => (await getLinkServices().invites.passkeyOptions(data.token, data.username, preAuthOwner())) as unknown as { challenge: string })

export const redeemInvite = createServerFn({ method: 'POST' })
  .middleware([publicMiddleware])
  .validator(redeemInviteInput)
  .handler(({ data }) =>
    getLinkServices().invites.redeem(data, { address: requestAddress(), preAuthOwner: getCookie(PRE_AUTH_COOKIE) }),
  )
