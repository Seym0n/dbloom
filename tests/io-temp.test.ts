import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEMP_ID, TempError, TempStore, prepareTempDir, type TempOwner } from '~/server/io/temp'
import { JOB_RETENTION_MS } from '~/server/io/types'

const alice: TempOwner = { sessionId: 's1', user: 'alice' }
const bob: TempOwner = { sessionId: 's2', user: 'bob' }
const posix = process.platform !== 'win32'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dbloom-temp-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const make = (opts: Partial<ConstructorParameters<typeof TempStore>[0]> = {}) =>
  new TempStore({ dir: join(root, 'tmp'), quotaBytes: 1024, ...opts })

const bytes = (n: number) => new Uint8Array(n).fill(65)

describe('directory', () => {
  test('is created, including parents', () => {
    const d = prepareTempDir(join(root, 'a', 'b'))
    expect(statSync(d).isDirectory()).toBe(true)
    if (posix) expect(statSync(d).mode & 0o777).toBe(0o700)
  })

  test('refuses a path that is a file', () => {
    writeFileSync(join(root, 'file'), 'x')
    expect(() => prepareTempDir(join(root, 'file'))).toThrow(/not a directory/)
  })

  test('refuses a symbolic link, even to a safe place', () => {
    const real = join(root, 'real')
    mkdirSync(real)
    const link = join(root, 'link')
    try {
      symlinkSync(real, link, 'dir')
    } catch {
      return // creating links needs a privilege on some Windows setups
    }
    expect(() => prepareTempDir(link)).toThrow(/symbolic link/)
  })

  test.runIf(posix)('refuses a world-writable directory', async () => {
    const { chmodSync } = await import('node:fs')
    const d = join(root, 'open')
    mkdirSync(d)
    chmodSync(d, 0o777)
    expect(() => prepareTempDir(d)).toThrow(/world-writable/)
  })

  test('refuses a place inside a protected directory', () => {
    expect(() => prepareTempDir(join(root, 'www', 'tmp'), [join(root, 'www')])).toThrow(/protected/)
    expect(() => prepareTempDir(join(root, 'www'), [join(root, 'www')])).toThrow(/protected/)
    expect(() => prepareTempDir(join(root, 'wwwx'), [join(root, 'www')])).not.toThrow()
  })
})

describe('staged files', () => {
  test('random 32-hex name, mode 0600, content as written, bound to the owner', async () => {
    const t = make()
    const w = await t.begin(alice, 'upload', {
      name: '../../etc/passwd',
      format: 'sql',
      maxBytes: 100,
    })
    await w.write(Buffer.from('hello '))
    await w.write(Buffer.from('world'))
    const f = await w.commit()
    expect(f.id).toMatch(TEMP_ID)
    expect(f.path).toBe(join(t.dir, f.id))
    expect(readFileSync(f.path, 'utf8')).toBe('hello world')
    if (posix) expect(statSync(f.path).mode & 0o777).toBe(0o600)
    expect(f.bytes).toBe(11)
    expect(f.name).toBe('../../etc/passwd') // metadata only
    expect(readdirSync(t.dir)).toEqual([f.id])
    expect(t.get(f.id, alice)).toBe(f)
    expect(t.get(f.id, bob)).toBeUndefined()
    expect(t.get(f.id, { sessionId: 's1', user: 'mallory' })).toBeUndefined()
    expect(t.get('../' + f.id, alice)).toBeUndefined()
    expect(t.get('x'.repeat(32), alice)).toBeUndefined()
  })

  test('names are unpredictable', async () => {
    const t = make({ quotaBytes: 1e6 })
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const w = await t.begin({ ...alice, sessionId: `s${i}` }, 'upload', {
        name: 'a',
        maxBytes: 10,
      })
      await w.write(bytes(1))
      ids.add((await w.commit()).id)
    }
    expect(ids.size).toBe(5)
  })

  test('a file over its size limit is cut off and removed', async () => {
    const t = make()
    const w = await t.begin(alice, 'upload', { name: 'a', maxBytes: 10 })
    await w.write(bytes(6))
    await expect(w.write(bytes(5))).rejects.toMatchObject({ code: 'upload_too_large' })
    expect(readdirSync(t.dir)).toEqual([])
    expect(t.usedBytes()).toBe(0)
  })

  test('abort removes the partial file and frees the quota; it is safe to call twice', async () => {
    const t = make()
    const w = await t.begin(alice, 'upload', { name: 'a', maxBytes: 100 })
    await w.write(bytes(50))
    expect(t.usedBytes()).toBe(50)
    await w.abort()
    await w.abort()
    expect(readdirSync(t.dir)).toEqual([])
    expect(t.usedBytes()).toBe(0)
    await expect(w.write(bytes(1))).rejects.toBeInstanceOf(TempError)
  })

  test('commit after abort is refused', async () => {
    const t = make()
    const w = await t.begin(alice, 'upload', { name: 'a', maxBytes: 100 })
    await w.abort()
    await expect(w.commit()).rejects.toBeInstanceOf(TempError)
  })
})

