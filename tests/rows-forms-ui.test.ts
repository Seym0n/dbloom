import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import { t } from '~/i18n'
import { alignRow, canEditCell, canEditColumn, inlineEligible } from '~/components/rows/cell-dialog'
import {
  ConflictDialog,
  currentGuard,
  overwriteChange,
  type ConflictResponse,
} from '~/components/rows/conflict-dialog'
import {
  PlanBody,
  RowPlanDialog,
  rowsText,
  type ConfirmResponse,
  type DoneResponse,
} from '~/components/rows/delete-dialog'
import { FkBody, optionLabel } from '~/components/rows/fk-picker'
import {
  NULL_WIRE,
  compactJson,
  editText,
  formatBit,
  functionsFor,
  guardOf,
  hexDump,
  hexToBytes,
  initialWire,
  insertInitial,
  intRange,
  isDirty,
  jsonErrorPosition,
  markControls,
  needsDigest,
  parseInteger,
  prettyJson,
  restoreLineBreaks,
  rowKeyOf,
  sendInInsert,
  snapshotGuards,
  toTextareaValue,
  tryGuard,
  validateText,
  validateWire,
  wireEqual,
} from '~/components/rows/form-core'
import type { CellContext } from '~/components/rows/grid-hooks'
import {
  blockForCopy,
  blockFromRow,
  bulkEligible,
  buildFormChange,
  buildItems,
  disabledReason,
  fieldKey,
  makeBulkBlock,
  makeInsertBlock,
  newKeyOf,
} from '~/components/rows/row-form'
import {
  createServerFormsApi,
  describeRowsRefusal,
  formsApi,
  setFormsApi,
  type FormsApi,
} from '~/components/rows/server-api-forms'
import {
  cellRenderers,
  modeOf,
  pickerToText,
  pickerValue,
  valueEditors,
} from '~/components/rows/value-editors'
import type { CellDisplayOptions } from '~/components/rows/registry'
import type {
  Cell,
  FkInfo,
  Identity,
  RowColumn,
  RowPermissions,
  RowTable,
  WireValue,
} from '~/server/rows/types'

// ---- Fixtures ------------------------------------------------------------------------------------------------------------

const col = (over: Partial<RowColumn> & { name: string; kind: RowColumn['kind'] }): RowColumn => ({
  ordinal: 1,
  baseType: over.kind === 'int' ? 'int' : over.kind,
  fullType: over.kind,
  nullable: true,
  default: { kind: 'none' },
  autoIncrement: false,
  invisible: false,
  comment: '',
  ...over,
})

const table = (columns: RowColumn[], over: Partial<RowTable> = {}): RowTable => ({
  db: 'shop',
  table: 'customer',
  kind: 'table',
  engine: 'InnoDB',
  transactional: true,
  columns,
  primaryKey: ['id'],
  uniqueKeys: [],
  outgoing: [],
  incoming: [],
  estimatedRows: null,
  ...over,
})

const id = col({
  name: 'id',
  kind: 'int',
  nullable: false,
  autoIncrement: true,
  unsigned: true,
  fullType: 'int unsigned',
})
const name = col({ name: 'name', kind: 'char', baseType: 'varchar', length: 10, nullable: false })
const note = col({ name: 'note', kind: 'text', baseType: 'text' })
const created = col({
  name: 'created',
  kind: 'datetime',
  fsp: 6,
  default: { kind: 'expression', text: 'CURRENT_TIMESTAMP(6)' },
})
const flag = col({ name: 'flag', kind: 'enum', members: ['a', 'b'] })
const customer = table([id, name, note, created, flag])

const perms: RowPermissions = { readOnly: false, insert: true, update: true, delete: true }
const opts: CellDisplayOptions = {
  displayChars: 5,
  fullText: false,
  protectBinary: false,
  locale: 'en-US',
}

afterEach(() => {
  setFormsApi({} as FormsApi)
})

// ---- Value validation (FR-ROW-025) ---------------------------------------------------------------------------------------------

