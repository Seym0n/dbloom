import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { unzipSync, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ArchiveError,
  ZipWriter,
  detectCompression,
  inflateGzip,
  looksLikeArchive,
  openSingleEntryZip,
  separateEntryName,
} from '../src/server/io/zip'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dbloom-zip-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function file(name: string, data: Uint8Array): Promise<string> {
  const p = join(dir, name)
  await writeFile(p, data)
  return p
}

async function readAll(s: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of s) parts.push(Buffer.from(c))
  return Buffer.concat(parts)
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ArchiveError)
    expect((e as ArchiveError).code).toBe(code)
    return
  }
  throw new Error('did not fail')
}

const limits = { maxBytes: 64 * 1024 * 1024 }

describe('detection', () => {
  it('magic bytes', () => {
    expect(detectCompression(Buffer.from([0x1f, 0x8b, 8]))).toBe('gzip')
    expect(detectCompression(Buffer.from('PK\x03\x04'))).toBe('zip')
    expect(detectCompression(Buffer.from('PK\x05\x06'))).toBe('zip')
    expect(detectCompression(Buffer.from('-- sql'))).toBe('none')
    expect(detectCompression(Buffer.alloc(0))).toBe('none')
    expect(looksLikeArchive(Buffer.from('BZh9'))).toBe(true)
    expect(looksLikeArchive(Buffer.from('SELECT 1'))).toBe(false)
  })
})

describe('entry names', () => {
  it('inserts the object before the last extension', () => {
    expect(separateEntryName('shop.sql', 'orders')).toBe('shop_orders.sql')
    expect(separateEntryName('a.b.csv', 'x')).toBe('a.b_x.csv')
    expect(separateEntryName('noext', 'x')).toBe('noext_x')
    expect(separateEntryName('shop.sql', '../evil/n')).toBe('shop__evil_n.sql')
  })
})

describe('ZipWriter', () => {
  function build(entries: [string, string[]][], level?: 0 | 6): Buffer {
    const out: Uint8Array[] = []
    const w = new ZipWriter((c) => out.push(c), level)
    for (const [name, chunks] of entries) {
      w.begin(name)
      for (const c of chunks) w.write(c)
    }
    w.finish()
    return Buffer.concat(out)
  }
  it('is readable by fflate with UTF-8 names and several entries', () => {
    const zip = build([
      ['shop_orders.csv', ['a,b\n', '1,2\n']],
      ['shop_Übersicht.csv', ['x'.repeat(100_000)]],
    ])
    const files = unzipSync(zip)
    expect(Object.keys(files)).toEqual(['shop_orders.csv', 'shop_Übersicht.csv'])
    expect(Buffer.from(files['shop_orders.csv'] as Uint8Array).toString()).toBe('a,b\n1,2\n')
    expect((files['shop_Übersicht.csv'] as Uint8Array).length).toBe(100_000)
  })
  it('is readable by our single-entry reader', async () => {
    const zip = build([['x.sql', ['SELECT 1;\n', '-- é\n']]])
    const { info, stream } = await openSingleEntryZip(await file('w.zip', zip), limits)
    expect(info.name).toBe('x.sql')
    expect((await readAll(stream)).toString()).toBe('SELECT 1;\n-- é\n')
  })
  it('is readable by the system unzip when present', async () => {
    const probe = spawnSync('unzip', ['-v'])
    if (probe.error) return
    const p = await file('sys.zip', build([['a.txt', ['hello ', 'world']]]))
    expect(execFileSync('unzip', ['-p', p, 'a.txt']).toString()).toBe('hello world')
  })
  it('refuses an entry past the 32-bit limit instead of writing wrong sizes (no ZIP64 writer)', () => {
    const w = new ZipWriter(() => undefined, 6, 1000)
    w.begin('big.bin')
    w.write(new Uint8Array(600))
    expect(() => w.write(new Uint8Array(600))).toThrow(/4 GiB/)
    const v = new ZipWriter(() => undefined, 0, 1000)
    v.begin('a')
    v.write(new Uint8Array(980))
    v.endEntry()
    v.begin('b')
    expect(() => v.write(new Uint8Array(200))).toThrow(/4 GiB/)
  })
  it('refuses writes after finish and without an entry', () => {
    const w = new ZipWriter(() => undefined)
    expect(() => w.write('x')).toThrow()
    w.finish()
    expect(() => w.begin('x')).toThrow()
  })
})

