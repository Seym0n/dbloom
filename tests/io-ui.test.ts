import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import en from '~/i18n/en.json'
import { t } from '~/i18n'
import { ImportConfirmDialog } from '~/components/io/import-confirm-dialog'
import { DropTarget, hasFiles, UploadList, UploadStatusPanel } from '~/components/io/drop-overlay'
import { ExportTab } from '~/components/io/export-tab'
import { JobProgressView, JobResultView } from '~/components/io/job-progress'
import { MappingStep, SamplePreview, looksMerged } from '~/components/io/mapping-step'
import { OptionPanel } from '~/components/io/option-panel'
import { filterItems, ScopePicker } from '~/components/io/scope-picker'
import {
  buildExportRequest,
  expandTemplate,
  initialExportState,
  normalizeExport,
  previewFileName,
  sanitizeFileName,
  selectionList,
  validateExport,
  type ExportTarget,
} from '~/components/io/export-model'
import {
  autoMap,
  buildStartRequest,
  inferType,
  kindsLine,
  proposeColumns,
  reviewToMaps,
  startBlock,
  toTableDefinition,
  validateMapping,
  validateReview,
} from '~/components/io/import-model'
import {
  codeMessage,
  describeIoFailure,
  ERROR_KEYS,
  formatBytes,
  fraction,
  STATE_KEYS,
} from '~/components/io/job-model'
import {
  changeOption,
  defaultValues,
  DOC_HOSTS,
  EXPORT_OPTIONS,
  ROW_IMPORT_OPTIONS,
  safeDocUrl,
  SQL_IMPORT_OPTIONS,
  validateOptions,
  visibleOptions,
} from '~/components/io/registry'
import { DEFAULT_PREFS, createServerIoApi, setIoApi } from '~/lib/io/api'
import { createMockIoApi } from '~/lib/io/mock-api'
import { checkFileName, uploadFile, UploadError, type XhrLike } from '~/lib/io/upload'
import { uploadFraction, uploadReducer, type UploadItem } from '~/lib/io/use-uploads'
import { isActive, isTerminal, pollDelay } from '~/lib/io/use-job'
import {
  exportRequest,
  startImportRequest,
  IO_ERROR_CODES,
  MiB,
  type ImportAnalysis,
  type IoCapabilities,
  type IoJob,
} from '~/server/io/types'
import { tableDefinition } from '~/server/structure/types'

const caps: IoCapabilities = {
  formats: ['sql', 'csv', 'json'],
  compressions: ['none', 'gzip', 'zip'],
  limits: {
    uploadBytes: 64 * MiB,
    decompressedBytes: 1024 * MiB,
    jobMs: 900_000,
    maxExportBytes: 1024 * MiB,
    serverFolderEnabled: false,
    formulaNeutralisation: true,
    mayDisableFormulaNeutralisation: true,
  },
  charsets: [{ name: 'utf-8', label: 'Unicode (UTF-8)' }],
  target: { product: 'mysql', version: '8.4.0' },
}

const html = (el: ReactElement) => renderToStaticMarkup(el)

/**
 * A small stand-in for the structural part of an axe run (axe-core needs a DOM, which this node test
 * environment does not have; the Playwright specs run the real axe): every form control has an accessible
 * name, ids are unique, `for` targets exist, images have alt.
 */
function a11yProblems(markup: string): string[] {
  const out: string[] = []
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string)
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dup.length) out.push(`duplicate ids: ${dup.join(',')}`)
  const labelFor = new Set([...markup.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]))
  for (const f of labelFor) if (!ids.includes(f as string)) out.push(`label for missing id ${f}`)
  const controls = markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)
  for (const m of controls) {
    const attrs = m[2] ?? ''
    if (/type="hidden"/.test(attrs)) continue
    const id = /\sid="([^"]+)"/.exec(` ${attrs}`)?.[1]
    const named =
      /aria-label="[^"]+"/.test(attrs) ||
      /aria-labelledby="/.test(attrs) ||
      (id !== undefined && labelFor.has(id))
    // A radio or checkbox may sit inside its <label>; accept that by looking for an enclosing label.
    if (!named) {
      const before = markup.slice(0, m.index)
      const open = before.lastIndexOf('<label')
      const close = before.lastIndexOf('</label>')
      if (!(open > close)) out.push(`unnamed control: ${m[0].slice(0, 80)}`)
    }
  }
  for (const m of markup.matchAll(/<img\b([^>]*)>/g))
    if (!/\salt=/.test(m[1] ?? '')) out.push('img without alt')
  for (const m of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const text = (m[2] ?? '').replace(/<[^>]*>/g, '').trim()
    if (!text && !/aria-label="[^"]+"/.test(m[1] ?? '')) out.push('button without name')
  }
  return out
}

describe('a11y helper', () => {
  test('finds unnamed controls, duplicate ids and nameless buttons', () => {
    expect(a11yProblems('<input id="a"><button></button>').length).toBe(2)
    expect(a11yProblems('<div id="x"></div><div id="x"></div>').length).toBe(1)
    expect(a11yProblems('<label for="a">A</label><input id="a">')).toEqual([])
    expect(a11yProblems('<label>A <input type="checkbox"></label>')).toEqual([])
  })
})