describe('validateText', () => {
  test('integers: range by width and sign, hex literals, values above 2^53', () => {
    const tiny = col({ name: 'n', kind: 'int', baseType: 'tinyint', unsigned: true })
    expect(validateText(tiny, '255')).toBeNull()
    expect(validateText(tiny, '256')?.key).toBe('rows.form.err.range')
    expect(validateText(tiny, '-1')?.key).toBe('rows.form.err.range')
    expect(validateText(tiny, '0xFF')).toBeNull()
    expect(validateText(tiny, "X'1F'")).toBeNull()
    expect(validateText(tiny, '1.5')?.key).toBe('rows.form.err.integer')
    const big = col({ name: 'n', kind: 'int', baseType: 'bigint' })
    expect(validateText(big, '9223372036854775807')).toBeNull()
    expect(validateText(big, '9223372036854775808')?.key).toBe('rows.form.err.range')
    expect(intRange(big).max).toBe(9223372036854775807n)
    expect(parseInteger('0x10')).toBe(16n)
    expect(parseInteger('+7')).toBe(7n)
    expect(parseInteger('x')).toBeNull()
  })

  test('decimal: scale and integer digits, never a float parse', () => {
    const d = col({ name: 'd', kind: 'decimal', precision: 30, scale: 10 })
    expect(validateText(d, '12345678901234567890.0123456789')).toBeNull()
    expect(validateText(d, '1.12345678901')?.key).toBe('rows.form.err.scale')
    expect(validateText(d, '123456789012345678901')?.key).toBe('rows.form.err.precision')
    expect(validateText(d, 'abc')?.key).toBe('rows.form.err.decimal')
  })

  test('float, bit', () => {
    expect(validateText(col({ name: 'f', kind: 'float' }), '1e-3')).toBeNull()
    expect(validateText(col({ name: 'f', kind: 'float' }), 'one')?.key).toBe('rows.form.err.number')
    const bit = col({ name: 'b', kind: 'bit', length: 12 })
    expect(validateText(bit, "b'000000000101'")).toBeNull()
    expect(validateText(bit, '1111111111111')?.key).toBe('rows.form.err.bit')
    expect(validateText(bit, '12')).toBeNull() // plain digits are a decimal number
    expect(validateText(bit, '4096')?.key).toBe('rows.form.err.bit')
    expect(validateText(bit, '0xFFF')).toBeNull()
    expect(validateText(bit, '0b101')).toBeNull()
  })

  test('temporal: syntax, fractional seconds within the column precision, year 0099', () => {
    const dt = col({ name: 'd', kind: 'datetime', fsp: 6 })
    expect(validateText(dt, '2024-03-05 12:34:56.123456')).toBeNull()
    expect(validateText(dt, '2024-03-05T12:34:56')).toBeNull()
    expect(validateText(dt, '2024-13-05 12:34:56')?.key).toBe('rows.form.err.datetime')
    expect(
      validateText(col({ name: 'd', kind: 'datetime', fsp: 0 }), '2024-03-05 12:34:56.1')?.key,
    ).toBe('rows.form.err.fraction')
    expect(validateText(col({ name: 'd', kind: 'date' }), '0099-01-01')).toBeNull()
    expect(validateText(col({ name: 'd', kind: 'date' }), '0000-00-00')).toBeNull()
    expect(validateText(col({ name: 't', kind: 'time', fsp: 3 }), '-838:59:59.123')).toBeNull()
    expect(validateText(col({ name: 't', kind: 'time' }), '25:61:00')?.key).toBe(
      'rows.form.err.time',
    )
    expect(validateText(col({ name: 'y', kind: 'year' }), '0099')).toBeNull()
    expect(validateText(col({ name: 'y', kind: 'year' }), '20x')?.key).toBe('rows.form.err.year')
  })

  test('character length counts characters, not UTF-16 units; text types count bytes', () => {
    const c = col({ name: 'c', kind: 'char', baseType: 'varchar', length: 3 })
    expect(validateText(c, '😀😀😀')).toBeNull()
    expect(validateText(c, '😀😀😀😀')?.key).toBe('rows.form.err.tooLong')
    const tiny = col({ name: 't', kind: 'text', baseType: 'tinytext' })
    expect(validateText(tiny, 'a'.repeat(255))).toBeNull()
    expect(validateText(tiny, 'ä'.repeat(128))?.key).toBe('rows.form.err.tooLongBytes')
    expect(validateText({ ...c, length: 4 }, '\r\n  ')).toBeNull()
  })

  test('enum, set, json with position, geometry, binary hex', () => {
    expect(validateText(flag, 'a')).toBeNull()
    expect(validateText(flag, 'z')?.key).toBe('rows.form.err.member')
    const set = col({ name: 's', kind: 'set', members: ['x', 'y'] })
    expect(validateText(set, '')).toBeNull()
    expect(validateText(set, 'x,y')).toBeNull()
    expect(validateText(set, 'x,q')?.key).toBe('rows.form.err.member')
    const json = col({ name: 'j', kind: 'json' })
    expect(validateText(json, '{"a": [1, 2]}')).toBeNull()
    const bad = validateText(json, '{\n  "a": ,\n}')
    expect(bad?.key).toBe('rows.form.err.json')
    expect(bad?.values?.['line']).toBeGreaterThanOrEqual(1)
    expect(validateText(col({ name: 'g', kind: 'geometry' }), 'POINT(1 2)')).toBeNull()
    expect(validateText(col({ name: 'g', kind: 'geometry' }), 'SRID=4326;POINT(1 2)')).toBeNull()
    expect(validateText(col({ name: 'g', kind: 'geometry' }), 'banana')?.key).toBe(
      'rows.form.err.geometry',
    )
    expect(validateText(col({ name: 'b', kind: 'binary' }), '0x00FF0A')).toBeNull()
    expect(validateText(col({ name: 'b', kind: 'binary' }), '0xF')?.key).toBe('rows.form.err.hex')
    expect(validateText(col({ name: 'u', kind: 'unknown' }), 'x')?.key).toBe(
      'rows.form.err.unsupported',
    )
  })

  test('jsonErrorPosition reads line and column from an offset', () => {
    expect(jsonErrorPosition('ab\ncd', new Error('Unexpected token at position 4'))).toEqual({
      line: 2,
      column: 2,
    })
    expect(jsonErrorPosition('x', new Error('Unexpected token (line 3 column 7)'))).toEqual({
      line: 3,
      column: 7,
    })
  })
})

describe('validateWire: NULL, empty and default', () => {
  test('NULL needs a nullable column (auto-increment accepts NULL)', () => {
    expect(validateWire(name, NULL_WIRE)?.key).toBe('rows.form.err.notNull')
    expect(validateWire(note, NULL_WIRE)).toBeNull()
    expect(validateWire(id, NULL_WIRE)).toBeNull()
  })
  test('an empty text is a value for text kinds and an error for numbers', () => {
    expect(validateWire(note, { t: 'v', v: '' })).toBeNull()
    expect(validateWire(id, { t: 'v', v: '' })?.key).toBe('rows.form.err.required')
    expect(validateWire(name, { t: 'default' })).toBeNull()
    expect(validateWire(created, { t: 'fn', name: 'now' })).toBeNull()
  })
})

// ---- Dirty tracking: an untouched value is never sent (FR-ROW-016, DATA-ISS-010) ---------------------------------------------------

