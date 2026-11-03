import { describe, expect, it } from 'vitest'
import { formatRemaining, idlePhase, msUntilIdleWarning } from '../src/lib/auth/idle-logic'
import { isNetworkError, isSessionEnded, setConnectionLost, createQueryClient } from '../src/lib/session-state'
import { SESSION_ENDED } from '../src/lib/csrf'
import { IDLE_WARNING_MS } from '../src/server/auth/types'
import { createMockAuthApi, MOCK_PASSWORD } from '../src/lib/auth/mock-api'

describe('idle warning timing (SEC-UIX-109)', () => {
  const limit = 1_000_000
  it('opens two minutes before the limit', () => {
    expect(IDLE_WARNING_MS).toBe(120_000)
    expect(msUntilIdleWarning(limit, limit - 600_000)).toBe(480_000)
    expect(msUntilIdleWarning(limit, limit - 60_000)).toBe(0)
  })

  it('names the phase', () => {
    expect(idlePhase(limit, limit - 120_001)).toBe('active')
    expect(idlePhase(limit, limit - 120_000)).toBe('warning')
    expect(idlePhase(limit, limit - 1)).toBe('warning')
    expect(idlePhase(limit, limit)).toBe('expired')
    expect(idlePhase(limit, limit + 5)).toBe('expired')
  })

  it('formats the remaining time', () => {
    expect(formatRemaining(120)).toBe('2:00')
    expect(formatRemaining(61)).toBe('1:01')
    expect(formatRemaining(9)).toBe('0:09')
    expect(formatRemaining(-3)).toBe('0:00')
  })
})

describe('connection lost (SCN-072)', () => {
  it('tells a network failure from a 401 and from other errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true)
    expect(isNetworkError(new Error(SESSION_ENDED))).toBe(false)
    expect(isSessionEnded(new Error(SESSION_ENDED))).toBe(true)
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false)
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(false)
  })

  it('keeps the flag store usable and a query succeeds', async () => {
    const client = createQueryClient()
    setConnectionLost(false)
    await client.fetchQuery({ queryKey: ['x'], queryFn: () => 'ok' })
    expect(client.getQueryCache().find({ queryKey: ['x'] })?.state.status).toBe('success')
  })
})

describe('mock setup passkey issues recovery codes (FR-AUT-010)', () => {
  it('returns ten codes for the first factor only', async () => {
    const api = createMockAuthApi('setup')
    await api.setupVerifyToken('MOCK-SETUP-TOKEN')
    await api.setupSaveStep({ step: 4, username: 'root1', displayName: '', password: MOCK_PASSWORD })
    const first = await api.setupPasskeyVerify({} as never, 'Laptop')
    expect(first.recoveryCodes).toHaveLength(10)
    const second = await api.setupPasskeyVerify({} as never, 'Phone')
    expect(second.recoveryCodes).toBeUndefined()
  })
})