describe('openSingleEntryZip', () => {
  const text = 'INSERT INTO t VALUES (1);\n'.repeat(1000)
  it('reads a deflated and a stored entry', async () => {
    const deflated = zipSync({ 'd.sql': Buffer.from(text) })
    const r1 = await openSingleEntryZip(await file('one.zip', deflated), limits)
    expect((await readAll(r1.stream)).toString()).toBe(text)
    const stored = zipSync({ 's.sql': [Buffer.from(text), { level: 0 }] })
    const r2 = await openSingleEntryZip(await file('stored.zip', stored), limits)
    expect(r2.info.method).toBe(0)
    expect((await readAll(r2.stream)).toString()).toBe(text)
  })
  it('refuses two entries', async () => {
    const p = await file('two.zip', zipSync({ 'a.sql': Buffer.from('a'), 'b.sql': Buffer.from('b') }))
    await expectCode(openSingleEntryZip(p, limits), 'archive_not_allowed')
  })
  it('refuses an empty zip', async () => {
    await expectCode(openSingleEntryZip(await file('empty.zip', zipSync({})), limits), 'archive_not_allowed')
  })
  it('refuses a zip inside a zip', async () => {
    const inner = zipSync({ 'in.sql': Buffer.from('SELECT 1;') })
    const p = await file('nested.zip', zipSync({ 'in.zip': [inner, { level: 0 }] }))
    const { stream } = await openSingleEntryZip(p, limits)
    await expectCode(readAll(stream), 'archive_not_allowed')
  })
  it('refuses a gzip inside a zip', async () => {
    const p = await file('gzin.zip', zipSync({ 'in.gz': Buffer.from(gzipSync('SELECT 1;')) }))
    const { stream } = await openSingleEntryZip(p, limits)
    await expectCode(readAll(stream), 'archive_not_allowed')
  })
  it('refuses encrypted entries', async () => {
    const zip = Buffer.from(zipSync({ 'a.sql': Buffer.from('abc') }))
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt16LE(zip.readUInt16LE(cen + 8) | 1, cen + 8)
    await expectCode(openSingleEntryZip(await file('enc.zip', zip), limits), 'archive_not_allowed')
  })
  it('refuses multi-disk archives', async () => {
    const zip = Buffer.from(zipSync({ 'a.sql': Buffer.from('abc') }))
    zip.writeUInt16LE(1, zip.length - 22 + 4)
    await expectCode(openSingleEntryZip(await file('disk.zip', zip), limits), 'archive_not_allowed')
  })
  it('refuses non-zip and truncated files', async () => {
    await expectCode(openSingleEntryZip(await file('plain.zip', Buffer.from('PK\x03\x04 nothing')), limits), 'not_archive')
    const zip = zipSync({ 'a.sql': Buffer.from('x'.repeat(5000)) })
    await expectCode(openSingleEntryZip(await file('cut.zip', zip.subarray(0, zip.length - 30)), limits), 'not_archive')
  })
  it('stops a zip bomb by ratio while inflating', async () => {
    const bomb = zipSync({ 'z.sql': Buffer.alloc(40 * 1024 * 1024) })
    expect(bomb.length).toBeLessThan(100 * 1024)
    const { stream } = await openSingleEntryZip(await file('bomb.zip', bomb), { maxBytes: 1024 * 1024 * 1024 })
    let seen = 0
    try {
      for await (const c of stream) seen += (c as Buffer).length
      throw new Error('not stopped')
    } catch (e) {
      expect((e as ArchiveError).code).toBe('ratio_exceeded')
    }
    expect(seen).toBeLessThan(40 * 1024 * 1024)
  })
  it('stops at the size cap, also when the header lies about the size', async () => {
    const zip = Buffer.from(zipSync({ 'z.sql': Buffer.from('ab'.repeat(2_000_000)) }))
    const p = await file('cap.zip', zip)
    await expectCode(openSingleEntryZip(p, { maxBytes: 1_000_000 }), 'decompressed_too_large')
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(10, cen + 24) // lie: claims 10 bytes
    const { stream } = await openSingleEntryZip(await file('lie.zip', zip), { maxBytes: 1_000_000, ratio: 100000 })
    await expectCode(readAll(stream), 'decompressed_too_large')
  })
  it('detects a size or checksum mismatch', async () => {
    const zip = Buffer.from(zipSync({ 'a.sql': Buffer.from('hello world') }))
    const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(zip.readUInt32LE(cen + 16) ^ 1, cen + 16)
    const { stream } = await openSingleEntryZip(await file('crc.zip', zip), limits)
    await expectCode(readAll(stream), 'not_archive')
  })
})

describe('inflateGzip', () => {
  it('streams a gzip', async () => {
    const text = 'row\n'.repeat(5000)
    const p = await file('ok.gz', gzipSync(text))
    expect((await readAll(inflateGzip(createReadStream(p), limits))).toString()).toBe(text)
  })
  it('concatenated members decode', async () => {
    const p = await file('multi.gz', Buffer.concat([gzipSync('a'), gzipSync('b')]))
    expect((await readAll(inflateGzip(createReadStream(p), limits))).toString()).toBe('ab')
  })
  it('truncated gzip fails with not_archive', async () => {
    const gz = gzipSync('x'.repeat(100_000))
    const p = await file('cut.gz', gz.subarray(0, gz.length - 8))
    await expectCode(readAll(inflateGzip(createReadStream(p), limits)), 'not_archive')
  })
  it('garbage fails with not_archive', async () => {
    const p = await file('junk.gz', Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    await expectCode(readAll(inflateGzip(createReadStream(p), limits)), 'not_archive')
  })
  it('ratio and size cap on gzip', async () => {
    const p = await file('bomb.gz', gzipSync(Buffer.alloc(30 * 1024 * 1024)))
    await expectCode(readAll(inflateGzip(createReadStream(p), { maxBytes: 1 << 30 })), 'ratio_exceeded')
    const q = await file('cap.gz', gzipSync(Buffer.from('word '.repeat(1_000_000))))
    await expectCode(readAll(inflateGzip(createReadStream(q), { maxBytes: 100_000, ratio: 1e9 })), 'decompressed_too_large')
  })
})