describe('dirty tracking', () => {
  test('bit values use one padded format; null and text originals', () => {
    const bit = col({ name: 'b', kind: 'bit', length: 12 })
    expect(editText(bit, '101')).toBe("b'000000000101'")
    expect(editText(bit, "b'101'")).toBe("b'000000000101'")
    expect(formatBit(bit, '1')).toBe("b'000000000001'")
    expect(initialWire(note, null)).toEqual(NULL_WIRE)
    expect(initialWire(note, 'a\r\nb  ')).toEqual({ t: 'v', v: 'a\r\nb  ' })
  })

  test('a field edited back to the original is not dirty', () => {
    const original = '2024-03-05 12:34:56.123456'
    expect(isDirty(created, original, initialWire(created, original), false)).toBe(false)
    expect(isDirty(created, original, { t: 'v', v: '2024-03-05 12:34:56' }, true)).toBe(true)
    expect(isDirty(created, original, { t: 'v', v: original }, true)).toBe(false)
    expect(isDirty(note, null, { t: 'v', v: '' }, true)).toBe(true)
    expect(isDirty(note, 'x', NULL_WIRE, true)).toBe(true)
  })

  test('a cut value or a long binary has no known original: dirty only once touched', () => {
    const cut: Cell = { cut: 'abc', length: 100_000 }
    expect(isDirty(note, cut, { t: 'v', v: 'abc' }, false)).toBe(false)
    expect(isDirty(note, cut, { t: 'v', v: 'abc' }, true)).toBe(true)
    const blob = col({ name: 'img', kind: 'blob' })
    const bytes: Cell = { binary: '00'.repeat(32), size: 5000 }
    expect(isDirty(blob, bytes, { t: 'v', v: '' }, false)).toBe(false)
    expect(isDirty(blob, bytes, { t: 'bin', upload: 'abcdefgh' }, true)).toBe(true)
  })

  test('a short binary value is complete in the grid and editable as hex', () => {
    const bin = col({ name: 'k', kind: 'binary', length: 4 })
    const cell: Cell = { binary: '7f000001', size: 4 }
    expect(editText(bin, cell)).toBe('0x7F000001')
    expect(isDirty(bin, cell, initialWire(bin, cell), false)).toBe(false)
  })
})

describe('line breaks survive a textarea', () => {
  test('CR LF is put back by position after an edit', () => {
    expect(restoreLineBreaks('a\r\nb\r\nc', 'aX\nb\nc')).toBe('aX\r\nb\r\nc')
    expect(restoreLineBreaks('a\r\nb', 'a\nb\nnew')).toBe('a\r\nb\r\nnew')
    expect(restoreLineBreaks('a\nb', 'a\nb\nc')).toBe('a\nb\nc')
    expect(toTextareaValue('a\r\nb\rc')).toBe('a\nb\nc')
  })
})

describe('guards for the conflict check', () => {
  test('digest kinds are guarded by the digest, others by their text; cut values need a digest', () => {
    const json = col({ name: 'j', kind: 'json' })
    const digest = 'a'.repeat(64)
    expect(needsDigest(json, '{}')).toBe(true)
    expect(tryGuard(json, '{}')).toBeNull()
    expect(tryGuard(json, '{}', digest)).toEqual({ t: 'digest', v: digest })
    expect(tryGuard(note, 'x')).toEqual({ t: 'v', v: 'x' })
    expect(tryGuard(note, null)).toEqual({ t: 'null' })
    expect(tryGuard(note, { cut: 'x', length: 1e6 })).toBeNull()
    expect(tryGuard(note, { cut: 'x', length: 1e6 }, digest)).toEqual({ t: 'digest', v: digest })
    expect(guardOf(note, { cut: 'x', length: 1e6 })).toEqual({ t: 'null' })
    expect(tryGuard(col({ name: 'k', kind: 'binary' }), { binary: 'ff', size: 1 })).toEqual({
      t: 'v',
      v: '0xFF',
    })
  })

  test('delete guards leave out what cannot be compared exactly', () => {
    const table1 = table([id, name, col({ name: 'f', kind: 'float' }), note])
    const guards = snapshotGuards(
      table1,
      ['id', 'name', 'f', 'note'],
      ['1', 'Ann', '0.5', { cut: 'x', length: 9e5 }],
    )
    expect(Object.keys(guards)).toEqual(['id', 'name'])
  })

  test('row keys come from the identity columns; a cut key cell gives no key', () => {
    const identity: Identity = { kind: 'primary', columns: ['id'] }
    expect(rowKeyOf(identity, customer, ['id', 'name'], ['7', 'A'])).toEqual({
      id: { t: 'v', v: '7' },
    })
    expect(rowKeyOf(identity, customer, ['id'], [{ cut: '7', length: 1e6 }])).toBeNull()
    // an all-columns key is never built from a cut cell: the action is off instead
    expect(
      rowKeyOf(
        { kind: 'all-columns', columns: ['id', 'note'] },
        customer,
        ['id', 'note'],
        ['1', { cut: 'x', length: 900 }],
      ),
    ).toBeNull()
    expect(rowKeyOf({ kind: 'none', reason: 'view' }, customer, ['id'], ['7'])).toBeNull()
  })
})

// ---- Insert, edit, copy and bulk changes (FR-ROW-015, 016, 018) ----------------------------------------------------------------------