describe('option registry', () => {
  test('the documentation link host list is fixed', () => {
    expect(safeDocUrl('https://dev.mysql.com/doc/refman/8.4/en/x.html')).toBeDefined()
    expect(safeDocUrl('https://mariadb.com/kb/en/x/')).toBeDefined()
    expect(safeDocUrl('http://dev.mysql.com/doc')).toBeUndefined()
    expect(safeDocUrl('https://evil.example/dev.mysql.com')).toBeUndefined()
    expect(safeDocUrl('https://dev.mysql.com.evil.example/')).toBeUndefined()
    expect(safeDocUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeDocUrl(undefined)).toBeUndefined()
    expect(DOC_HOSTS.length).toBeGreaterThan(0)
  })

  test('every doc link in the registry is on the host list', () => {
    for (const specs of [...Object.values(EXPORT_OPTIONS), SQL_IMPORT_OPTIONS, ROW_IMPORT_OPTIONS])
      for (const s of specs) if (s.doc) expect(safeDocUrl(s.doc), s.key).toBeDefined()
  })

  test('option keys are unique per format and use the closed types', () => {
    for (const specs of [
      ...Object.values(EXPORT_OPTIONS),
      SQL_IMPORT_OPTIONS,
      ROW_IMPORT_OPTIONS,
    ]) {
      const keys = specs.map((s) => s.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const s of specs)
        expect(['boolean', 'text', 'number', 'select', 'radio', 'note']).toContain(s.type)
    }
  })

  test('registry defaults give a request the server schema accepts, for every format and scope', () => {
    const targets: ExportTarget[] = [
      { kind: 'server' },
      { kind: 'database', db: 'shop' },
      { kind: 'table', db: 'shop', table: 'customer' },
      { kind: 'result', db: 'shop', text: 'SELECT 1', statementIndex: 0 },
    ]
    for (const target of targets) {
      for (const format of ['sql', 'csv', 'json'] as const) {
        const base = initialExportState(DEFAULT_PREFS, target)
        const { state } = normalizeExport({ ...base, format }, target, caps)
        const request = buildExportRequest(state, target, caps, ['a', 'b'])
        const parsed = exportRequest.safeParse(request)
        expect(
          parsed.success,
          `${target.kind}/${format}: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true)
      }
    }
  })

  test('the Excel preset applies its values at once', () => {
    const specs = EXPORT_OPTIONS.csv
    const next = changeOption(specs, defaultValues(specs), 'preset', 'excel')
    expect(next).toMatchObject({
      separator: ';',
      lineEnding: 'crlf',
      enclosure: '"',
      header: true,
      nullText: 'NULL',
    })
  })

  test('options hide with their condition and numbers are validated', () => {
    const specs = EXPORT_OPTIONS.sql
    const values = defaultValues(specs)
    const dataOnly = { ...values, content: 'data' }
    const shown = visibleOptions(specs, dataOnly).map((s) => s.key)
    expect(shown).not.toContain('createDatabase')
    expect(shown).not.toContain('dropObjects')
    expect(shown).toContain('statement')
    expect(visibleOptions(specs, { ...values, comments: false }).map((s) => s.key)).not.toContain(
      'customComment',
    )
    expect(validateOptions(specs, values)).toEqual({})
    expect(
      validateOptions(specs, { ...values, extendedInsertBytes: '' }).extendedInsertBytes?.key,
    ).toBe('io.err.required')
    expect(
      validateOptions(specs, { ...values, extendedInsertBytes: 10 }).extendedInsertBytes?.key,
    ).toBe('io.err.range')
    expect(
      validateOptions(
        ROW_IMPORT_OPTIONS,
        { ...defaultValues(ROW_IMPORT_OPTIONS), skipRows: -1 },
        { format: 'csv' },
      ).skipRows?.key,
    ).toBe('io.err.range')
  })

  test('csv-only import options are hidden for json; skip-refused only when something is refused', () => {
    const v = defaultValues(ROW_IMPORT_OPTIONS)
    const json = visibleOptions(ROW_IMPORT_OPTIONS, v, { format: 'json' }).map((s) => s.key)
    expect(json).not.toContain('separator')
    expect(json).toContain('jsonTable')
    expect(
      visibleOptions(SQL_IMPORT_OPTIONS, defaultValues(SQL_IMPORT_OPTIONS), { refused: 0 }).map(
        (s) => s.key,
      ),
    ).not.toContain('skipRefused')
    expect(
      visibleOptions(SQL_IMPORT_OPTIONS, defaultValues(SQL_IMPORT_OPTIONS), { refused: 2 }).map(
        (s) => s.key,
      ),
    ).toContain('skipRefused')
  })
})

describe('export model', () => {
  const db: ExportTarget = { kind: 'database', db: 'shop' }

  test('CSV of several tables is forced to zip; text view is refused for zip; separate files need zip', () => {
    const base = initialExportState(DEFAULT_PREFS, db)
    const csv = normalizeExport(
      { ...base, format: 'csv', compression: 'none', view: 'text' },
      db,
      caps,
    )
    expect(csv.state.compression).toBe('zip')
    expect(csv.state.view).toBe('file')
    expect(csv.forced.compression).toBe('csvZip')
    const sql = normalizeExport(
      { ...base, format: 'sql', compression: 'gzip', separateFiles: true },
      db,
      caps,
    )
    expect(sql.state.separateFiles).toBe(false)
    expect(sql.forced.separate).toBe('needsZip')
    const table: ExportTarget = { kind: 'table', db: 'shop', table: 'c' }
    const single = normalizeExport(
      { ...initialExportState(DEFAULT_PREFS, table), compression: 'zip', separateFiles: true },
      table,
      caps,
    )
    expect(single.state.separateFiles).toBe(false)
  })

  test('formats and compressions the server does not offer fall back', () => {
    const state = initialExportState(
      { ...DEFAULT_PREFS, exportFormat: 'json', exportCompression: 'zip' },
      { kind: 'server' },
    )
    const out = normalizeExport(
      state,
      { kind: 'server' },
      { formats: ['sql'], compressions: ['none'] },
    )
    expect(out.state.format).toBe('sql')
    expect(out.state.compression).toBe('none')
  })

  test('selection: all selected sends no list, an exclusion sends the rest, none selected blocks', () => {
    expect(selectionList(['a', 'b', 'c'], [])).toBeUndefined()
    expect(selectionList(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    const base = initialExportState(DEFAULT_PREFS, db)
    expect(
      validateExport({ ...base, excluded: ['a', 'b'] }, db, ['a', 'b']).map((p) => p.code),
    ).toContain('noneSelected')
    const request = buildExportRequest({ ...base, excluded: ['b'], maxTableMiB: 1 }, db, caps, [
      'a',
      'b',
    ])
    expect(request.scope).toEqual({ kind: 'database', db: 'shop', tables: ['a'], maxTableMiB: 1 })
  })

  test('row range is validated and sent only when switched on', () => {
    const target: ExportTarget = { kind: 'table', db: 'shop', table: 'c' }
    const base = initialExportState(DEFAULT_PREFS, target)
    expect(buildExportRequest(base, target, caps, []).scope).toEqual({
      kind: 'table',
      db: 'shop',
      table: 'c',
    })
    const on = { ...base, rangeOn: true, offset: 10, count: 5 }
    expect(buildExportRequest(on, target, caps, []).scope).toMatchObject({
      range: { offset: 10, count: 5 },
    })
    expect(validateExport({ ...on, count: 0 }, target, []).map((p) => p.code)).toContain('range')
    expect(validateExport({ ...on, offset: '' }, target, []).map((p) => p.code)).toContain('range')
  })

  test('formula neutralisation is only sent when it differs from the server default', () => {
    const t1: ExportTarget = { kind: 'table', db: 'shop', table: 'c' }
    const base = { ...initialExportState(DEFAULT_PREFS, t1), format: 'csv' as const }
    const on = buildExportRequest(base, t1, caps, [])
    expect('neutraliseFormulas' in on.options).toBe(false)
    const off = buildExportRequest(
      {
        ...base,
        options: { ...base.options, csv: { ...base.options.csv, neutraliseFormulas: false } },
      },
      t1,
      caps,
      [],
    )
    expect((off.options as Record<string, unknown>)['neutraliseFormulas']).toBe(false)
  })

  test('file name: tokens, sanitising and extension chain follow the rules of section 5.5', () => {
    const now = new Date(2026, 9, 27, 8, 5, 9)
    expect(
      expandTemplate('@TABLE@_@DATABASE@_@YEAR@@MONTH@@DAY@', {
        server: 's:3306',
        db: 'shop',
        table: 'customer',
        now,
      }),
    ).toBe('customer_shop_20261027')
    expect(expandTemplate('@UNKNOWN@', { server: 's' })).toBe('@UNKNOWN@')
    expect(
      previewFileName(
        '@TABLE@_@DATABASE@',
        { server: 's', db: 'e2e_x', table: 'customer' },
        'sql',
        'none',
      ),
    ).toBe('customer_e2e_x.sql')
    expect(previewFileName('shop', { server: 's' }, 'csv', 'zip')).toBe('shop.csv.zip')
    expect(previewFileName('shop.sql', { server: 's' }, 'sql', 'gzip')).toBe('shop.sql.gz')
    const hostile = sanitizeFileName('../x";.csv')
    expect(hostile).toMatch(/^[\p{L}\p{N}_.-]+$/u)
    expect(hostile.startsWith('.')).toBe(false)
    expect(sanitizeFileName('...')).toBe('export')
    expect(sanitizeFileName('a'.repeat(300)).length).toBe(120)
    expect(sanitizeFileName('Müller 東京')).toBe('Müller_東京')
  })
})

describe('import model', () => {
  const sqlAnalysis = (
    over: Partial<NonNullable<ImportAnalysis['statements']>> = {},
    confirmRequired = false,
  ): ImportAnalysis => ({
    uploadId: 'upload-12345678',
    analysisHash: 'h',
    fileName: 'dump.sql.gz',
    bytes: 2048,
    compression: 'gzip',
    format: 'sql',
    charset: 'utf-8',
    confirmRequired,
    statements: {
      total: 1018,
      byClass: { none: 1000, soft: 17, hard: 1, refused: 0 },
      hardKinds: { 'DROP TABLE': 1 },
      refusedKinds: {},
      createsDatabases: [],
      dropsDatabases: [],
      usesDatabase: false,
      needsDatabase: true,
      ...over,
    },
  })

  test('kinds line lists counts largest first', () => {
    expect(kindsLine({ GRANT: 3, 'CREATE USER': 1 })).toBe('3 GRANT, 1 CREATE USER')
    expect(kindsLine({})).toBe('')
  })

  test('start is blocked with a reason: read-only, no database, refused statements, mapping, options', () => {
    const a = sqlAnalysis()
    const ok = {
      readOnly: false,
      analysis: a,
      db: 'shop',
      optionErrors: 0,
      skipRefused: false,
      rowsReady: true,
    }
    expect(startBlock(ok)).toBeNull()
    expect(startBlock({ ...ok, readOnly: true })).toBe('io.import.block.readOnly')
    expect(startBlock({ ...ok, db: undefined })).toBe('io.import.block.needsDatabase')
    expect(
      startBlock({ ...ok, db: undefined, analysis: sqlAnalysis({ usesDatabase: true }) }),
    ).toBeNull()
    const refused = sqlAnalysis()
    refused.statements!.byClass.refused = 2
    expect(startBlock({ ...ok, analysis: refused })).toBe('io.import.block.refused')
    expect(startBlock({ ...ok, analysis: refused, skipRefused: true })).toBeNull()
    expect(startBlock({ ...ok, optionErrors: 1 })).toBe('io.import.block.options')
    const rows: ImportAnalysis = { ...a, format: 'csv' }
    delete rows.statements
    expect(startBlock({ ...ok, analysis: rows, rowsReady: false })).toBe('io.import.block.mapping')
    expect(startBlock({ ...ok, analysis: rows, db: undefined })).toBe(
      'io.import.block.needsDatabase',
    )
  })

  test('mapping matches by name, then ignoring case, else by position; generated columns are not offered', () => {
    const targets = [
      { name: 'id', type: 'int' },
      { name: 'Name', type: 'varchar' },
      { name: 'full', type: 'int', generated: true },
      { name: 'note', type: 'text' },
    ]
    const byName = autoMap(['ID', 'name', 'other'], targets, true)
    expect(byName.map((r) => r.target)).toEqual(['id', 'Name', null])
    expect(byName[0]?.source).toBe('ID')
    const byPos = autoMap(['a', 'b', 'c', 'd'], targets, false)
    expect(byPos.map((r) => r.target)).toEqual(['id', 'Name', 'note', null])
    expect(byPos[1]?.source).toBe(1)
    expect(validateMapping(byName)).toEqual({ duplicates: [] })
    expect(validateMapping([{ source: 0, label: 'a', target: null }]).problem).toBe('none')
    expect(
      validateMapping([
        { source: 0, label: 'a', target: 'id' },
        { source: 1, label: 'b', target: 'id' },
      ]),
    ).toEqual({ problem: 'duplicate', duplicates: ['id'] })
  })

  test('type proposal from sample rows (FR-IO-019)', () => {
    expect(inferType(['1', '22', null]).type).toBe('int')
    expect(inferType(['12345678901']).type).toBe('bigint')
    expect(inferType(['1.5', '10.25'])).toEqual({ type: 'decimal', precision: 4, scale: 2 })
    expect(inferType(['2026-10-27']).type).toBe('date')
    expect(inferType(['2026-10-27 10:00:00']).type).toBe('datetime')
    expect(inferType(['10:00:00']).type).toBe('time')
    expect(inferType(['abc']).type).toBe('varchar')
    expect(inferType(['x'.repeat(400)]).type).toBe('text')
    expect(inferType(['x'.repeat(70000)]).type).toBe('longtext')
    expect(inferType([null, ''])).toEqual({ type: 'varchar', length: 255 })
    expect(inferType(['1', 'a']).type).toBe('varchar')
  })

  test('new table: names validated, definition accepted by the structure schema, mapping follows names', () => {
    const cols = proposeColumns(['id', 'select', ''], [['1', 'x', 'y']], true)
    expect(cols.map((c) => c.name)).toEqual(['id', 'select', 'col_3'])
    expect(validateReview('imported', cols)).toEqual([])
    expect(validateReview('', cols)[0]?.field).toBe('table')
    const dup = [...cols, { ...cols[0]!, name: 'ID' }]
    expect(validateReview('t', dup).some((p) => p.key === 'io.err.duplicate')).toBe(true)
    const def = toTableDefinition('shop', 'imported', cols)
    expect(tableDefinition.safeParse(def).success).toBe(true)
    expect(reviewToMaps(cols)[1]).toEqual({ source: 'select', target: 'select' })
  })

  test('start request: only declared options, mapping for rows, token only when the analysis has one', () => {
    const analysis = sqlAnalysis({}, true)
    const sql = buildStartRequest({
      analysis,
      format: 'sql',
      db: 'shop',
      sqlOptions: { ...defaultValues(SQL_IMPORT_OPTIONS), foreignKeyChecks: 'off' },
      rowOptions: {},
      confirmToken: 'token-token-token-token',
    })
    expect(startImportRequest.safeParse(sql).success).toBe(true)
    expect(sql.options).toMatchObject({ foreignKeyChecksOff: true, skipStatements: 0 })
    expect(sql).not.toHaveProperty('mapping')
    const csv = buildStartRequest({
      analysis: { ...analysis, format: 'csv' },
      format: 'csv',
      db: 'shop',
      table: 'customer',
      sqlOptions: {},
      rowOptions: { ...defaultValues(ROW_IMPORT_OPTIONS), header: true, separator: ';' },
      mapping: [{ source: 'id', target: 'id' }],
    })
    expect(startImportRequest.safeParse(csv).success).toBe(true)
    expect(csv.options).toMatchObject({
      separator: ';',
      header: true,
      conflict: 'error',
      mode: 'allOrNothing',
    })
    expect(csv).not.toHaveProperty('confirmToken')
    const json = buildStartRequest({
      analysis: { ...analysis, format: 'json' },
      format: 'json',
      db: 'shop',
      table: 'customer',
      sqlOptions: {},
      rowOptions: defaultValues(ROW_IMPORT_OPTIONS),
      mapping: [],
    })
    expect(startImportRequest.safeParse(json).success).toBe(true)
    expect(json.options).not.toHaveProperty('separator')
  })
})

describe('job model', () => {
  test('every error code has its own message and every state a label', () => {
    for (const code of IO_ERROR_CODES) {
      expect(t(ERROR_KEYS[code]).length, code).toBeGreaterThan(3)
      expect(codeMessage(code)).toBe(t(ERROR_KEYS[code]))
    }
    for (const key of Object.values(STATE_KEYS)) expect(t(key).length).toBeGreaterThan(2)
  })

  test('a thrown server error never shows its raw text', () => {
    expect(describeIoFailure(new Error('busy: <img src=x onerror=alert(1)>')).message).toBe(
      t('io.error.busy'),
    )
    expect(describeIoFailure(new Error('weird: <b>x</b>')).message).toBe(t('io.error.unknown'))
    expect(describeIoFailure('nope').message).toBe(t('io.error.unknown'))
    expect(codeMessage('upload_too_large', '64 MiB')).toContain('64 MiB')
    expect(codeMessage('unsupported_type')).toBe(t('io.error.unsupported_type'))
  })

  test('progress fractions and sizes', () => {
    expect(fraction({ bytes: 50, totalBytes: 200 })).toBe(0.25)
    expect(fraction({ bytes: 50 })).toBeUndefined()
    expect(fraction({ bytes: 500, totalBytes: 200 })).toBe(1)
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(64 * MiB)).toBe('64 MiB')
  })

  test('polling stops at the end of a job and waits while paused', () => {
    expect(isActive('running')).toBe(true)
    expect(isActive('paused')).toBe(false)
    expect(isTerminal('done_with_rejects')).toBe(true)
    expect(isTerminal('paused')).toBe(false)
    expect(pollDelay(0)).toBeLessThan(pollDelay(60_000))
  })
})

describe('upload', () => {
  test('accepted names, case-insensitive, with compressed forms', () => {
    expect(checkFileName('Dump.SQL')).toEqual({ ok: true, format: 'sql', compressed: 'none' })
    expect(checkFileName('a.csv.gz')).toEqual({ ok: true, format: 'csv', compressed: 'gzip' })
    expect(checkFileName('a.JSON.ZIP')).toEqual({ ok: true, format: 'json', compressed: 'zip' })
    expect(checkFileName('a.png').ok).toBe(false)
    expect(checkFileName('a.gz').ok).toBe(false)
    expect(checkFileName('sql').ok).toBe(false)
  })

  class FakeXhr implements XhrLike {
    upload: XhrLike['upload'] = { onprogress: null }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    status = 0
    responseText = ''
    method = ''
    url = ''
    headers: Record<string, string> = {}
    body: unknown
    open(method: string, url: string) {
      this.method = method
      this.url = url
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value
    }
    send(body: unknown) {
      this.body = body
    }
    abort() {
      this.onabort?.()
    }
  }

  test('raw PUT with the name as a query parameter; progress and the upload id come back', async () => {
    const xhr = new FakeXhr()
    const seen: number[] = []
    const handle = uploadFile(
      { name: 'a b&c.sql', size: 10 },
      { format: 'sql', onProgress: (l) => seen.push(l) },
      () => xhr,
    )
    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('/api/io/upload?name=a%20b%26c.sql&format=sql')
    xhr.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true })
    xhr.upload.onprogress?.({ loaded: 0, total: 0, lengthComputable: false })
    xhr.status = 200
    xhr.responseText = JSON.stringify({ uploadId: 'abcdef123456' })
    xhr.onload?.()
    await expect(handle.promise).resolves.toEqual({ uploadId: 'abcdef123456' })
    expect(seen).toEqual([5])
  })

  test('errors map to the closed list; 413 is too large; abort rejects as cancelled', async () => {
    const run = async (status: number, body: string) => {
      const xhr = new FakeXhr()
      const h = uploadFile({ name: 'a.sql', size: 1 }, { format: 'sql' }, () => xhr)
      xhr.status = status
      xhr.responseText = body
      xhr.onload?.()
      return h.promise.catch((e: unknown) => e as UploadError)
    }
    expect(((await run(413, '')) as UploadError).code).toBe('upload_too_large')
    expect(
      (
        (await run(
          400,
          JSON.stringify({ error: { code: 'quota_full', message: 'x' } }),
        )) as UploadError
      ).code,
    ).toBe('quota_full')
    expect(((await run(500, 'not json')) as UploadError).code).toBe('upload_failed')
    expect(
      ((await run(400, JSON.stringify({ error: { code: 'rm -rf' } }))) as UploadError).code,
    ).toBe('upload_failed')
    const xhr = new FakeXhr()
    const h = uploadFile({ name: 'a.sql', size: 1 }, { format: 'sql' }, () => xhr)
    h.abort()
    await expect(h.promise).rejects.toMatchObject({ code: 'cancelled' })
  })

  test('the queue keeps one row per file with its own progress, cancel and removal', () => {
    const item = (id: string, bytes = 100): UploadItem => ({
      id,
      name: `${id}.sql`,
      bytes,
      loaded: 0,
      state: 'uploading',
    })
    let items = uploadReducer([], { type: 'add', item: item('a') })
    items = uploadReducer(items, { type: 'add', item: item('b', 300) })
    items = uploadReducer(items, { type: 'progress', id: 'a', loaded: 50 })
    expect(uploadFraction(items)).toBeCloseTo(50 / 400)
    items = uploadReducer(items, { type: 'cancel', id: 'b' })
    expect(items.find((i) => i.id === 'b')?.state).toBe('cancelled')
    items = uploadReducer(items, { type: 'progress', id: 'b', loaded: 200 })
    expect(items.find((i) => i.id === 'b')?.loaded).toBe(0)
    items = uploadReducer(items, { type: 'done', id: 'a', uploadId: 'u1' })
    expect(items.find((i) => i.id === 'a')).toMatchObject({
      state: 'done',
      uploadId: 'u1',
      loaded: 100,
    })
    items = uploadReducer(items, { type: 'fail', id: 'a', error: 'x' })
    expect(items.find((i) => i.id === 'a')?.state).toBe('done')
    expect(uploadReducer(items, { type: 'clear' })).toEqual([])
    expect(uploadReducer(items, { type: 'remove', id: 'a' }).map((i) => i.id)).toEqual(['b'])
  })
})

describe('api seam', () => {
  test('the server API wraps the fixed server function names', async () => {
    const calls: string[] = []
    const fn =
      (name: string, result: unknown = {}) =>
      async (args?: unknown) => {
        calls.push(`${name}:${JSON.stringify(args ?? null)}`)
        return result as never
      }
    const api = createServerIoApi(
      {
        getIoCapabilities: fn('getIoCapabilities', caps),
        startExport: fn('startExport', { jobId: 'j' }),
        getJob: fn('getJob'),
        cancelJob: fn('cancelJob'),
        analyseImport: fn('analyseImport'),
        startImport: fn('startImport', { jobId: 'j' }),
        resumeImport: fn('resumeImport', { jobId: 'j' }),
        listImportFolder: fn('listImportFolder', []),
        listTemplates: fn('listTemplates', []),
        saveTemplate: fn('saveTemplate'),
        deleteTemplate: fn('deleteTemplate'),
        getIoPrefs: fn('getIoPrefs', DEFAULT_PREFS),
        setIoPrefs: fn('setIoPrefs', DEFAULT_PREFS),
        previewNewTable: fn('previewNewTable', { statements: [] }),
      },
      async () => ({ text: '', truncated: false }),
    )
    await api.cancelJob('job-1')
    await api.resumeImport('job-1')
    await api.deleteTemplate({ format: 'sql', name: 'n' })
    expect(calls).toEqual([
      'cancelJob:{"data":{"jobId":"job-1"}}',
      'resumeImport:{"data":{"jobId":"job-1"}}',
      'deleteTemplate:{"data":{"format":"sql","name":"n"}}',
    ])
  })

  test('the mock runs a job to the end on a controlled clock', async () => {
    let now = 1000
    const api = createMockIoApi(() => now, 1000)
    const { jobId } = await api.startExport({} as never)
    expect((await api.getJob(jobId)).state).toBe('running')
    now = 2500
    expect((await api.getJob(jobId)).state).toBe('done')
    const second = await api.startExport({} as never)
    await api.cancelJob(second.jobId)
    expect((await api.getJob(second.jobId)).state).toBe('cancelled')
  })
})

describe('screens (static markup)', () => {
  const job = (over: Partial<IoJob>): IoJob => ({
    id: 'j1',
    kind: 'import',
    state: 'running',
    progress: { bytes: 50, totalBytes: 100, rows: 12, statements: 3 },
    startedAt: 0,
    ...over,
  })

  test('option panels of every format are labelled and show hidden options only when they apply', () => {
    for (const format of ['sql', 'csv', 'json'] as const) {
      const out = html(
        createElement(OptionPanel, {
          legend: 'x',
          specs: EXPORT_OPTIONS[format],
          values: defaultValues(EXPORT_OPTIONS[format]),
          ctx: { format },
          onChange: () => undefined,
        }),
      )
      expect(a11yProblems(out), format).toEqual([])
    }
    const out = html(
      createElement(OptionPanel, {
        legend: 'x',
        specs: EXPORT_OPTIONS.sql,
        values: defaultValues(EXPORT_OPTIONS.sql),
        ctx: { format: 'sql' },
        onChange: () => undefined,
      }),
    )
    // documentation link of a listed host, opened safely
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('href="https://dev.mysql.com/')
    const none = html(
      createElement(OptionPanel, { legend: 'x', specs: [], values: {}, onChange: () => undefined }),
    )
    expect(none).toContain(t('io.opt.none'))
  })

  test('import option panels with the number and radio controls are labelled', () => {
    const rows = html(
      createElement(OptionPanel, {
        legend: 'x',
        specs: ROW_IMPORT_OPTIONS,
        values: defaultValues(ROW_IMPORT_OPTIONS),
        ctx: { format: 'csv' },
        onChange: () => undefined,
      }),
    )
    expect(a11yProblems(rows)).toEqual([])
    expect(rows).toContain('type="number"')
    expect(rows).toContain('type="radio"')
  })

  test('progress: overall bar, current object, cancel while running, resume while paused', () => {
    const running = html(
      createElement(JobProgressView, {
        job: job({
          progress: {
            bytes: 50,
            totalBytes: 100,
            object: { index: 2, total: 5, name: 'customer' },
          },
        }),
        onCancel: () => undefined,
      }),
    )
    expect(running).toContain('role="progressbar"')
    expect(running).toContain('aria-valuenow="50"')
    expect(running).toContain('customer')
    expect(running).toContain(t('io.progress.cancel'))
    expect(a11yProblems(running)).toEqual([])
    const unknown = html(createElement(JobProgressView, { job: job({ progress: { bytes: 5 } }) }))
    expect(unknown).not.toContain('aria-valuenow')
    const paused = html(
      createElement(JobProgressView, {
        job: job({
          state: 'paused',
          result: {
            skipped: [],
            rejected: [],
            rejectedCount: 0,
            notes: [],
            resume: { decodedOffset: 2048, statementNumber: 40 },
            durationMs: 1,
          },
        }),
        onResume: () => undefined,
      }),
    )
    expect(paused).toContain(t('io.paused.resume'))
    expect(paused).toContain('40')
    expect(paused).not.toContain(t('io.progress.cancel'))
  })

  test('result: server and file text is escaped, never rendered as HTML', () => {
    const evil = '<img src=x onerror=alert(1)>'
    const out = html(
      createElement(JobResultView, {
        job: job({
          state: 'done_with_rejects',
          result: {
            fileName: evil,
            skipped: [{ object: evil, message: evil }],
            rejected: [{ row: 7, column: evil, code: 'x', message: evil }],
            rejectedCount: 1,
            notes: [evil],
            error: {
              code: 'statement_failed',
              message: evil,
              serverMessage: evil,
              statementText: evil,
              errno: 1062,
              statementNumber: 50,
              line: 50,
              byteOffset: 3000,
            },
            durationMs: 1200,
          },
        }),
      }),
    )
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    expect(out).toContain(t('io.state.done_with_rejects'))
    expect(out).toContain(t('io.error.statement_failed'))
    expect(out).toContain('role="status"')
  })

  test('rejected rows list at most 100 and says how many more', () => {
    const rejected = Array.from({ length: 100 }, (_, i) => ({
      row: i + 1,
      code: 'x',
      message: 'm',
    }))
    const out = html(
      createElement(JobResultView, {
        job: job({
          state: 'done_with_rejects',
          result: { skipped: [], rejected, rejectedCount: 250, notes: [], durationMs: 1 },
        }),
      }),
    )
    expect(out.match(/Row \d+/g)?.length).toBe(100)
    expect(out).toContain(t('io.result.moreRejected', { n: 150 }))
  })

  test('scope picker: search, counts, none-selected message, long lists are capped', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}` }))
    expect(filterItems(items, ' T49 ').map((i) => i.name)).toContain('t49')
    const out = html(
      createElement(ScopePicker, {
        kind: 'database',
        items,
        excluded: [],
        onChange: () => undefined,
      }),
    )
    expect(out).toContain(t('io.scope.count', { selected: 500, total: 500 }))
    expect(out).toContain(t('io.scope.more', { shown: 300, total: 500 }))
    expect(a11yProblems(out)).toEqual([])
    const all = html(
      createElement(ScopePicker, {
        kind: 'server',
        items: [{ name: 'a' }],
        excluded: ['a'],
        onChange: () => undefined,
      }),
    )
    expect(all).toContain(t('io.scope.noneSelected'))
  })

  test('upload panel: one row per file with its own progress bar and cancel button', () => {
    const items: UploadItem[] = [
      { id: 'a', name: 'a.sql', bytes: 1000, loaded: 400, state: 'uploading' },
      { id: 'b', name: 'b.csv', bytes: 1000, loaded: 1000, state: 'done', uploadId: 'u' },
      { id: 'c', name: 'c.png', bytes: 5, loaded: 0, state: 'error', error: 'unsupported_type' },
      { id: 'd', name: 'd.sql', bytes: 5, loaded: 0, state: 'error', error: 'upload_too_large' },
    ]
    const out = html(
      createElement(UploadStatusPanel, {
        items,
        limitText: '64 MiB',
        onCancel: () => undefined,
        onRemove: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(out).toContain(t('io.upload.cancel', { name: 'a.sql' }))
    expect(out).toContain(t('io.upload.panelBusy', { n: 1 }))
    expect(out).toContain(t('io.error.unsupported_type'))
    expect(out).toContain('64 MiB')
    expect(a11yProblems(out)).toEqual([])
    expect(
      html(
        createElement(UploadStatusPanel, {
          items: [],
          onCancel: () => undefined,
          onRemove: () => undefined,
          onClose: () => undefined,
        }),
      ),
    ).toBe('')
    expect(
      html(
        createElement(UploadList, {
          items: [],
          onCancel: () => undefined,
          onRemove: () => undefined,
        }),
      ),
    ).toBe('')
  })

  test('drop target shows no overlay at rest and only reacts to file drags', () => {
    const out = html(
      createElement(DropTarget, {
        enabled: true,
        onFiles: () => undefined,
        children: createElement('p', null, 'nav'),
      }),
    )
    expect(out).not.toContain(t('io.drop.here'))
    expect(hasFiles(['Files', 'text/plain'])).toBe(true)
    expect(hasFiles(['text/plain'])).toBe(false)
    expect(hasFiles(undefined)).toBe(false)
  })

  const analysis = (
    confirmRequired: boolean,
    confirmToken?: string,
  ): ImportAnalysis & { confirmToken?: string } => ({
    uploadId: 'upload-12345678',
    analysisHash: 'h',
    fileName: 'dump.sql.gz',
    bytes: 4096,
    compression: 'gzip',
    format: 'sql',
    charset: 'utf-8',
    confirmRequired,
    ...(confirmToken ? { confirmToken } : {}),
    statements: {
      total: 1018,
      byClass: { none: 1000, soft: 17, hard: 1, refused: 0 },
      hardKinds: { 'DROP TABLE': 1 },
      refusedKinds: {},
      createsDatabases: [],
      dropsDatabases: [],
      usesDatabase: false,
      needsDatabase: true,
    },
  })

  test('confirmation names server, database and file; hard statements need the typed name', () => {
    const props = {
      open: true,
      server: 'db.example:3306',
      db: 'e2e_x',
      table: undefined,
      typedName: 'e2e_x',
      busy: false,
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }
    const hard = html(
      createElement(ImportConfirmDialog, {
        ...props,
        analysis: analysis(true, 'tok-tok-tok-tok-tok'),
      }),
    )
    expect(hard).toContain('db.example:3306')
    expect(hard).toContain('e2e_x')
    expect(hard).toContain('dump.sql.gz')
    expect(hard).toContain('1 DROP TABLE')
    expect(hard).toContain(t('structure.confirm.typeName', { name: 'e2e_x' }))
    expect(hard).toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/)
    expect(a11yProblems(hard)).toEqual([])
    const plain = html(createElement(ImportConfirmDialog, { ...props, analysis: analysis(false) }))
    expect(plain).not.toContain(t('structure.confirm.typeName', { name: 'e2e_x' }))
    expect(plain).not.toMatch(/<button[^>]*disabled=""[^>]*>Import<\/button>/)
    const noToken = html(createElement(ImportConfirmDialog, { ...props, analysis: analysis(true) }))
    expect(noToken).toContain(t('io.confirm.noToken'))
    const closed = html(
      createElement(ImportConfirmDialog, { ...props, open: false, analysis: analysis(false) }),
    )
    expect(closed).not.toContain('dump.sql.gz')
  })

  test('mapping step and sample preview: labelled selects, cells as text, wrong separator warned', () => {
    const rows = autoMap(
      ['id', 'name'],
      [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'varchar' },
      ],
      true,
    )
    const out = html(
      createElement(MappingStep, {
        rows,
        targets: [
          { name: 'id', type: 'int' },
          { name: 'name', type: 'varchar' },
        ],
        sample: [['1', '<b>x</b>']],
        onChange: () => undefined,
      }),
    )
    expect(a11yProblems(out)).toEqual([])
    expect(out).toContain(t('io.mapping.skip'))
    expect(out).not.toContain('<b>')
    const preview = html(
      createElement(SamplePreview, {
        columns: ['a;b'],
        sample: [['1;2']],
        warnings: [],
        rowCount: 1,
      }),
    )
    expect(preview).toContain(t('io.preview.merged'))
    expect(looksMerged(['a', 'b'])).toBe(false)
    const nul = html(
      createElement(SamplePreview, {
        columns: ['a'],
        sample: [[null]],
        warnings: [],
        rowCount: null,
      }),
    )
    expect(nul).toContain('NULL')
  })

  test('export tab: Quick shows the summary line of SCN-052 and Export stays enabled for a read-only session', () => {
    const client = new QueryClient()
    client.setQueryData(['io', 'caps'], caps)
    client.setQueryData(['io', 'prefs'], DEFAULT_PREFS)
    setIoApi(createMockIoApi())
    const out = html(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ExportTab, {
          target: { kind: 'table', db: 'e2e_x', table: 'customer' },
          serverLabel: 'h:3306',
        }),
      ),
    )
    expect(out).toContain('SQL, structure and data, no compression, customer_e2e_x.sql')
    expect(out).toContain(t('io.mode.quick'))
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Export<\/button>/)
    expect(a11yProblems(out)).toEqual([])
  })

  test('export tab: Custom shows picker for a database, format panel, output and templates', () => {
    const client = new QueryClient()
    client.setQueryData(['io', 'caps'], caps)
    client.setQueryData(['io', 'prefs'], { ...DEFAULT_PREFS, mode: 'custom' })
    client.setQueryData(
      ['io', 'scope', 'database', 'shop'],
      [{ name: 'customer' }, { name: 'v1', view: true }],
    )
    setIoApi(createMockIoApi())
    const out = html(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ExportTab, {
          target: { kind: 'database', db: 'shop' },
          serverLabel: 'h:3306',
        }),
      ),
    )
    for (const key of [
      'io.section.what',
      'io.section.format',
      'io.section.output',
      'io.templates.title',
    ] as const)
      expect(out).toContain(t(key))
    expect(out).toContain('customer')
    expect(out).toContain(t('io.filename.tokens'))
    expect(a11yProblems(out)).toEqual([])
  })
})

describe('messages', () => {
  const root = path.resolve(__dirname, '..')
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))

  test('every io. message key used by the screens exists in en.json', () => {
    const sources = [
      ...files(path.join(root, 'src/components/io')),
      ...files(path.join(root, 'src/lib/io')),
      path.join(root, 'src/components/shell/app-shell.tsx'),
      path.join(root, 'src/components/shell/sidebar-tree.tsx'),
    ]
    const missing: string[] = []
    for (const file of sources) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/'(io\.[A-Za-z0-9_.]+)'/g)) {
        if (!((m[1] as string) in en)) missing.push(`${path.basename(file)}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('no screen renders server text as HTML', () => {
    for (const file of files(path.join(root, 'src/components/io'))) {
      expect(fs.readFileSync(file, 'utf8'), file).not.toContain('dangerouslySetInnerHTML')
    }
  })
})
