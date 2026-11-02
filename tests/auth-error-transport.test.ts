import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-start/server', () => ({ setResponseStatus: vi.fn(), setResponseHeader: vi.fn() }))

import { authErrorResponse } from '~/server/auth/error-transport'
import { AuthError } from '~/server/auth/types'

describe('auth error transport', () => {
  it('maps classes to fixed statuses and a JSON body', () => {
    expect(authErrorResponse(new AuthError('auth_throttled', { retryAfterSeconds: 7 }))).toEqual({ status: 429, body: { code: 'auth_throttled', retryAfterSeconds: 7 } })
    expect(authErrorResponse(new AuthError('stepup_required'))).toEqual({ status: 403, body: { code: 'stepup_required' } })
    expect(authErrorResponse(new AuthError('password_rejected', { reason: 'breached' }))).toEqual({ status: 401, body: { code: 'password_rejected', reason: 'breached' } })
    expect(authErrorResponse(new AuthError('profile_test_failed', { targetMessage: 'm' }))?.body).toEqual({ code: 'profile_test_failed', targetMessage: 'm' })
  })

  it('uses the fallback code for other errors, and none without a fallback', () => {
    expect(authErrorResponse(new Error('db exploded'), 'mfa_failed')).toEqual({ status: 401, body: { code: 'mfa_failed' } })
    expect(authErrorResponse(new Error('x'))).toBeUndefined()
  })
})
