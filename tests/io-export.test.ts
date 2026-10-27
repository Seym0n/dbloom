import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'
import { ExportRefusal, checkExportRequest } from '~/server/io/export'
import {
  exportTypeCast,
  kindOfDataType,
  kindOfWireType,
  selectSql,
  toCell,
  viewReferences,
  batchRows,
  BATCH_ROWS,
} from '~/server/io/export-catalog'
import { TextLimitReached, createSink, utf8Prefix } from '~/server/io/export-sink'
import {
  deleteTemplateImpl,
  getIoPrefsImpl,
  ioClientError,
  ioPrefsPatch,
  listTemplatesImpl,
  saveTemplateImpl,
  setIoPrefsImpl,
  type ExportServiceEnv,
} from '~/server/io/export-service'
import { conditionalCreate } from '~/server/io/sql-writer'
import { JsonExportWriter } from '~/server/io/json'
import { JobError } from '~/server/io/jobs'
import { resolveIoLimits } from '~/server/io/limits'
import { MemoryIoPrefs, MemoryIoTemplates, setIoPref } from '~/server/io/store'
import { TempStore } from '~/server/io/temp'
import { exportRequest, MAX_TEMPLATES, type ExportRequest } from '~/server/io/types'

const req = (o: Record<string, unknown>): ExportRequest =>
  exportRequest.parse({ scope: { kind: 'table', db: 'd', table: 't' }, format: 'sql', compression: 'none', ...o })
const limits = resolveIoLimits()

describe('request rules (FR-IO-002, FR-IOX-015)', () => {
  test('the closed schema refuses unknown fields, formats and options', () => {
    const base = { scope: { kind: 'table', db: 'd', table: 't' }, compression: 'none' }
    expect(() => exportRequest.parse({ ...base, format: 'xml' })).toThrow()
    expect(() => exportRequest.parse({ ...base, format: 'sql', sql: 'SELECT 1' })).toThrow()
    expect(() => exportRequest.parse({ ...base, format: 'sql', options: { nope: true } })).toThrow()
    expect(() => exportRequest.parse({ ...base, format: 'sql', scope: { kind: 'table', db: 'd', table: 't', where: '1=1' } })).toThrow()
    expect(() => exportRequest.parse({ ...base, format: 'csv', options: { separator: '\\' } })).toThrow()
  })

  test('enabled formats and compressions are checked', () => {
    expect(() => checkExportRequest(req({}), limits)).not.toThrow()
    expect(() => checkExportRequest(req({ format: 'json' }), { ...limits, formats: ['sql'] })).toThrow(/not enabled/)
    expect(() => checkExportRequest(req({ compression: 'zip' }), { ...limits, compressions: ['none'] })).toThrow(ExportRefusal)
  })

  test('combinations the form cannot produce are refused', () => {
    expect(() => checkExportRequest(req({ separateFiles: true }), limits)).toThrow(/Separate files/)
    expect(() => checkExportRequest(req({ view: 'text', compression: 'gzip' }), limits)).toThrow(/cannot be compressed/)
    expect(() => checkExportRequest(req({ view: 'text', format: 'csv', scope: { kind: 'database', db: 'd' } }), limits)).toThrow(/zip/)
    expect(() => checkExportRequest(req({ view: 'text', format: 'csv' }), limits)).not.toThrow()
    expect(() => checkExportRequest(req({ separateFiles: true, scope: { kind: 'database', db: 'd' }, compression: 'zip' }), limits)).not.toThrow()
  })
})

