import { describe, expect, it } from 'vitest'
import { findViolations } from '../scripts/check-lifecycle-scripts.mjs'
import { findUnpinned } from '../scripts/check-pinned-deps.mjs'

describe('lifecycle-script allow-list', () => {
  it('passes the allowed package and flags a seeded one', () => {
    const lock = { packages: { 'node_modules/fsevents': { hasInstallScript: true, version: '2.3.3' } } }
    expect(findViolations(lock)).toEqual([])
    const seeded = { packages: { ...lock.packages, 'node_modules/a/node_modules/evil': { hasInstallScript: true, version: '1.0.0' } } }
    expect(findViolations(seeded)).toEqual(['evil@1.0.0'])
  })
})

describe('pinned dependencies', () => {
  const lock = { packages: { 'node_modules/@tanstack/react-router': { version: '1.0.0' } } }
  it('accepts exact versions that match the lock', () => {
    expect(findUnpinned({ dependencies: { '@tanstack/react-router': '1.0.0' } }, lock)).toEqual([])
  })
  it('flags ranges and lock drift', () => {
    expect(findUnpinned({ dependencies: { zod: '^4.0.0' } }, lock)).toHaveLength(1)
    expect(findUnpinned({ dependencies: { '@tanstack/react-router': '1.0.1' } }, lock)).toHaveLength(1)
  })
})
