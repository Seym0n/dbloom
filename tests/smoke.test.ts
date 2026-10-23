import { expect, test } from 'vitest'

test('node:sqlite is available', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  expect(typeof DatabaseSync).toBe('function')
})