describe('catalog helpers', () => {
  test('type kinds from the catalog and from the wire', () => {
    expect(kindOfDataType('BIGINT')).toBe('int')
    expect(kindOfDataType('decimal')).toBe('decimal')
    expect(kindOfDataType('mediumtext')).toBe('text')
    expect(kindOfDataType('varbinary')).toBe('binary')
    expect(kindOfDataType('point')).toBe('geometry')
    expect(kindOfDataType('inet6')).toBe('char')
    expect(kindOfDataType('weird')).toBe('unknown')
    expect(kindOfWireType(8, false)).toBe('int')
    expect(kindOfWireType(246, false)).toBe('decimal')
    expect(kindOfWireType(252, true)).toBe('blob')
    expect(kindOfWireType(252, false)).toBe('text')
    expect(kindOfWireType(253, true)).toBe('binary')
    expect(kindOfWireType(255, true)).toBe('geometry')
  })

  test('select list, float widening and the ordered row range', () => {
    expect(selectSql('d`b', 't', [{ name: 'a' }, { name: 'f`x', single: true }])).toBe(
      'SELECT `a`, (`f``x` + 0e0) AS `f``x` FROM `d``b`.`t`',
    )
    expect(selectSql('d', 't', [{ name: 'a' }], { offset: 5, count: 10 }, ['id', 'n'])).toBe(
      'SELECT `a` FROM `d`.`t` ORDER BY `id`, `n` LIMIT 5, 10',
    )
    expect(selectSql('d', 't', [{ name: 'a' }], { offset: 5, count: 10 })).not.toContain('ORDER BY')
  })

  test('cells: exact text, bytes and NULL', () => {
    expect(toCell(null)).toBeNull()
    expect(toCell(12)).toBe('12')
    expect(toCell(12n ** 20n)).toBe('3833759992447475122176')
    expect(toCell('x')).toBe('x')
    const b = Buffer.from([1, 2])
    expect(toCell(b)).toBe(b)
    expect(toCell(new Date(Date.UTC(2026, 9, 27, 1, 2, 3)))).toBe('2026-10-27 01:02:03')
  })

  test('type cast gives strings for numbers and dates, bytes for geometry, the default otherwise', () => {
    const field = (type: string) => ({ type, string: (e?: string) => `s:${type}:${e ?? ''}`, buffer: () => Buffer.from('b') })
    expect(exportTypeCast(field('NEWDECIMAL'), () => 'next')).toBe('s:NEWDECIMAL:')
    expect(exportTypeCast(field('JSON'), () => 'next')).toBe('s:JSON:utf8')
    expect(exportTypeCast(field('GEOMETRY'), () => 'next')).toEqual(Buffer.from('b'))
    expect(exportTypeCast(field('BLOB'), () => 'next')).toBe('next')
  })

  test('views refer to views by quoted name, with or without the database', () => {
    const mysql = 'CREATE VIEW `top` AS select `base`.`id` AS `id` from `base`'
    const maria = 'CREATE ALGORITHM=UNDEFINED VIEW `d`.`top` AS select `d`.`base`.`id` from `d`.`base`'
    expect(viewReferences(mysql, 'd', ['base', 'other'])).toEqual(['base'])
    expect(viewReferences(maria, 'd', ['base', 'other'])).toEqual(['base'])
    // the view's own name before AS is not a reference
    expect(viewReferences('CREATE VIEW `base` (`a`) AS select 1', 'd', ['base'])).toEqual([])
  })

  test('rows are grouped by count', async () => {
    const rows = (async function* () {
      for (let i = 0; i < BATCH_ROWS * 2 + 3; i++) yield [String(i)]
    })()
    const sizes: number[] = []
    for await (const b of batchRows(rows)) sizes.push(b.length)
    expect(sizes).toEqual([BATCH_ROWS, BATCH_ROWS, 3])
  })
})

describe('IF NOT EXISTS for programs and views (DATA-ISS-106)', () => {
  test('views are replaced, programs get the clause', () => {
    expect(conditionalCreate('view', 'CREATE ALGORITHM=UNDEFINED DEFINER=`r`@`%` VIEW `v` AS select 1')).toMatch(/^CREATE OR REPLACE ALGORITHM/)
    expect(conditionalCreate('view', 'CREATE OR REPLACE VIEW v AS select 1')).toBe('CREATE OR REPLACE VIEW v AS select 1')
    expect(conditionalCreate('trigger', 'CREATE DEFINER=`r`@`%` TRIGGER `t` BEFORE INSERT ON `a` FOR EACH ROW SET @x=1')).toContain('TRIGGER IF NOT EXISTS `t`')
    expect(conditionalCreate('procedure', 'CREATE DEFINER=`a b`@`h` PROCEDURE `p`() SELECT 1')).toContain('PROCEDURE IF NOT EXISTS `p`')
    expect(conditionalCreate('function', 'CREATE FUNCTION `f`() RETURNS int RETURN 1')).toContain('FUNCTION IF NOT EXISTS `f`')
    expect(conditionalCreate('event', 'CREATE DEFINER=`r`@`%` EVENT `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1')).toContain('EVENT IF NOT EXISTS `e`')
    expect(conditionalCreate('event', 'CREATE EVENT IF NOT EXISTS `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1')).toBe('CREATE EVENT IF NOT EXISTS `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1')
  })
})

