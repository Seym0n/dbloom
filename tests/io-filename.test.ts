import { describe, expect, it } from 'vitest'
import {
  buildFileNames,
  contentDisposition,
  contentTypeFor,
  expandTemplate,
  sanitizeFileName,
} from '../src/server/io/filename'

const now = new Date(Date.UTC(2026, 9, 5, 7, 8, 9))
const ctx = { server: 'db.example', database: 'shop', table: 'orders', columns: ['a', 'b', 'c', 'd'], httpHost: 'app.test:3000', now }

describe('expandTemplate', () => {
  it('expands every token', () => {
    expect(expandTemplate('@SERVER@/@DATABASE@/@TABLE@/@COLUMNS@', ctx)).toBe('db.example/shop/orders/a-b-c')
    expect(expandTemplate('@YEAR@-@MONTH@-@DAY@_@HOUR@@MINUTE@@SECOND@', ctx)).toBe('2026-10-05_070809')
    expect(expandTemplate('@HTTP_HOST@', ctx)).toBe('app.test:3000')
  })
  it('leaves unknown tokens', () => expect(expandTemplate('@NOPE@_@year@', ctx)).toBe('@NOPE@_@year@'))
  it('does not re-expand values', () => {
    expect(expandTemplate('@TABLE@', { ...ctx, table: '@DATABASE@' })).toBe('@DATABASE@')
  })
})

describe('sanitizeFileName', () => {
  it.each([
    ['../x";.csv', '_x__.csv'],
    ['..', 'export'],
    ['', 'export'],
    ['.hidden', 'hidden'],
    ['a/b\\c', 'a_b_c'],
    ['a b\tc\nd', 'a_b_c_d'],
    ['Tabelle_Übersicht-1.2', 'Tabelle_Übersicht-1.2'],
    ['表データ', '表データ'],
    ['x\0y', 'x_y'],
    ['<img onerror=1>', '_img_onerror_1_'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['name.', 'name'],
  ])('%j -> %j', (input, out) => expect(sanitizeFileName(input)).toBe(out))
  it('normalises to NFC', () => {
    expect(sanitizeFileName('e' + String.fromCharCode(0x301))).toBe(String.fromCharCode(0xe9))
  })
  it('caps at 120 characters without cutting a code point', () => {
    expect(sanitizeFileName('a'.repeat(300))).toHaveLength(120)
    const emoji = sanitizeFileName(String.fromCodePoint(0x1f600).repeat(200))
    expect(emoji).toBe('_'.repeat(120))
  })
})

describe('buildFileNames', () => {
  it('adds the extension chain', () => {
    expect(buildFileNames('@TABLE@_@DATABASE@', ctx, 'sql', 'none')).toEqual({ entryName: 'orders_shop.sql', downloadName: 'orders_shop.sql' })
    expect(buildFileNames('x', ctx, 'csv', 'gzip')).toEqual({ entryName: 'x.csv', downloadName: 'x.csv.gz' })
    expect(buildFileNames('x', ctx, 'json', 'zip')).toEqual({ entryName: 'x.json', downloadName: 'x.json.zip' })
  })
  it('keeps an existing extension and empty becomes export', () => {
    expect(buildFileNames('dump.SQL', ctx, 'sql', 'none').entryName).toBe('dump.SQL')
    expect(buildFileNames('', ctx, 'csv', 'none').entryName).toBe('export.csv')
    expect(buildFileNames('@TABLE@', { now }, 'csv', 'none').entryName).toBe('export.csv')
  })
  it('hostile template stays harmless', () => {
    const n = buildFileNames('../../etc/passwd;"\r\nX: y', ctx, 'sql', 'none')
    expect(n.downloadName).toMatch(/^[\p{L}\p{N}_.-]+$/u)
    expect(n.downloadName.startsWith('.')).toBe(false)
  })
})

describe('contentTypeFor', () => {
  it('maps', () => {
    expect(contentTypeFor('sql', 'none')).toBe('application/sql')
    expect(contentTypeFor('csv', 'none')).toBe('text/csv; charset=utf-8')
    expect(contentTypeFor('json', 'none')).toBe('application/json')
    expect(contentTypeFor('json', 'gzip')).toBe('application/gzip')
    expect(contentTypeFor('sql', 'zip')).toBe('application/zip')
  })
})

describe('contentDisposition', () => {
  it('ASCII fallback plus filename*', () => {
    expect(contentDisposition('orders.csv')).toBe("attachment; filename=\"orders.csv\"; filename*=UTF-8''orders.csv")
    expect(contentDisposition('Übersicht 表.csv')).toBe(
      "attachment; filename=\"_bersicht__.csv\"; filename*=UTF-8''%C3%9Cbersicht%20%E8%A1%A8.csv",
    )
  })
  it('hostile names cannot break the header', () => {
    const h = contentDisposition('../x";.csv\r\nSet-Cookie: a=b')
    expect(h).not.toMatch(/[\r\n]/)
    const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9%._-]*)$/.exec(h)
    expect(m).not.toBeNull()
    expect(m?.[1]).not.toContain('/')
    expect(decodeURIComponent(m?.[2] ?? '')).not.toContain('/')
  })
  it('empty gives export', () => expect(contentDisposition('')).toContain('filename="export"'))
  it('encodes quote-like characters', () => {
    expect(contentDisposition("it's (1).csv")).toContain("filename*=UTF-8''it%27s%20%281%29.csv")
  })
})
