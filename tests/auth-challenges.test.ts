/** Package C: challenge store (FR-AUT-011, SEC-TGT-152). */
import { describe, expect, it } from 'vitest'
import { createChallengeStore } from '~/server/auth/challenges'
import { CHALLENGE_MAX_TRIES, CHALLENGE_TTL_MS } from '~/server/auth/types'

describe('challenge store', () => {
  it('takes a challenge once, whatever the outcome', () => {
    const store = createChallengeStore()
    store.create('s1', 'mfa', { userId: 'u', challenge: 'c' })
    expect(store.take('s1', 'mfa')).toMatchObject({ owner: 's1', purpose: 'mfa', userId: 'u', challenge: 'c' })
    expect(store.take('s1', 'mfa')).toBeUndefined()
  })

  it('binds a challenge to its owner and purpose', () => {
    const store = createChallengeStore()
    store.create('s1', 'mfa', { challenge: 'c' })
    expect(store.take('s2', 'mfa')).toBeUndefined()
    expect(store.take('s1', 'stepup')).toBeUndefined()
    expect(store.take('s1', 'mfa')).toBeDefined()
  })

  it('expires after five minutes', () => {
    let t = 1_000
    const store = createChallengeStore(() => t)
    store.create('s1', 'mfa')
    t += CHALLENGE_TTL_MS
    expect(store.take('s1', 'mfa')).toBeUndefined()
  })

  it('counts tries and deletes after the fifth (the fifth is still returned)', () => {
    const store = createChallengeStore()
    store.create('s1', 'mfa')
    for (let i = 1; i < CHALLENGE_MAX_TRIES; i += 1) expect(store.countTry('s1', 'mfa')?.tries).toBe(i)
    expect(store.countTry('s1', 'mfa')?.tries).toBe(CHALLENGE_MAX_TRIES)
    expect(store.countTry('s1', 'mfa')).toBeUndefined()
  })

  it('keeps the tries when new options replace a running code step', () => {
    const store = createChallengeStore()
    store.create('s1', 'mfa')
    store.countTry('s1', 'mfa')
    store.countTry('s1', 'mfa')
    expect(store.create('s1', 'mfa').tries).toBe(2)
  })

  it('replaces a challenge of the same owner and purpose and drops by owner', () => {
    const store = createChallengeStore()
    const first = store.create('s1', 'mfa', { challenge: 'a' })
    const second = store.create('s1', 'mfa', { challenge: 'b' })
    expect(second.id).not.toBe(first.id)
    store.create('s1', 'stepup')
    store.dropOwner('s1')
    expect(store.take('s1', 'mfa')).toBeUndefined()
    expect(store.take('s1', 'stepup')).toBeUndefined()
  })
})
