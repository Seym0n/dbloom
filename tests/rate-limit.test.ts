import { expect, test } from 'vitest'
import { FailureLimiter } from '~/server/rate-limit'

test('blocks after max failures and recovers after the window', () => {
  let now = 0
  const l = new FailureLimiter(3, 1000, () => now)
  l.fail('k')
  l.fail('k')
  expect(l.isBlocked('k')).toBe(false)
  l.fail('k')
  expect(l.isBlocked('k')).toBe(true)
  expect(l.isBlocked('other')).toBe(false)
  now = 1001
  expect(l.isBlocked('k')).toBe(false)
})

test('reset clears the key', () => {
  const l = new FailureLimiter(1, 1000)
  l.fail('k')
  l.reset('k')
  expect(l.isBlocked('k')).toBe(false)
})