describe('JSON skipped element (FR-IO-010)', () => {
  test('is a valid array element', () => {
    const w = new JsonExportWriter({ pretty: false, unicode: true })
    const text = w.begin('1') + w.database('d') + w.skipped('d.t', 'SELECT command denied') + w.end()
    expect(JSON.parse(text)[2]).toEqual({ type: 'skipped', object: 'd.t', message: 'SELECT command denied' })
  })
})

describe('output sinks (FR-IO-008)', () => {
  let root: string
  let temp: TempStore
  const owner = { sessionId: 's', user: 'u' }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'io-sink-'))
    temp = new TempStore({ dir: root, quotaBytes: 100 * 1024 * 1024 })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const spool = async (compression: 'none' | 'gzip' | 'zip', fill: (s: ReturnType<typeof createSink>) => Promise<void>, textLimit?: number) => {
    const writer = await temp.begin(owner, 'spool', { name: 'x', maxBytes: 100 * 1024 * 1024 })
    const sink = createSink(compression, writer, { textLimit })
    try {
      await fill(sink)
      await sink.finish()
    } catch (e) {
      await sink.finish().catch(() => undefined)
      await writer.commit()
      throw e
    }
    const file = await writer.commit()
    return { file, sink, bytes: readFileSync(file.path) }
  }

  test('none, gzip and zip hold the same text', async () => {
    const text = 'zeile ü 日本語\n'.repeat(5000)
    const fill = async (s: ReturnType<typeof createSink>) => {
      await s.begin('a.txt')
      for (let i = 0; i < 100; i++) await s.write(text.slice(i * 700, (i + 1) * 700))
      await s.write(text.slice(70000))
      await s.endEntry()
    }
    expect((await spool('none', fill)).bytes.toString('utf8')).toBe(text)
    expect(gunzipSync((await spool('gzip', fill)).bytes).toString('utf8')).toBe(text)
    const z = unzipSync(new Uint8Array((await spool('zip', fill)).bytes))
    expect(Buffer.from(z['a.txt']!).toString('utf8')).toBe(text)
  })

  test('a zip holds several entries with UTF-8 names', async () => {
    const { bytes } = await spool('zip', async (s) => {
      await s.begin('ä_1.csv')
      await s.write('one')
      await s.endEntry()
      await s.begin('日本_2.csv')
      await s.write('two')
      await s.endEntry()
    })
    const z = unzipSync(new Uint8Array(bytes))
    expect(Object.keys(z)).toEqual(['ä_1.csv', '日本_2.csv'])
    expect(Buffer.from(z['日本_2.csv']!).toString()).toBe('two')
  })

  test('a plain or gzip output has one file only', async () => {
    await expect(
      spool('none', async (s) => {
        await s.begin('a')
        await s.begin('b')
      }),
    ).rejects.toThrow(/one file/)
  })

  test('the text view cuts at the limit on a character boundary', async () => {
    const r = await spool(
      'none',
      async (s) => {
        await s.begin('a')
        await s.write('ab')
        await s.write('日本語') // 9 bytes; room for 2 + 4 leaves only one whole character
      },
      6,
    ).catch((e: unknown) => e)
    expect(r).toBeInstanceOf(TextLimitReached)
    // utf8Prefix itself
    const buf = Buffer.from('a日')
    expect(utf8Prefix(buf, 2).toString()).toBe('a')
    expect(utf8Prefix(buf, 4).toString()).toBe('a日')
    expect(utf8Prefix(Buffer.from('abc'), 10).toString()).toBe('abc')
  })
})

