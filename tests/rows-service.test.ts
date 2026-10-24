import { describe, expect, test } from 'vitest'
import {
  CellHandleStore,
  CONTENT_TYPES,
  safeFileName,
  sniffPreviewType,
  UploadRefusal,
  UploadStore,
} from '~/server/rows/blob'
import { changedColumns, fieldOf, hashableParams, isConnectionLost } from '~/server/rows/execute'
import { clientError } from '~/server/rows/service'
import { StructureRefusal, mapMysqlError } from '~/server/structure/errors'
import { WriteGuardError } from '~/server/guard/write-guard'
import { hashStatements } from '~/server/structure/deps'
import { PrefsError } from '~/server/rows/prefs'
import type { RowTable } from '~/server/rows/types'

const bytes = (...b: number[]) => Uint8Array.from(b)

describe('magic bytes', () => {
  test('the five previewable types are recognised; everything else is not', () => {
    expect(sniffPreviewType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png')
    expect(sniffPreviewType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg')
    expect(sniffPreviewType(Buffer.from('GIF89a'))).toBe('gif')
    expect(sniffPreviewType(Buffer.from('RIFF\0\0\0\0WEBP'))).toBe('webp')
    expect(sniffPreviewType(Buffer.from('%PDF-1.7'))).toBe('pdf')
    expect(sniffPreviewType(Buffer.from('<svg onload=alert(1)>'))).toBeUndefined()
    expect(sniffPreviewType(Buffer.from('<!doctype html>'))).toBeUndefined()
    expect(sniffPreviewType(Buffer.from('hello'))).toBeUndefined()
    expect(sniffPreviewType(bytes())).toBeUndefined()
    expect(Object.keys(CONTENT_TYPES).sort()).toEqual(['gif', 'jpeg', 'pdf', 'png', 'webp'])
  })
  test('file names carry nothing but letters, digits, underscore and dash', () => {
    expect(safeFileName('my table', 'col"umn\r\n', 'png')).toBe('my_table-col_umn.png')
    expect(safeFileName('../../etc/passwd', '`x`')).toBe('etc_passwd-x.bin')
    expect(safeFileName('ü/ä&x', '日本')).toMatch(/^[A-Za-z0-9_.-]+$/)
  })
})

describe('one-time cell handles', () => {
  const data = {
    db: 'd',
    table: 't',
    key: { id: { t: 'v', v: '1' } },
    column: 'c',
    size: 3,
    disposition: 'download' as const,
    fileName: 't-c.bin',
  }
  test('single use, owner only, 60 seconds', () => {
    let now = 1000
    const s = new CellHandleStore(() => now)
    const h = s.create('a', data)
    expect(h.expiresAt).toBe(61_000)
    expect(s.take('b', h.id)).toBeUndefined()
    expect(s.take('a', 'unknown')).toBeUndefined()
    expect(s.take('a', h.id)?.column).toBe('c')
    expect(s.take('a', h.id)).toBeUndefined()
    const late = s.create('a', data)
    now += 60_000
    expect(s.take('a', late.id)).toBeUndefined()
    expect(s.size).toBe(0)
  })
  test('ids are random and the number per session is bounded', () => {
    const s = new CellHandleStore(Date.now, 60_000, 3)
    const ids = new Set(Array.from({ length: 3 }, () => s.create('a', data).id))
    expect(ids.size).toBe(3)
    s.create('a', data)
    expect(s.size).toBe(3)
    s.create('b', data)
    s.dropSession('a')
    expect(s.size).toBe(1)
  })
})

describe('upload staging', () => {
  test('bytes, sha256, detected type; only the owner sees it; consumed once', () => {
    const s = new UploadStore()
    const png = Buffer.concat([
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      Buffer.alloc(4),
    ])
    const u = s.put('a', png, 'x.png')
    expect(u.sha256).toHaveLength(64)
    expect(u.previewType).toBe('png')
    expect(s.peek('b', u.uploadId)).toBeUndefined()
    expect(s.peek('a', u.uploadId)?.bytes.equals(png)).toBe(true)
    s.consume(u.uploadId)
    expect(s.peek('a', u.uploadId)).toBeUndefined()
  })
  test('expires after 10 minutes; a session holds at most its byte budget', () => {
    let now = 0
    const s = new UploadStore(() => now, 600_000, 100)
    const u = s.put('a', Buffer.alloc(60))
    expect(() => s.put('a', Buffer.alloc(60))).toThrow(UploadRefusal)
    s.put('b', Buffer.alloc(60))
    now = 600_000
    expect(s.peek('a', u.uploadId)).toBeUndefined()
    expect(() => s.put('a', Buffer.alloc(100))).not.toThrow()
  })
})

describe('plan hashing of values', () => {
  const stmt = (params: unknown[]) => ({
    sql: 'UPDATE t SET a = ?',
    kind: 'rowUpdate' as const,
    class: 'hard' as const,
    effect: 'x',
    params,
  })
  test('the hash binds the values', () => {
    expect(hashStatements([stmt(['a'])])).not.toBe(hashStatements([stmt(['b'])]))
    expect(hashStatements([stmt(['a'])])).toBe(hashStatements([stmt(['a'])]))
  })
  test('a large upload is bound by size and digest, not by its bytes', () => {
    const big = Buffer.alloc(5000, 1)
    const other = Buffer.alloc(5000, 2)
    const a = hashableParams([big])
    expect(JSON.stringify(a).length).toBeLessThan(200)
    expect(hashStatements([stmt(a)])).not.toBe(hashStatements([stmt(hashableParams([other]))]))
    expect(hashableParams([Buffer.from('small')])[0]).toBeInstanceOf(Buffer)
  })
})

describe('conflict detection helpers', () => {
  const columns = ['id', 'name', 'note', 'doc']
  test('lists the columns whose old value no longer matches', () => {
    const cells = ['1', 'Anna', null, { binary: 'ab', size: 9 }]
    expect(
      changedColumns({ name: { t: 'v', v: 'Ann' }, note: { t: 'null' } }, columns, cells, {}),
    ).toEqual(['name'])
    expect(changedColumns({ note: { t: 'v', v: 'x' } }, columns, cells, {})).toEqual(['note'])
    expect(changedColumns({ name: { t: 'null' } }, columns, cells, {})).toEqual(['name'])
  })
  test('digest columns compare by digest; cut or binary cells without digest are not guessed', () => {
    const cells = ['1', 'Anna', null, { binary: 'ab', size: 9 }]
    const d = 'a'.repeat(64)
    expect(changedColumns({ doc: { t: 'digest', v: d } }, columns, cells, { doc: d })).toEqual([])
    expect(
      changedColumns({ doc: { t: 'digest', v: d } }, columns, cells, { doc: 'b'.repeat(64) }),
    ).toEqual(['doc'])
    expect(changedColumns({ doc: { t: 'v', v: 'x' } }, columns, cells, {})).toEqual([])
  })
  test('the field of a server message is found in the model only', () => {
    const table = { columns: [{ name: 'flag' }, { name: "o'x" }] } as unknown as RowTable
    expect(fieldOf("Column 'flag' cannot be null", table)).toBe('flag')
    expect(fieldOf("Data too long for column 'flag' at row 1", table)).toBe('flag')
    expect(fieldOf("Column 'other' cannot be null", table)).toBeUndefined()
    expect(fieldOf('Duplicate entry for key email', table)).toBeUndefined()
  })
  test('a dropped or timed-out connection is recognised', () => {
    expect(isConnectionLost({ fatal: true })).toBe(true)
    expect(isConnectionLost({ connectionUsable: false })).toBe(true)
    expect(isConnectionLost({ errno: 1062 })).toBe(false)
  })
})

describe('what the client may see of an error', () => {
  test('refusals, guard and preference errors keep their code', () => {
    expect(clientError(new StructureRefusal('no-identity', 'nope')).message).toBe(
      'no-identity: nope',
    )
    expect(
      clientError(new WriteGuardError('read-only', 'This connection is read-only.')).message,
    ).toBe('read-only: This connection is read-only.')
    expect(clientError(new PrefsError('invalid-value', 'Invalid value')).message).toBe(
      'invalid-value: Invalid value',
    )
  })
  test('a server error becomes its number, message and hint; the raw error is never passed on', () => {
    const raw = Object.assign(new Error('boom'), {
      errno: 1451,
      sqlMessage: 'Cannot delete a parent row',
      sql: 'DELETE FROM secret WHERE token = ?',
      code: 'ER_ROW_IS_REFERENCED_2',
    })
    const e = clientError(raw)
    expect(e.message).toContain('1451')
    expect(e.message).toContain('Cannot delete a parent row')
    expect(e.message).not.toContain('secret')
    expect(e.stack ?? '').not.toContain('ER_ROW_IS_REFERENCED_2')
  })
  test('anything else is neutral', () => {
    expect(clientError(new TypeError('internal detail /etc/passwd')).message).toBe(
      'unexpected_error',
    )
    expect(clientError('string').message).toBe('unexpected_error')
  })
  test('the row hints reach the mapper', () => {
    for (const errno of [1048, 1264, 1292, 1366, 1406, 3105, 3140]) {
      expect(mapMysqlError({ errno, sqlMessage: 'm', code: 'X' }).hint).toBeTruthy()
    }
    expect(mapMysqlError({ errno: 1062, sqlMessage: 'dup', code: 'X' }).hint).toMatch(/unique/)
  })
})