describe('insert form', () => {
  test('defaults start as DEFAULT, nullable columns as NULL, a required enum at its first member', () => {
    expect(insertInitial(id)).toEqual({ t: 'default' })
    expect(insertInitial(created)).toEqual({ t: 'default' })
    expect(insertInitial(note)).toEqual(NULL_WIRE)
    expect(insertInitial(flag)).toEqual(NULL_WIRE)
    expect(
      insertInitial(col({ name: 'e', kind: 'enum', members: ['m'], nullable: false })),
    ).toEqual({
      t: 'v',
      v: 'm',
    })
    expect(insertInitial(name)).toEqual({ t: 'v', v: '' })
  })

  test('only fields that moved away from DEFAULT or NULL are sent', () => {
    const block = makeInsertBlock(customer)
    const set = (c: string, w: WireValue) => {
      const f = block[c]
      if (f) block[c] = { ...f, current: w, touched: true }
    }
    set('name', { t: 'v', v: 'Ann' })
    set('created', { t: 'fn', name: 'now' })
    const built = buildFormChange({
      mode: 'insert',
      model: customer,
      blocks: [block],
      ignore: false,
    })
    expect(built.change).toEqual({
      op: 'insert',
      ignore: false,
      rows: [{ name: { t: 'v', v: 'Ann' }, created: { t: 'fn', name: 'now' } }],
    })
    expect(sendInInsert(note, NULL_WIRE, NULL_WIRE)).toBe(false)
    expect(sendInInsert(note, NULL_WIRE, { t: 'v', v: '' })).toBe(true)
  })

  test('presets (a foreign key from the referencing panel) are sent', () => {
    const block = makeInsertBlock(customer, { flag: 'b' })
    const built = buildFormChange({
      mode: 'insert',
      model: customer,
      blocks: [block],
      ignore: true,
    })
    expect(built.change).toMatchObject({ op: 'insert', ignore: true })
    expect((built.change as { rows: Record<string, WireValue>[] }).rows[0]?.['flag']).toEqual({
      t: 'v',
      v: 'b',
    })
  })

  test('an invalid value gives a field error and no change; generated columns are never sent', () => {
    const gen = col({ name: 'g', kind: 'int', generated: 'stored' })
    const m = table([id, name, gen])
    const block = makeInsertBlock(m)
    expect(block['g']).toBeUndefined()
    const n = block['name']
    if (n) block['name'] = { ...n, current: { t: 'v', v: 'x'.repeat(11) }, touched: true }
    const built = buildFormChange({ mode: 'insert', model: m, blocks: [block], ignore: false })
    expect(built.change).toBeNull()
    expect(built.errors[fieldKey(0, 'name')]?.key).toBe('rows.form.err.tooLong')
  })

  test('several rows give one record each', () => {
    const blocks = [makeInsertBlock(customer), makeInsertBlock(customer)]
    const built = buildFormChange({ mode: 'insert', model: customer, blocks, ignore: false })
    expect((built.change as { rows: unknown[] }).rows).toHaveLength(2)
  })
})

describe('edit form', () => {
  const found = (cells: Cell[], digests: Record<string, string> = {}) => ({
    found: true as const,
    columns: customer.columns.map((c) => c.name),
    cells,
    digests,
  })
  const row: Cell[] = ['7', 'Ann', 'a\r\nb', '2024-03-05 12:34:56.123456', null]

  test('saving without touching anything sends nothing', () => {
    const block = blockFromRow(customer, found(row))
    const built = buildFormChange({
      mode: 'edit',
      model: customer,
      blocks: [block],
      ignore: false,
      rowKey: { id: { t: 'v', v: '7' } },
    })
    expect(built.noChanges).toBe(true)
    expect(built.change).toBeNull()
  })

  test('only the changed column is in SET, with the old value as the guard', () => {
    const block = blockFromRow(customer, found(row))
    const f = block['name']
    if (f) block['name'] = { ...f, current: { t: 'v', v: 'Anna' }, touched: true }
    const built = buildFormChange({
      mode: 'edit',
      model: customer,
      blocks: [block],
      ignore: false,
      rowKey: { id: { t: 'v', v: '7' } },
    })
    expect(built.change).toEqual({
      op: 'update',
      targets: [{ key: { id: { t: 'v', v: '7' } }, old: { name: { t: 'v', v: 'Ann' } } }],
      set: { name: { t: 'v', v: 'Anna' } },
    })
  })

  test('edit back to the original is treated as not dirty (step 3 of SCN-039)', () => {
    const block = blockFromRow(customer, found(row))
    const f = block['note']
    if (f) block['note'] = { ...f, current: { t: 'v', v: 'x' }, touched: true }
    const g = block['note']
    if (g) block['note'] = { ...g, current: { t: 'v', v: 'a\r\nb' }, touched: true }
    const built = buildFormChange({
      mode: 'edit',
      model: customer,
      blocks: [block],
      ignore: false,
      rowKey: { id: { t: 'v', v: '7' } },
    })
    expect(built.noChanges).toBe(true)
  })

  test('a digest column is guarded by the digest of readRow', () => {
    const json = col({ name: 'meta', kind: 'json' })
    const m = table([id, json])
    const digest = 'b'.repeat(64)
    const block = blockFromRow(m, {
      found: true,
      columns: ['id', 'meta'],
      cells: ['1', '{"a":1}'],
      digests: { meta: digest },
    })
    const f = block['meta']
    if (f) block['meta'] = { ...f, current: { t: 'v', v: '{"a":2}' }, touched: true }
    const built = buildFormChange({
      mode: 'edit',
      model: m,
      blocks: [block],
      ignore: false,
      rowKey: { id: { t: 'v', v: '1' } },
    })
    expect((built.change as { targets: { old: unknown }[] }).targets[0]?.old).toEqual({
      meta: { t: 'digest', v: digest },
    })
  })
})

describe('copy and bulk edit', () => {
  test('a copy leaves auto-increment to the server and copies the other values', () => {
    const block = blockForCopy(
      customer,
      {
        found: true,
        columns: customer.columns.map((c) => c.name),
        cells: ['7', 'Ann', 'x', '2024-01-01 00:00:00.000000', 'a'],
        digests: {},
      },
      {},
    )
    const built = buildFormChange({ mode: 'copy', model: customer, blocks: [block], ignore: false })
    const rows = (built.change as { rows: Record<string, WireValue>[] }).rows
    expect(rows[0]?.['id']).toBeUndefined()
    expect(rows[0]?.['name']).toEqual({ t: 'v', v: 'Ann' })
    expect(rows[0]?.['flag']).toEqual({ t: 'v', v: 'a' })
  })

  test('a copy takes long text from the full read', () => {
    const block = blockForCopy(
      customer,
      { found: true, columns: ['note'], cells: [{ cut: 'ab', length: 100 }], digests: {} },
      { note: 'ab'.repeat(50) },
    )
    expect(block['note']?.current).toEqual({ t: 'v', v: 'ab'.repeat(50) })
  })

  test('bulk edit: one UPDATE per row with the old value of each ticked column', () => {
    const block = makeBulkBlock(customer)
    const f = block['flag']
    if (f) block['flag'] = { ...f, current: { t: 'v', v: 'b' }, touched: true }
    const built = buildFormChange({
      mode: 'bulk-edit',
      model: customer,
      blocks: [block],
      ignore: false,
      bulkColumns: new Set(['flag']),
      bulk: {
        columns: ['id', 'flag'],
        rows: [
          { key: { id: { t: 'v', v: '1' } }, cells: ['1', 'a'] },
          { key: { id: { t: 'v', v: '2' } }, cells: ['2', null] },
        ],
      },
    })
    expect(built.change).toEqual({
      op: 'update',
      set: { flag: { t: 'v', v: 'b' } },
      targets: [
        { key: { id: { t: 'v', v: '1' } }, old: { flag: { t: 'v', v: 'a' } } },
        { key: { id: { t: 'v', v: '2' } }, old: { flag: { t: 'null' } } },
      ],
    })
    expect(
      buildFormChange({ mode: 'bulk-edit', model: customer, blocks: [block], ignore: false })
        .noChanges,
    ).toBe(true)
    expect(bulkEligible(col({ name: 'f', kind: 'float' }))).toBe(false)
    expect(bulkEligible(flag)).toBe(true)
  })
})