describe('templates and defaults (FR-IO-011)', () => {
  const env = (): ExportServiceEnv =>
    ({
      owner: { sessionId: 's', user: 'u1' },
      limits,
      prefs: new MemoryIoPrefs(),
      templates: new MemoryIoTemplates(),
      targetLabel: 'h:1',
    }) as unknown as ExportServiceEnv

  test('save, list, update and delete per format', () => {
    const e = env()
    saveTemplateImpl(e, { name: 'excel', format: 'csv', options: { preset: 'excel' } })
    saveTemplateImpl(e, { name: 'excel', format: 'json', options: { pretty: false } })
    saveTemplateImpl(e, { name: 'excel', format: 'csv', options: { preset: 'excel', bom: true } })
    const list = listTemplatesImpl(e)
    expect(list.map((t) => `${t.format}:${t.name}`)).toEqual(['csv:excel', 'json:excel'])
    expect(list[0]!.options).toMatchObject({ preset: 'excel', bom: true, separator: ',' })
    deleteTemplateImpl(e, { name: 'excel', format: 'csv' })
    expect(listTemplatesImpl(e).map((t) => t.format)).toEqual(['json'])
    // other owners see nothing
    expect(listTemplatesImpl({ ...e, owner: { sessionId: 's', user: 'u2' } })).toEqual([])
  })

  test('options of another format, unknown keys and bad names are refused; 50 at most', () => {
    const e = env()
    expect(() => saveTemplateImpl(e, { name: 'x', format: 'sql', options: { separator: ';' } })).toThrow(ExportRefusal)
    expect(() => saveTemplateImpl(e, { name: 'x', format: 'csv', options: { sql: 'DROP TABLE t' } })).toThrow()
    expect(() => saveTemplateImpl(e, { name: '   ', format: 'csv', options: {} })).toThrow()
    for (let i = 0; i < MAX_TEMPLATES; i++) saveTemplateImpl(e, { name: `n${i}`, format: 'csv', options: {} })
    expect(() => saveTemplateImpl(e, { name: 'one more', format: 'csv', options: {} })).toThrow(/Too many/)
    // the limit is per format
    expect(() => saveTemplateImpl(e, { name: 'one more', format: 'json', options: {} })).not.toThrow()
  })

  test('defaults round trip, a stale stored value is replaced visibly (FR-UPD-004)', () => {
    const e = env()
    expect(getIoPrefsImpl(e)).toEqual({ mode: 'quick', exportFormat: 'sql', exportCompression: 'none', importFormat: 'sql', fileNameTemplates: {}, dragDrop: true })
    const set = setIoPrefsImpl(e, { mode: 'custom', exportFormat: 'csv', exportCompression: 'zip', fileNameTemplates: { table: '@TABLE@_x' }, dragDrop: false })
    expect(set).toMatchObject({ mode: 'custom', exportFormat: 'csv', exportCompression: 'zip', dragDrop: false, fileNameTemplates: { table: '@TABLE@_x' } })
    expect(getIoPrefsImpl(e)).toEqual(set)
    // a stored default that no longer passes the schema
    const store = e.prefs as MemoryIoPrefs
    store.set('u1', 'h:1', 'io.exportFormat', 'xml')
    expect(getIoPrefsImpl(e).exportFormat).toBe('sql')
    expect(store.get('u1', 'h:1')['io.exportFormat']).toBe('sql')
    // formats the administrator removed fall back to an enabled one
    const narrow = { ...e, limits: { ...limits, formats: ['json'] as ('json')[] } }
    setIoPref(store, 'u1', 'h:1', 'io.exportFormat', 'csv')
    expect(getIoPrefsImpl(narrow as unknown as ExportServiceEnv).exportFormat).toBe('json')
  })

  test('the patch schema is closed', () => {
    expect(() => ioPrefsPatch.parse({ mode: 'turbo' })).toThrow()
    expect(() => ioPrefsPatch.parse({ other: 1 })).toThrow()
    expect(() => ioPrefsPatch.parse({ fileNameTemplates: { nope: 'x' } })).toThrow()
    expect(ioPrefsPatch.parse({})).toEqual({})
    expect(ioPrefsPatch.parse({ fileNameTemplates: { table: 'x' } })).toEqual({ fileNameTemplates: { table: 'x' } })
  })
})

describe('client errors', () => {
  test('code: message, nothing else leaks', () => {
    expect(ioClientError(new ExportRefusal('format_disabled', 'x')).message).toBe('format_disabled: x')
    expect(ioClientError(new JobError('busy', 'Too many export jobs are running')).message).toBe('busy: Too many export jobs are running')
    expect(ioClientError(new JobError('not_found', 'Unknown job')).message).toBe('invalid_request: Unknown job')
    expect(ioClientError(new Error('ECONNREFUSED 10.0.0.1:3306 secret')).message).toBe('export_failed: The request could not be handled')
  })
})
