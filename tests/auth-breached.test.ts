/** Unit tests of package A `breached.ts` (Q3; section 10: offline lookup, binary search, unavailable). */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type BreachedList } from '../src/server/auth/types'
import { checkPasswordPolicy } from '../src/server/auth/password'
import { loadBreachedList, breachedListService, BUNDLED_FILE_NAME } from '../src/server/auth/breached'

const dir = mkdtempSync(path.join(tmpdir(), 'dbloom-breached-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sha1 = (value: string) => createHash('sha1').update(value, 'utf8').digest('hex')
// Sort ascending and write a fixed-width file just as HIBP does.
const passwords = ['hunter2000danger', 'monkey12!danger', 'letmein99xdanger', 'sunflower9danger']
const sorted = passwords.map(sha1).sort()
// Build one file: hex ascending only (the loader strips the count column when present).
const operatorFile = path.join(dir, 'list.txt')
writeFileSync(operatorFile, sorted.map((hex) => `${hex}\n`).join(''))

describe('operator file on the disk', () => {
  const lookup = loadBreachedList(operatorFile)

  it('reports kind operator and the entry count', async () => {
    expect((await lookup).kind).toBe('operator')
    expect((await lookup).entries).toBe(4)
  })

  it('finds each and only its own passwords', async () => {
    const opened = await lookup
    for (const pw of passwords) {
      expect(await opened.contains(sha1(pw))).toBe(true)
    }
    expect(await opened.contains(sha1('r9!QkeL2sXvN'))).toBe(false)
    expect(await opened.contains(sha1('hunter1999'))).toBe(false)
  })

  it('answers unavailable for a broken fixed-width layout', async () => {
    const broken = path.join(dir, 'broken.txt')
    writeFileSync(broken, 'ff\n')
    const lookup2 = await loadBreachedList(broken)
    expect(lookup2.kind).toBe('none') // the service keeps the bundled list absent
    expect(await lookup2.contains('ffffff')).toBe('unavailable')
  })
})

describe('service wrapper', () => {
  it('answers boolean or unavailable through PasswordService', async () => {
    const list: BreachedList = await breachedListService(operatorFile)
    expect(list.source()).toEqual({ kind: 'operator', entries: 4 })
    expect(await list.contains('hunter2000danger')).toBe(true)
    expect(await list.contains('r9!QkeL2sXvN')).toBe(false)
  })

  it('passes a hit through checkPasswordPolicy', async () => {
    const list = await breachedListService(operatorFile)
    const result = await checkPasswordPolicy('hunter2000danger', list, {
      username: 'walther',
      minLength: 12,
      breachedCheck: true,
      failClosed: true,
    })
    expect(result.reason).toBe('breached')
    expect(result.breachedListUnavailable).toBe(false)
  })

  it('without any list the policy stays fail-closed-unavailable', async () => {
    const list = await breachedListService(null)
    expect(list.source()).toEqual({ kind: 'none', entries: 0 })
    const result = await checkPasswordPolicy('hunter2000danger', list, {
      username: 'walther',
      minLength: 12,
      breachedCheck: true,
      failClosed: true,
    })
    expect(result).toEqual({ reason: 'breached', breachedListUnavailable: true })
  })

  it('without any list but failClosed false it accepts and reports', async () => {
    const list = await breachedListService(null)
    const result = await checkPasswordPolicy('hunter2000danger', list, {
      username: 'walther',
      minLength: 12,
      breachedCheck: true,
      failClosed: false,
    })
    expect(result).toEqual({ reason: null, breachedListUnavailable: true })
  })
})

describe('bundled list handling', () => {
  it('answers no list when neither file exists', async () => {
    const lookup = await loadBreachedList(null)
    expect(lookup.kind).toBe('none')
    expect(await lookup.contains('a'.repeat(40))).toBe('unavailable')
  })

  it('shares the constant the bundler will use', () => {
    expect(BUNDLED_FILE_NAME.endsWith('.txt')).toBe(true)
  })
})