describe('items and permissions', () => {
  test('a composite foreign key is one item, picked together', () => {
    const fk: FkInfo = {
      name: 'fk_ab',
      columns: ['a', 'b'],
      refDb: 'shop',
      refTable: 'p',
      refColumns: ['x', 'y'],
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    }
    const m = table([id, col({ name: 'a', kind: 'int' }), col({ name: 'b', kind: 'int' })], {
      outgoing: [fk],
    })
    const items = buildItems(m, false, 'insert')
    expect(items.map((i) => i.kind)).toEqual(['column', 'fk'])
  })

  test('invisible columns are hidden unless asked for', () => {
    const m = table([id, col({ name: 'my_row_id', kind: 'int', invisible: true })])
    expect(buildItems(m, false, 'insert')).toHaveLength(1)
    expect(buildItems(m, true, 'insert')).toHaveLength(2)
  })

  test('disabledReason: generated, read-only connection, privileges', () => {
    expect(
      disabledReason(col({ name: 'g', kind: 'int', generated: 'virtual' }), 'edit', perms),
    ).toBe('generated')
    expect(disabledReason(name, 'edit', { ...perms, readOnly: true })).toBe('read-only')
    expect(disabledReason(name, 'insert', { ...perms, insert: false })).toBe('privilege')
    expect(disabledReason(name, 'edit', { ...perms, updateColumns: ['note'] })).toBe('privilege')
    expect(disabledReason(note, 'edit', { ...perms, updateColumns: ['note'] })).toBeNull()
  })

  test('canEditColumn and the grid hook: views, no identity, no key, read-only, unknown type', () => {
    const identity: Identity = { kind: 'primary', columns: ['id'] }
    expect(canEditColumn(name, customer, identity, perms, true)).toBe(true)
    expect(canEditColumn(name, { ...customer, kind: 'view' }, identity, perms, true)).toBe(false)
    expect(canEditColumn(name, customer, { kind: 'none', reason: 'view' }, perms, true)).toBe(false)
    expect(canEditColumn(name, customer, identity, perms, false)).toBe(false)
    expect(canEditColumn(name, customer, identity, { ...perms, readOnly: true }, true)).toBe(false)
    expect(
      canEditColumn(col({ name: 'u', kind: 'unknown' }), customer, identity, perms, true),
    ).toBe(false)
    const ctx = {
      column: name,
      table: customer,
      identity,
      permissions: perms,
      key: { id: { t: 'v', v: '1' } },
    } as unknown as CellContext
    expect(canEditCell(ctx)).toBe(true)
    expect(canEditCell({ ...ctx, key: undefined })).toBe(false)
  })

  test('one line edits a cell; long text, JSON, sets and binary use the dialog', () => {
    expect(inlineEligible(name, 'Ann')).toBe(true)
    expect(inlineEligible(name, 'a\nb')).toBe(false)
    expect(inlineEligible(note, 'x')).toBe(false)
    expect(inlineEligible(col({ name: 'j', kind: 'json' }), '{}')).toBe(false)
    expect(inlineEligible(flag, 'a')).toBe(true)
    expect(inlineEligible(col({ name: 'x', kind: 'int' }), { binary: '00', size: 1 })).toBe(false)
  })

  test('alignRow puts the re-read row in the order of the grid', () => {
    const done = {
      kind: 'done',
      columns: ['b', 'a'],
      rows: [['B', 'A']],
    } as unknown as DoneResponse
    expect(alignRow(['a', 'b', 'c'], done, ['x', 'y', 'z'])).toEqual(['A', 'B', 'z'])
  })

  test('functions per kind are a fixed list', () => {
    expect(functionsFor(created)).toContain('now')
    expect(functionsFor(name)).toEqual([])
    expect(functionsFor(col({ name: 'u', kind: 'uuid' }))).toEqual(['uuid'])
    expect(functionsFor(col({ name: 'u', kind: 'char', length: 36 }))).toEqual(['uuid'])
  })
})

// ---- Conflict -----------------------------------------------------------------------------------------------------------------