describe('quota', () => {
  test('counts committed and running files; the overflow is cut off and removed', async () => {
    const t = make({ quotaBytes: 100 })
    const a = await t.begin(alice, 'upload', { name: 'a', maxBytes: 1000 })
    await a.write(bytes(60))
    await a.commit()
    expect(t.usedBytes()).toBe(60)
    const b = await t.begin(bob, 'upload', { name: 'b', maxBytes: 1000 })
    await b.write(bytes(30))
    expect(t.usedBytes()).toBe(90)
    await expect(b.write(bytes(11))).rejects.toMatchObject({ code: 'quota_full' })
    expect(t.usedBytes()).toBe(60)
    expect(readdirSync(t.dir)).toHaveLength(1)
  })

  test('a full store refuses to start a file', async () => {
    const t = make({ quotaBytes: 10 })
    const a = await t.begin(alice, 'upload', { name: 'a', maxBytes: 1000 })
    await a.write(bytes(10))
    await a.commit()
    await expect(t.begin(bob, 'upload', { name: 'b', maxBytes: 5 })).rejects.toMatchObject({
      code: 'quota_full',
    })
  })

  test('removing a file gives its bytes back', async () => {
    const t = make()
    const w = await t.begin(alice, 'spool', { name: 'a', maxBytes: 1000 })
    await w.write(bytes(100))
    const f = await w.commit()
    expect(t.usedBytes()).toBe(100)
    expect(await t.remove(f.id)).toBe(true)
    expect(await t.remove(f.id)).toBe(false)
    expect(t.usedBytes()).toBe(0)
    expect(existsSync(f.path)).toBe(false)
  })

  test('one owner holds a bounded number of files at a time', async () => {
    const t = make({ maxFilesPerOwner: 2, quotaBytes: 1e6 })
    for (let i = 0; i < 2; i++) {
      const w = await t.begin(alice, 'upload', { name: 'a', maxBytes: 10 })
      await w.write(bytes(1))
      await w.commit()
    }
    await expect(t.begin(alice, 'upload', { name: 'a', maxBytes: 10 })).rejects.toMatchObject({
      code: 'quota_full',
    })
    await expect(t.begin(bob, 'upload', { name: 'b', maxBytes: 10 })).resolves.toBeDefined()
  })
})

describe('sweep and session end', () => {
  test('files past their retention are removed; others stay', async () => {
    let now = 1_000_000
    const t = make({ now: () => now, quotaBytes: 1e6 })
    const mk = async (o: TempOwner) => {
      const w = await t.begin(o, 'upload', { name: 'a', maxBytes: 10 })
      await w.write(bytes(3))
      return w.commit()
    }
    const old = await mk(alice)
    now += JOB_RETENTION_MS - 10
    const fresh = await mk(bob)
    now += 10
    expect(await t.sweep()).toBe(1)
    expect(t.get(old.id, alice)).toBeUndefined()
    expect(existsSync(old.path)).toBe(false)
    expect(t.get(fresh.id, bob)).toBeDefined()
    expect(t.usedBytes()).toBe(3)
  })

  test('retain keeps a file for a job that still reads it', async () => {
    let now = 0
    const t = make({ now: () => now })
    const w = await t.begin(alice, 'upload', { name: 'a', maxBytes: 10 })
    await w.write(bytes(1))
    const f = await w.commit()
    t.retain(f.id, JOB_RETENTION_MS * 3)
    now = JOB_RETENTION_MS + 1
    expect(await t.sweep()).toBe(0)
    now = JOB_RETENTION_MS * 3
    expect(await t.sweep()).toBe(1)
  })

  test('leftovers of an earlier run are removed once old enough; foreign names are left alone', async () => {
    const t = make()
    const leftover = join(t.dir, 'a'.repeat(32))
    const young = join(t.dir, 'b'.repeat(32))
    const other = join(t.dir, 'notes.txt')
    for (const p of [leftover, young, other]) writeFileSync(p, 'x')
    const old = new Date(Date.now() - JOB_RETENTION_MS - 60_000)
    utimesSync(leftover, old, old)
    utimesSync(other, old, old)
    expect(await t.sweep()).toBe(1)
    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  test('dropSession removes the files of that session only', async () => {
    const t = make({ quotaBytes: 1e6 })
    const mk = async (o: TempOwner) => {
      const w = await t.begin(o, 'upload', { name: 'a', maxBytes: 10 })
      await w.write(bytes(1))
      return w.commit()
    }
    const a = await mk(alice)
    const b = await mk(bob)
    expect(await t.dropSession('s1')).toBe(1)
    expect(existsSync(a.path)).toBe(false)
    expect(existsSync(b.path)).toBe(true)
  })

  test('the sweeper starts once and can be stopped', () => {
    const t = make()
    t.startSweeper(10_000)
    t.startSweeper(10_000)
    t.stopSweeper()
  })
})