describe('conflict', () => {
  const conflict: ConflictResponse = {
    kind: 'conflict',
    index: 1,
    columns: ['id', 'name'],
    current: ['2', 'Bob'],
    digests: {},
    changed: ['name'],
    outcomes: [],
  }

  test('overwrite resends the current values as the old ones, for the conflicting row only', () => {
    const change = {
      op: 'update' as const,
      set: { name: { t: 'v' as const, v: 'X' } },
      targets: [
        { key: { id: { t: 'v' as const, v: '1' } }, old: { name: { t: 'v' as const, v: 'Ann' } } },
        { key: { id: { t: 'v' as const, v: '2' } }, old: { name: { t: 'v' as const, v: 'Old' } } },
      ],
    }
    const next = overwriteChange(change, conflict, customer)
    expect(next).toMatchObject({
      op: 'update',
      targets: [{ old: { name: { t: 'v', v: 'Ann' } } }, { old: { name: { t: 'v', v: 'Bob' } } }],
    })
    expect(currentGuard(customer, conflict, 'name')).toEqual({ t: 'v', v: 'Bob' })
    expect(currentGuard(customer, conflict, 'nope')).toBeNull()
    expect(overwriteChange({ op: 'insert', rows: [], ignore: false }, conflict, customer).op).toBe(
      'insert',
    )
  })

  test('the dialog names the row, shows both values and starts on Reload', () => {
    const change = {
      op: 'update' as const,
      set: { name: { t: 'v' as const, v: 'X' } },
      targets: [
        { key: {} as Record<string, never>, old: {} as Record<string, never> },
        { key: {}, old: { name: { t: 'v' as const, v: 'Old' } } },
      ],
    }
    const html = renderToStaticMarkup(
      createElement(ConflictDialog, {
        conflict,
        change,
        model: customer,
        total: 2,
        busy: false,
        onReload: () => undefined,
        onOverwrite: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain(t('rows.dialog.conflict.title'))
    expect(html).toContain('Bob')
    expect(html).toContain('Old')
    expect(html).toContain('X')
    expect(html).toContain(t('rows.dialog.conflict.bodyBulk', { n: 2, total: 2 }))
    expect(html).toContain(t('rows.dialog.conflict.overwrite'))
  })
})

// ---- Confirmation dialog (FR-ROW-020, SCN-040, 041) -----------------------------------------------------------------------------------

describe('RowPlanDialog', () => {
  const statement = (n: number) => ({
    sql: 'DELETE FROM `shop`.`customer` WHERE `id` <=> ?',
    preview: `DELETE FROM \`shop\`.\`customer\` WHERE \`id\` <=> ${n}`,
    effect: 'Deletes one row',
    class: 'hard' as const,
  })
  const plan = (over: Partial<ConfirmResponse> = {}): ConfirmResponse => ({
    kind: 'confirm',
    planId: 'plan-123456',
    confirmRequired: true,
    confirmToken: 'tok',
    expiresAt: Date.now() + 600_000,
    statements: [statement(1), statement(2), statement(3)],
    totalStatements: 12,
    maxClass: 'hard',
    reasons: ['bulk', 'cascade'],
    warnings: [{ code: 'no-rollback', message: 'MyISAM cannot roll back' }],
    identityKind: 'primary',
    cascadeTables: [{ db: 'shop', table: 'orders', fk: 'fk_customer' }],
    ...over,
  })
  const render = (p: ConfirmResponse, rows = 12) =>
    renderToStaticMarkup(
      createElement(RowPlanDialog, {
        plan: p,
        operation: 'delete',
        rowCount: rows,
        tableName: 'customer',
        busy: false,
        error: null,
        canRetry: false,
        onConfirm: () => undefined,
        onCancel: () => undefined,
        onRetry: () => undefined,
      }),
    )

  test('hard: statements, "and 9 more", cascade tables, warnings and a typed confirmation', () => {
    const html = render(plan())
    expect(html).toContain('&lt;=&gt; 1')
    expect(html).toContain(t('rows.dialog.andMore', { count: 9 }))
    expect(html).toContain('shop.orders (fk_customer)')
    expect(html).toContain('MyISAM cannot roll back')
    expect(html).toContain(t('structure.confirm.typeName', { name: 'customer' }))
    expect(html).toContain(t('rows.dialog.title.deleteHard'))
    expect(html).toContain('disabled')
    expect(html).toContain(rowsText(12))
  })

  test('soft: no typed confirmation, the run button is enabled', () => {
    const html = render(
      plan({
        maxClass: 'soft',
        confirmRequired: false,
        confirmToken: undefined,
        statements: [statement(1)],
        totalStatements: 1,
        reasons: [],
        warnings: [],
        cascadeTables: undefined,
      }),
      1,
    )
    expect(html).not.toContain(t('structure.confirm.typeName', { name: 'customer' }))
    expect(html).toContain(t('rows.dialog.title.deleteSoft'))
    expect(html).toContain(rowsText(1))
  })

  test('an all-columns plan shows the match count and the hint', () => {
    const html = renderToStaticMarkup(
      createElement(PlanBody, {
        plan: plan({ identityKind: 'all-columns', matchCount: 2 }),
        tableName: 'nokey',
      }),
    )
    expect(html).toContain(t('rows.dialog.allColumns', { count: 2, table: 'nokey' }))
  })

  test('hostile statement text and warnings render as text', () => {
    const html = render(
      plan({
        statements: [
          { ...statement(1), preview: '<img src=x onerror=alert(1)>', effect: '<b>x</b>' },
        ],
        totalStatements: 1,
        warnings: [{ code: 'w', message: '<script>alert(1)</script>' }],
      }),
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;img')
  })

  test('rows are counted with a plural', () => {
    expect(rowsText(1)).toBe('1 row')
    expect(rowsText(1200)).toBe('1,200 rows')
  })
})

// ---- Editors and renderers (FR-ROW-031) -----------------------------------------------------------------------------------------------------

const editorProps = (column: RowColumn, current: WireValue, original: Cell = null) => ({
  column,
  value: { original, current, dirty: false },
  onChange: () => undefined,
  labelId: 'lbl',
  describedById: 'lbl-desc',
  mode: 'edit' as const,
  locale: 'en-US',
})
const renderEditor = (props: ReturnType<typeof editorProps>) =>
  renderToStaticMarkup(createElement(valueEditors.get(props.column.kind), props))

describe('value editors', () => {
  test('every built-in kind has an entry and unknown kinds fall back to a message', () => {
    for (const kind of [
      'int',
      'decimal',
      'float',
      'bit',
      'date',
      'time',
      'datetime',
      'timestamp',
      'year',
      'char',
      'text',
      'enum',
      'set',
      'binary',
      'blob',
      'json',
      'geometry',
      'uuid',
      'inet6',
    ] as const) {
      expect(valueEditors.has(kind)).toBe(true)
    }
    expect(valueEditors.has('unknown')).toBe(false)
    const html = renderEditor(
      editorProps(col({ name: 'u', kind: 'unknown', fullType: 'point2d' }), { t: 'v', v: '' }),
    )
    expect(html).toContain('point2d')
    expect(html).toContain('not supported for editing')
  })

  test('a nullable column with a default offers value, NULL and default as radios with names', () => {
    const html = renderEditor(editorProps(created, { t: 'v', v: '2024-01-01 00:00:00' }))
    expect(html.match(/type="radio"/g)?.length).toBe(4)
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain(t('rows.form.mode.null'))
    expect(html).toContain(t('rows.form.mode.default'))
    expect(html).toContain(t('rows.form.mode.function'))
  })

  test('NULL mode shows the word NULL and no input; default mode shows the default', () => {
    const nullHtml = renderEditor(editorProps(note, NULL_WIRE))
    expect(nullHtml).toContain(t('rows.form.isNull'))
    expect(nullHtml).not.toContain('<textarea')
    const defHtml = renderEditor(editorProps(created, { t: 'default' }))
    expect(defHtml).toContain('CURRENT_TIMESTAMP(6)')
    expect(modeOf({ t: 'fn', name: 'now' })).toBe('fn')
  })

  test('a NOT NULL column without default has no mode bar', () => {
    const html = renderEditor(editorProps(name, { t: 'v', v: 'x' }))
    expect(html).not.toContain('radiogroup')
  })

  test('an untouched cut text shows a partial notice instead of an input that could write a cut value', () => {
    const html = renderEditor(
      editorProps(note, { t: 'v', v: 'abc' }, { cut: 'abc', length: 100000 }),
    )
    expect(html).toContain('readOnly')
    expect(html).toContain(t('rows.form.loadFull'))
    expect(html).toContain(t('rows.form.replace'))
  })

  test('a text with CR LF is shown with LF in the textarea and says its breaks are kept', () => {
    const html = renderEditor(editorProps(note, { t: 'v', v: 'a\r\nb' }, 'a\r\nb'))
    expect(html).toContain(t('rows.form.crlfKept'))
    expect(html).not.toContain('\r')
  })

  test('set shows one checkbox per member and says when the set is empty', () => {
    const set = col({ name: 's', kind: 'set', members: ['x', 'y'] })
    const html = renderEditor(editorProps(set, { t: 'v', v: '' }, ''))
    expect(html.match(/type="checkbox"/g)?.length).toBe(2)
    expect(html).toContain(t('rows.form.emptySet'))
  })

  test('JSON shows its state and format buttons', () => {
    const json = col({ name: 'j', kind: 'json' })
    const bad = renderEditor(editorProps(json, { t: 'v', v: '{"a":' }))
    expect(bad).toContain('Invalid at line 1')
    const ok = renderEditor(editorProps(json, { t: 'v', v: '{"a":1}' }))
    expect(ok).toContain(t('rows.form.jsonValid'))
    expect(ok).toContain(t('rows.form.jsonFormat'))
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(compactJson('{ "a" : 1 }')).toBe('{"a":1}')
    expect(prettyJson('{')).toBeNull()
  })

  test('geometry says WKT, the SRID and that there is no map', () => {
    const html = renderEditor(
      editorProps(col({ name: 'g', kind: 'geometry', srid: 4326 }), { t: 'v', v: 'POINT(1 2)' }),
    )
    expect(html).toContain('SRID 4326')
    expect(html).toContain('map view not available')
  })

  test('timestamps get a format hint, a picker without fractions, and no picker with them', () => {
    const plain = col({ name: 'ts', kind: 'timestamp', fsp: 0 })
    const withPicker = renderEditor(editorProps(plain, { t: 'v', v: '2024-03-05 12:34:56' }))
    expect(withPicker).toContain('type="datetime-local"')
    expect(withPicker).toContain('YYYY-MM-DD HH:MM:SS')
    const fractional = renderEditor(
      editorProps(col({ name: 'ts', kind: 'timestamp', fsp: 6 }), {
        t: 'v',
        v: '2024-03-05 12:34:56.123456',
      }),
    )
    expect(fractional).not.toContain('datetime-local')
    expect(pickerValue('datetime', '2024-03-05 12:34:56')).toBe('2024-03-05T12:34:56')
    expect(pickerValue('datetime', '2024-03-05 12:34:56.5')).toBe('')
    expect(pickerValue('date', '0099-01-01')).toBe('0099-01-01')
    expect(pickerToText('datetime', '2024-03-05T12:34')).toBe('2024-03-05 12:34:00')
    expect(pickerToText('time', '12:34')).toBe('12:34:00')
  })

  test('the blob editor offers upload, never a text area', () => {
    const blob = col({ name: 'img', kind: 'blob' })
    const html = renderEditor(
      editorProps(blob, { t: 'v', v: '' }, { binary: '89504e47', size: 5000 }),
    )
    expect(html).toContain('type="file"')
    expect(html).toContain(t('rows.blob.choose'))
    expect(html).not.toContain('<textarea')
    expect(html).toContain('4.9 KiB')
  })

  test('an enum keeps a stored value that is not a member', () => {
    const html = renderEditor(editorProps(flag, { t: 'v', v: 'zzz' }, 'zzz'))
    expect(html).toContain('<option value="zzz"')
  })
})

describe('cell renderers', () => {
  test('text nodes only: hostile data cannot become markup', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        cellRenderers.get('char')('<img src=x onerror=alert(1)>', name, {
          ...opts,
          displayChars: 100,
        }),
      ),
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('partial mode cuts at the display length, full text does not, NULL is marked', () => {
    const cut = renderToStaticMarkup(
      createElement('div', null, cellRenderers.get('char')('abcdefgh', name, opts)),
    )
    expect(cut).toContain('abcde…')
    const full = renderToStaticMarkup(
      createElement(
        'div',
        null,
        cellRenderers.get('char')('abcdefgh', name, { ...opts, fullText: true }),
      ),
    )
    expect(full).toContain('abcdefgh')
    expect(
      renderToStaticMarkup(createElement('div', null, cellRenderers.get('char')(null, name, opts))),
    ).toContain('NULL')
  })

  test('binary shows hex and size, protected binary only the size', () => {
    const blob = col({ name: 'b', kind: 'blob' })
    const shown = renderToStaticMarkup(
      createElement(
        'div',
        null,
        cellRenderers.get('blob')({ binary: 'ff00', size: 2 }, blob, opts),
      ),
    )
    expect(shown).toContain('0xFF00')
    const hidden = renderToStaticMarkup(
      createElement(
        'div',
        null,
        cellRenderers.get('blob')({ binary: 'ff00', size: 2 }, blob, {
          ...opts,
          protectBinary: true,
        }),
      ),
    )
    expect(hidden).not.toContain('0xFF00')
    expect(hidden).toContain('2 B')
  })

  test('BIT is shown padded in one format', () => {
    const bit = col({ name: 'b', kind: 'bit', length: 12 })
    expect(
      renderToStaticMarkup(
        createElement(
          'div',
          null,
          cellRenderers.get('bit')('101', bit, { ...opts, displayChars: 100 }),
        ),
      ),
    ).toContain('000000000101')
  })
})

// ---- Visible markers and the hex view (FR-ROW-011, UI-ISS-114) ---------------------------------------------------------------------------------

describe('cell viewer helpers', () => {
  test('control and special characters are marked, runs of spaces stay as typed', () => {
    const segments = markControls('a  b\r\n\tc d​e')
    const kinds = segments.filter((s) => s.marker).map((s) => s.marker?.kind)
    expect(kinds).toEqual(['cr', 'lf', 'tab', 'nbsp', 'zeroWidth'])
    expect(segments.map((s) => s.text).join('')).toBe('a  b\r\n\tc d​e')
    expect(segments[0]?.text).toBe('a  b')
  })

  test('the hex dump is a read-only view of the bytes', () => {
    const dump = hexDump(new Uint8Array([0, 255, 10, 0x41]))
    expect(dump).toContain('00000000')
    expect(dump).toContain('00 ff 0a 41')
    expect(dump.endsWith('...A')).toBe(true)
    expect(Array.from(hexToBytes('0x00FF0A'))).toEqual([0, 255, 10])
    expect(wireEqual({ t: 'v', v: 'a' }, { t: 'v', v: 'a' })).toBe(true)
  })
})

// ---- Foreign keys and the server API ----------------------------------------------------------------------------------------------------------

describe('foreign key picker and API wiring', () => {
  const fk: FkInfo = {
    name: 'fk_customer',
    columns: ['customer_id'],
    refDb: 'shop',
    refTable: 'customer',
    refColumns: ['id'],
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT',
  }

  test('option labels show display value and key', () => {
    expect(optionLabel({ key: { id: '7' }, display: 'Ann' }, fk)).toBe('Ann (7)')
    expect(optionLabel({ key: { id: '7' }, display: '7' }, fk)).toBe('7')
    expect(optionLabel({ key: { id: null }, display: '' }, fk)).toBe('NULL')
  })

  test('the picker shows the stored key, a Find button and the referenced table name', () => {
    const html = renderToStaticMarkup(
      createElement(FkBody, {
        fk,
        keys: ['7'],
        onPick: () => undefined,
        onType: () => undefined,
        labelId: 'l',
      }),
    )
    expect(html).toContain('value="7"')
    expect(html).toContain(t('rows.fk.findIn', { table: 'customer' }))
  })

  test('the key of a row created from the picker comes from the re-read row, else the insert id', () => {
    const done = {
      kind: 'done',
      columns: ['id', 'name'],
      rows: [['15', 'N']],
      outcomes: [{ index: 0, status: 'applied', insertId: '15' }],
    } as unknown as DoneResponse
    expect(newKeyOf(fk, done)).toEqual({ id: '15' })
    const bare = {
      kind: 'done',
      columns: [],
      rows: [],
      outcomes: [{ index: 0, status: 'applied', insertId: '16' }],
    } as unknown as DoneResponse
    expect(newKeyOf(fk, bare)).toEqual({ id: '16' })
  })

  test('refusal codes get their own words; the raw code never shows', () => {
    expect(describeRowsRefusal(new Error('read-only: nope')).code).toBe('read-only')
    expect(describeRowsRefusal(new Error('no-identity: x')).message).toBe(
      t('rows.form.refusal.noIdentity'),
    )
    expect(describeRowsRefusal(new Error('plan-missing: x')).offerNewPreview).toBe(true)
    expect(describeRowsRefusal(new Error('too-large: x')).message).toBe(
      t('rows.blob.tooLargeServer'),
    )
    expect(describeRowsRefusal(new Error('something odd')).message).toBe('something odd')
  })

  test('the API adapter calls server functions with { data } and tests can swap the API', async () => {
    const calls: unknown[] = []
    const fn = (name: string) => (args: { data: unknown }) => {
      calls.push([name, args])
      return Promise.resolve({ ok: true } as never)
    }
    const api = createServerFormsApi(
      {
        getRows: fn('getRows'),
        readRow: fn('readRow'),
        readCell: fn('readCell'),
        openCell: fn('openCell'),
        lookup: fn('lookup'),
        referencingRows: fn('referencingRows'),
        previewRows: fn('previewRows'),
        changeRows: fn('changeRows'),
        confirmRows: fn('confirmRows'),
      },
      () => Promise.resolve({ uploadId: 'u1234567', sha256: 'x', size: 1 }),
    )
    await api.lookup({ db: 'd', table: 't', fk: 'f', page: 0 })
    expect(calls).toEqual([['lookup', { data: { db: 'd', table: 't', fk: 'f', page: 0 } }]])
    expect((await api.uploadFile(new File(['x'], 'a.bin'))).uploadId).toBe('u1234567')
    setFormsApi(api)
    expect(formsApi()).toBe(api)
  })
})
