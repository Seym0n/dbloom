import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CellView, cellTitle, cutText } from '~/components/grid/cell-view'
import { FilterChips, FilterEditor, describeNode } from '~/components/rows/filter-builder'
import {
  conditionsOf,
  emptyGroup,
  fromFilterNode,
  newCondition,
  operatorsFor,
  toFilterNode,
  validateCondition,
  valueShape,
  withColumn,
  withOperator,
  type DraftCondition,
} from '~/components/rows/filter-model'
import {
  canHide,
  clampWidth,
  describeTotal,
  lastPageIndex,
  matchingRows,
  moveColumn,
  newRequestId,
  nextSortList,
  parseDisplayPrefs,
  parseSortPref,
  reconcileLayout,
  rowKeyOf,
  rowRange,
  setColumnWidth,
  toggleHidden,
  visibleOrder,
} from '~/components/rows/grid-model'
import { Pager } from '~/components/rows/pager'
import { RowsGrid } from '~/components/rows/rows-grid'
import type { RowsApi } from '~/components/rows/rows-api'
import {
  emptySelection,
  headerState,
  selectedIndexes,
  selectPage,
  toggleHeader,
  toggleRow,
} from '~/components/rows/selection-model'
import { OPERATORS_BY_KIND } from '~/lib/rows/filter-tree'
import {
  DEFAULT_ROW_LIMITS,
  TYPE_KINDS,
  getRowsInput,
  type Cell,
  type FilterNode,
  type GetRowsResponse,
  type RowColumn,
  type RowTable,
  type TypeKind,
} from '~/server/rows/types'

// ---- Fixtures -------------------------------------------------------------------------------------------------

function column(name: string, kind: TypeKind, extra: Partial<RowColumn> = {}): RowColumn {
  return {
    name,
    ordinal: 1,
    kind,
    baseType: kind,
    fullType: kind,
    nullable: true,
    default: { kind: 'none' },
    autoIncrement: false,
    invisible: false,
    comment: '',
    ...extra,
  }
}

const columns: RowColumn[] = [
  column('id', 'int', { nullable: false }),
  column('name', 'char', { comment: 'Customer <b>name</b>' }),
  column('amount', 'decimal'),
  column('placed', 'timestamp'),
  column('state', 'enum', { members: ['open', 'paid'] }),
  column('doc', 'blob'),
]

const model: RowTable = {
  db: 'shop',
  table: 'orders',
  kind: 'table',
  engine: 'InnoDB',
  transactional: true,
  columns,
  primaryKey: ['id'],
  uniqueKeys: [],
  outgoing: [],
  incoming: [],
  estimatedRows: 2,
}

const rows: Cell[][] = [
  [
    '1',
    '<img src=x onerror=alert(1)>',
    '10.50',
    '2024-03-05 12:00:00',
    'open',
    { binary: 'deadbeef', size: 4 },
  ],
  ['2', null, '7.00', '2024-03-06 12:00:00', 'paid', { cut: 'long text', length: 900 }],
]

function response(extra: Partial<GetRowsResponse> = {}): GetRowsResponse {
  return {
    table: model,
    columns: columns.map((c) => c.name),
    kinds: ['number', 'text', 'number', 'temporal', 'text', 'text'],
    rows,
    page: 0,
    hasNext: false,
    hasPrev: false,
    sqlShown: 'SELECT * FROM `shop`.`orders` LIMIT 50 OFFSET 0',
    total: { kind: 'exact', value: 2 },
    timings: { pageMs: 12 },
    identity: { kind: 'primary', columns: ['id'] },
    permissions: { readOnly: false, insert: true, update: true, delete: true },
    timeZone: 'UTC',
    ...extra,
  }
}

function mockApi(): RowsApi {
  return {
    getRows: vi.fn(async () => response()),
    countRows: vi.fn(async () => ({
      status: 'done' as const,
      total: { kind: 'exact' as const, value: 2 },
      durationMs: 3,
    })),
    cancelCount: vi.fn(async () => {}),
    getLimits: vi.fn(async () => ({ ...DEFAULT_ROW_LIMITS, stateless: false })),
    getPrefs: vi.fn(async () => ({ values: {}, stateless: false })),
    setPref: vi.fn(async () => {}),
  }
}

/** The key the grid uses for its first page, so a seeded cache renders without a server (SSR has no effects). */
function seeded(res: GetRowsResponse, prefs: Record<string, unknown> = {}) {
  const client = new QueryClient()
  client.setQueryData(['rows', 'limits'], { ...DEFAULT_ROW_LIMITS, stateless: false })
  client.setQueryData(['rows', 'prefs', 'shop', 'orders'], { values: prefs, stateless: false })
  const scope = JSON.stringify(['shop', 'orders', 50, [], null, null])
  client.setQueryData(['rows', 'shop', 'orders', 'page', 0, scope], { response: res, stamp: 1 })
  return client
}

function render(client: QueryClient, props: Partial<Parameters<typeof RowsGrid>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RowsGrid, { db: 'shop', table: 'orders', api: mockApi(), ...props }),
    ),
  )
}

// ---- Sort -----------------------------------------------------------------------------------------------------

describe('sort list (FR-ROW-006, FR-UIX-035)', () => {
  test('a plain click cycles asc, desc, none and replaces other columns', () => {
    let s = nextSortList([], 'a', false)
    expect(s).toEqual([{ column: 'a', direction: 'asc' }])
    s = nextSortList(s, 'a', false)
    expect(s).toEqual([{ column: 'a', direction: 'desc' }])
    s = nextSortList(s, 'a', false)
    expect(s).toEqual([])
    expect(nextSortList([{ column: 'x', direction: 'desc' }], 'a', false)).toEqual([
      { column: 'a', direction: 'asc' },
    ])
  })

  test('a modifier click adds, flips and removes one column, at most four', () => {
    let s = nextSortList([{ column: 'a', direction: 'asc' }], 'b', true)
    expect(s.map((e) => e.column)).toEqual(['a', 'b'])
    s = nextSortList(s, 'b', true)
    expect(s[1]).toEqual({ column: 'b', direction: 'desc' })
    s = nextSortList(s, 'b', true)
    expect(s.map((e) => e.column)).toEqual(['a'])
    let four = ['a', 'b', 'c', 'd'].reduce(
      (acc, c) => nextSortList(acc, c, true),
      [] as ReturnType<typeof nextSortList>,
    )
    expect(four).toHaveLength(4)
    four = nextSortList(four, 'e', true)
    expect(four.map((e) => e.column)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('a stored sort keeps only known columns and valid directions', () => {
    expect(
      parseSortPref(
        [
          { column: 'a', direction: 'asc' },
          { column: 'gone', direction: 'asc' },
          { column: 'a', direction: 'desc' },
          { column: 'b', direction: 'sideways' },
        ],
        ['a', 'b'],
      ),
    ).toEqual([{ column: 'a', direction: 'asc' }])
  })
})

// ---- Layout ---------------------------------------------------------------------------------------------------

describe('column layout (FR-ROW-010, DATA-ISS-114)', () => {
  test('a changed structure keeps survivors, drops dropped columns, appends new ones visible', () => {
    const layout = reconcileLayout(
      { order: ['c', 'gone', 'a'], hidden: ['gone', 'a'], widths: { a: 300, gone: 90, c: 10 } },
      ['a', 'b', 'c'],
    )
    expect(layout.order).toEqual(['c', 'a', 'b'])
    expect(layout.hidden).toEqual(['a'])
    expect(layout.widths).toEqual({ a: 300, c: 64 })
    expect(visibleOrder(layout)).toEqual(['c', 'b'])
  })

  test('no stored layout is the table order, all visible', () => {
    expect(reconcileLayout(undefined, ['x', 'y'])).toEqual({
      order: ['x', 'y'],
      hidden: [],
      widths: {},
    })
  })

  test('move, hide, width and the last visible column', () => {
    let l = reconcileLayout(undefined, ['a', 'b', 'c'])
    l = moveColumn(l, 'c', -1)
    expect(l.order).toEqual(['a', 'c', 'b'])
    expect(moveColumn(l, 'a', -1)).toBe(l)
    l = toggleHidden(toggleHidden(l, 'a'), 'b')
    expect(canHide(l, 'c')).toBe(false)
    expect(canHide(l, 'a')).toBe(true)
    expect(setColumnWidth(l, 'c', 5000).widths.c).toBe(800)
    expect(clampWidth(Number.NaN)).toBe(160)
  })

  test('150 columns stay listable and reorderable', () => {
    const names = Array.from({ length: 150 }, (_, i) => `col${i}`)
    const l = reconcileLayout(undefined, names)
    expect(moveColumn(l, 'col149', -1).order.indexOf('col149')).toBe(148)
  })

  test('display preferences are clamped and default to the limits', () => {
    expect(parseDisplayPrefs({}, 100)).toEqual({
      displayChars: 100,
      fullText: false,
      protectBinary: false,
      gridEditing: true,
    })
    expect(
      parseDisplayPrefs({ 'rows.displayChars': 5, 'rows.gridEditing': false }, 100),
    ).toMatchObject({
      displayChars: 20,
      gridEditing: false,
    })
    expect(parseDisplayPrefs({ 'rows.displayChars': 99999 }, 100).displayChars).toBe(1000)
  })
})

// ---- Paging and totals ----------------------------------------------------------------------------------------

describe('paging and totals (FR-ROW-007)', () => {
  test('last page needs an exact total', () => {
    expect(lastPageIndex({ kind: 'estimate', value: 2_000_000 }, 50)).toBeUndefined()
    expect(lastPageIndex({ kind: 'lowerBound', value: 10_000 }, 50)).toBeUndefined()
    expect(lastPageIndex({ kind: 'unknown', value: null }, 50)).toBeUndefined()
    expect(lastPageIndex({ kind: 'exact', value: 1000 }, 50)).toBe(19)
    expect(lastPageIndex({ kind: 'exact', value: 1001 }, 50)).toBe(20)
    expect(lastPageIndex({ kind: 'exact', value: 0 }, 50)).toBe(0)
  })

  test('total wording keys and the row range', () => {
    expect(describeTotal({ kind: 'estimate', value: 5 })).toEqual({ key: 'estimate', value: 5 })
    expect(describeTotal({ kind: 'exact', value: null })).toEqual({ key: 'unknown' })
    expect(rowRange(2, 50, 7)).toEqual({ from: 101, to: 107 })
    expect(rowRange(0, 50, 0)).toBeUndefined()
  })

  test('request ids fit the contract', () => {
    const id = newRequestId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(newRequestId()).not.toBe(id)
  })

  const base = {
    page: 0,
    pageSize: 50,
    pageSizes: [25, 50, 100],
    rowsOnPage: 50,
    hasNext: true,
    hasPrev: false,
    busy: false,
    onPage: () => {},
    onPageSize: () => {},
    onCount: () => {},
    onCancelCount: () => {},
  }

  test('an estimated total shows Count and disables Last page with the reason', () => {
    const html = renderToStaticMarkup(
      createElement(Pager, {
        ...base,
        total: { kind: 'estimate', value: 2_000_000 },
        count: { status: 'idle' },
      }),
    )
    expect(html).toContain('about 2,000,000 rows')
    expect(html).toContain('>Count<')
    expect(html).toMatch(/aria-label="Last page"[^>]*disabled/)
    expect(html).toContain('The last page needs an exact row count')
    expect(html).toContain('Rows 1–50')
  })

  test('a running count turns Count into Cancel; an exact total hides Count and enables Last', () => {
    const running = renderToStaticMarkup(
      createElement(Pager, {
        ...base,
        total: { kind: 'estimate', value: 9 },
        count: { status: 'running' },
      }),
    )
    expect(running).toContain('>Cancel<')
    expect(running).toContain('Counting rows')
    const exact = renderToStaticMarkup(
      createElement(Pager, {
        ...base,
        total: { kind: 'exact', value: 1000 },
        count: { status: 'done', durationMs: 340 },
        pageMs: 12,
      }),
    )
    expect(exact).not.toContain('>Count<')
    expect(exact).not.toMatch(/aria-label="Last page"[^>]*disabled/)
    expect(exact).toContain('Page 1 of 20')
    expect(exact).toContain('page 12 ms')
    expect(exact).toContain('count 340 ms')
  })

  test('a view total is a lower bound and a deep offset shows the hint', () => {
    const html = renderToStaticMarkup(
      createElement(Pager, {
        ...base,
        page: 4000,
        total: { kind: 'lowerBound', value: 10_000 },
        count: { status: 'timeout' },
        deepOffset: true,
      }),
    )
    expect(html).toContain('10,000+ rows')
    expect(html).toContain('Filter the rows or use the SQL tab')
    expect(html).toContain('took too long')
  })
})

// ---- Selection ------------------------------------------------------------------------------------------------

describe('selection (FR-ROW-019, FR-UIX-036, FR-UIX-054)', () => {
  const order = [0, 1, 2, 3, 4, 5]
  test('toggle, shift range, header states', () => {
    let s = toggleRow(emptySelection, 1, order, false)
    expect([...s.selected]).toEqual([1])
    s = toggleRow(s, 4, order, true)
    expect(selectedIndexes(s, 6)).toEqual([1, 2, 3, 4])
    expect(headerState(s, order)).toBe('some')
    s = toggleRow(s, 2, order, false)
    expect(selectedIndexes(s, 6)).toEqual([1, 3, 4])
    s = toggleHeader(s, order)
    expect(headerState(s, order)).toBe('all')
    s = toggleHeader(s, order)
    expect(headerState(s, order)).toBe('none')
  })

  test('a range runs over visible rows only (find hides some)', () => {
    const visible = [0, 2, 4]
    let s = toggleRow(emptySelection, 0, visible, false)
    s = toggleRow(s, 4, visible, true)
    expect(selectedIndexes(s, 6)).toEqual([0, 2, 4])
  })

  test('indexes past the page are dropped', () => {
    expect(selectedIndexes(selectPage([0, 1, 9]), 2)).toEqual([0, 1])
  })
})

// ---- Find in page and row keys --------------------------------------------------------------------------------

describe('find in this page and row keys', () => {
  test('case-insensitive match across cells, NULL never matches text', () => {
    expect(matchingRows(rows, 'DEADBEEF')).toEqual([0])
    expect(matchingRows(rows, 'paid')).toEqual([1])
    expect(matchingRows(rows, '')).toEqual([0, 1])
    expect(matchingRows(rows, 'null')).toEqual([])
  })

  test('keys come from cells; cut and long binary cells make no key', () => {
    expect(rowKeyOf({ kind: 'primary', columns: ['id'] }, ['id', 'name'], ['7', 'x'])).toEqual({
      id: { t: 'v', v: '7' },
    })
    expect(rowKeyOf({ kind: 'none', reason: 'view' }, ['id'], ['1'])).toBeUndefined()
    expect(
      rowKeyOf({ kind: 'primary', columns: ['id'] }, ['id'], [{ cut: 'x', length: 9 }]),
    ).toBeUndefined()
    expect(
      rowKeyOf({ kind: 'unique', columns: ['k'] }, ['k'], [{ binary: '7f000001', size: 4 }]),
    ).toEqual({ k: { t: 'v', v: '0x7f000001' } })
    expect(
      rowKeyOf({ kind: 'unique', columns: ['k'] }, ['k'], [{ binary: '00', size: 40 }]),
    ).toBeUndefined()
    expect(rowKeyOf({ kind: 'primary', columns: ['id'] }, ['id'], [null])).toEqual({
      id: { t: 'null' },
    })
  })
})

// ---- Filter model ---------------------------------------------------------------------------------------------

describe('filter model (FR-ROW-008)', () => {
  const byName = new Map(columns.map((c) => [c.name, c]))

  test('operators per kind are the allow-list of package A, never wider', () => {
    for (const kind of TYPE_KINDS) {
      expect(operatorsFor(kind)).toEqual([...OPERATORS_BY_KIND[kind]])
    }
  })

  test('unary operators take no value, between two, in a list', () => {
    expect(valueShape('is null')).toBe('none')
    expect(valueShape('empty')).toBe('none')
    expect(valueShape('between')).toBe('two')
    expect(valueShape('in')).toBe('list')
    expect(valueShape('contains')).toBe('one')
  })

  test('changing the operator keeps what fits and resets the rest', () => {
    const c = newCondition(byName.get('name')!)
    expect(c.op).toBe('contains')
    const typed: DraftCondition = { ...c, values: ['ann'], matchCase: true }
    expect(withOperator(typed, 'char', 'between').values).toEqual(['ann', ''])
    expect(withOperator(typed, 'char', 'is null')).toMatchObject({ values: [], matchCase: false })
    expect(
      withOperator({ ...typed, op: 'in', values: ['a', '', 'b'] }, 'char', '=').values,
    ).toEqual(['a'])
  })

  test('the user default string operator starts new text conditions', () => {
    expect(newCondition(byName.get('name')!, 'starts with').op).toBe('starts with')
    expect(newCondition(byName.get('id')!, 'starts with').op).toBe('=')
  })

  test('changing the column resets values of another kind and keeps a fitting operator', () => {
    const c = { ...newCondition(byName.get('id')!), op: '>' as const, values: ['5'] }
    const moved = withColumn(c, byName.get('amount')!)
    expect(moved.op).toBe('>')
    expect(moved.values).toEqual([''])
    const toBlob = withColumn(c, byName.get('doc')!)
    expect(operatorsFor('blob')).toContain(toBlob.op)
  })

  test('values are validated per kind', () => {
    const cond = (name: string, op: DraftCondition['op'], values: string[]) =>
      validateCondition({ ...newCondition(byName.get(name)!), op, values }, byName.get(name))
    expect(cond('id', '=', ['12'])).toBeUndefined()
    expect(cond('id', '=', ['0x1F'])).toBeUndefined()
    expect(cond('id', '=', ['1.5'])).toBe('integer')
    expect(cond('id', '=', [''])).toBe('required')
    expect(cond('amount', 'between', ['1.5', '9'])).toBeUndefined()
    expect(cond('amount', 'between', ['1.5'])).toBe('required')
    expect(cond('amount', '=', ['abc'])).toBe('number')
    expect(cond('placed', '>', ['2024-03-05 12:00:00'])).toBeUndefined()
    expect(cond('placed', '>', ['yesterday'])).toBe('datetime')
    expect(cond('state', '=', ['open'])).toBeUndefined()
    expect(cond('state', '=', ['nope'])).toBe('member')
    expect(cond('doc', '=', ['0x7F000001'])).toBeUndefined()
    expect(cond('doc', '=', ['7F'])).toBe('hex')
    expect(cond('name', 'is null', [])).toBeUndefined()
    expect(cond('name', 'in', ['a', 'a'])).toBe('duplicate')
    expect(cond('name', 'in', [])).toBe('required')
    expect(cond('name', 'contains', ['x'.repeat(5000)])).toBe('tooLong')
  })

  test('a draft becomes a wire tree that the contract accepts, empty groups dropped', () => {
    const root = emptyGroup('or')
    const name = { ...newCondition(byName.get('name')!), values: ['ann'], matchCase: true }
    const created: DraftCondition = {
      ...newCondition(byName.get('placed')!),
      op: 'between',
      values: ['2024-01-01T10:00', '2024-02-01T10:00'],
    }
    const nested = { ...emptyGroup('and'), children: [created] }
    const nul = { ...newCondition(byName.get('amount')!), op: 'is null' as const, values: [] }
    root.children.push(name, nested, emptyGroup(), nul)
    const wire = toFilterNode(root, byName) as FilterNode
    expect(wire).toEqual({
      type: 'group',
      op: 'or',
      children: [
        { type: 'condition', column: 'name', op: 'contains', values: ['ann'], matchCase: true },
        {
          type: 'group',
          op: 'and',
          children: [
            {
              type: 'condition',
              column: 'placed',
              op: 'between',
              values: ['2024-01-01 10:00', '2024-02-01 10:00'],
            },
          ],
        },
        { type: 'condition', column: 'amount', op: 'is null', values: [] },
      ],
    })
    const parsed = getRowsInput.parse({
      db: 'shop',
      table: 'orders',
      page: 0,
      pageSize: 50,
      filter: wire,
    })
    expect(parsed.filter).toEqual(wire)
    expect(toFilterNode(emptyGroup(), byName)).toBeUndefined()
  })

  test('a wire tree reopens as a draft and converts back unchanged', () => {
    const wire: FilterNode = {
      type: 'group',
      op: 'and',
      negate: true,
      children: [
        { type: 'condition', column: 'id', op: 'in', values: ['1', '2'] },
        {
          type: 'group',
          op: 'or',
          children: [{ type: 'condition', column: 'name', op: 'empty', values: [] }],
        },
      ],
    }
    const draft = fromFilterNode(wire)
    expect(conditionsOf(draft)).toHaveLength(2)
    expect(toFilterNode(draft, byName)).toEqual(wire)
    expect(fromFilterNode(undefined).children).toEqual([])
    expect(
      fromFilterNode({ type: 'condition', column: 'id', op: '=', values: ['1'] }).children,
    ).toHaveLength(1)
  })

  test('chips describe the filter in words and escape hostile text', () => {
    const wire: FilterNode = {
      type: 'group',
      op: 'and',
      children: [
        { type: 'condition', column: 'name', op: 'contains', values: ['<b>x</b>'] },
        { type: 'condition', column: 'amount', op: 'between', values: ['1', '9'] },
        { type: 'condition', column: 'state', op: 'is null', values: [] },
      ],
    }
    expect(describeNode(wire.type === 'group' ? wire.children[1]! : wire)).toBe(
      'amount is between “1” and “9”',
    )
    const html = renderToStaticMarkup(
      createElement(FilterChips, { applied: wire, onChange: () => {} }),
    )
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('Clear all')
    expect(html).toContain('state is NULL')
  })

  test('the editor offers only the operators of the column kind and numbers its controls', () => {
    const html = renderToStaticMarkup(
      createElement(FilterEditor, {
        columns,
        applied: { type: 'condition', column: 'state', op: 'in', values: ['open'] },
        onApply: () => {},
        onClose: () => {},
      }),
    )
    expect(html).toContain('aria-label="Column of condition 1"')
    expect(html).toContain('aria-label="Operator of condition 1"')
    expect(html).toContain('is one of')
    expect(html).not.toContain('matches regular expression')
    expect(html).toContain('Add condition')
    expect(html).toContain('Apply')
  })
})

// ---- Cell view -------------------------------------------------------------------------------------------------

describe('cell view (FR-ROW-010, 011, UI-ISS-113)', () => {
  test('partial text cuts at the display length and tooltips give length and excerpt', () => {
    const text = 'x'.repeat(300)
    const html = renderToStaticMarkup(createElement(CellView, { cell: text, displayChars: 40 }))
    expect(html).toContain('x'.repeat(40))
    expect(html).not.toContain('x'.repeat(41))
    expect(html).toContain('(300 chars)')
    expect(cellTitle(text, { displayChars: 40 })).toBe(
      `300 characters. Starts with: ${'x'.repeat(200)}`,
    )
    expect(cellTitle(text, { displayChars: 40, fullText: true })).toBeUndefined()
    expect(cellTitle('short', { displayChars: 40 })).toBeUndefined()
    expect(cellTitle(null)).toBeUndefined()
    expect(cellTitle({ binary: 'ff', size: 1 })).toContain('1 bytes')
  })

  test('full text mode shows everything that was loaded', () => {
    const text = 'y'.repeat(300)
    const html = renderToStaticMarkup(
      createElement(CellView, { cell: text, displayChars: 40, fullText: true }),
    )
    expect(html).toContain('y'.repeat(300))
  })

  test('a surrogate pair is never split', () => {
    const text = 'a😀b'
    expect(cutText(text, 2)).toBe('a')
    expect(cutText(text, 3)).toBe('a😀')
  })

  test('binary: hex preview by default, size only when protected', () => {
    const cell = { binary: 'deadbeef', size: 4 }
    expect(renderToStaticMarkup(createElement(CellView, { cell }))).toContain('0xDEADBEEF')
    const protectedHtml = renderToStaticMarkup(
      createElement(CellView, { cell, protectBinary: true }),
    )
    expect(protectedHtml).not.toContain('DEADBEEF')
    expect(protectedHtml).toContain('(4 B)')
  })

  test('without options the output is what the SQL tab always showed', () => {
    expect(
      renderToStaticMarkup(createElement(CellView, { cell: { cut: 'abc', length: 900 } })),
    ).toBe('abc<span class="text-faint">… (900 chars)</span>')
    expect(renderToStaticMarkup(createElement(CellView, { cell: null }))).toContain('NULL')
  })
})

// ---- The grid, rendered from a seeded cache ------------------------------------------------------------------

describe('rows grid', () => {
  test('renders the page as a labelled grid with sort state, selection and the SQL that ran', () => {
    const client = seeded(response())
    client.setQueryData(['rows', 'prefs', 'shop', 'orders'], {
      values: { 'rows.sort': [{ column: 'amount', direction: 'desc' }] },
      stateless: false,
    })
    // The saved sort changes the scope; seed that page too.
    const scope = JSON.stringify([
      'shop',
      'orders',
      50,
      [{ column: 'amount', direction: 'desc' }],
      null,
      null,
    ])
    client.setQueryData(['rows', 'shop', 'orders', 'page', 0, scope], {
      response: response(),
      stamp: 2,
    })
    const html = render(client)
    expect(html).toContain('role="grid"')
    expect(html).toContain('aria-label="Rows of orders"')
    expect(html).toMatch(/<th[^>]*aria-sort="descending"[^>]*>.*?amount/)
    expect(html).toContain('Rows 1–2')
    expect(html).toContain('2 rows')
    expect(html).toContain('SQL that ran')
    expect(html).toContain('<code')
    expect(html).toContain('LIMIT 50 OFFSET 0')
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Select all rows on this page"')
    expect(html).toContain('aria-label="Select row 1"')
  })

  test('hostile cells, column comments and names stay text', () => {
    const hostile = response({
      table: {
        ...model,
        columns: [
          column('id', 'int'),
          column('<i>x</i>', 'char', { comment: '<script>1</script>' }),
        ],
      },
      columns: ['id', '<i>x</i>'],
      kinds: ['number', 'text'],
      rows: [['1', '<img src=x onerror=alert(1)>']],
    })
    const html = render(seeded(hostile))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<i>x</i>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
  })

  test('timestamp headers carry the session time zone, columns without rows say so', () => {
    const html = render(seeded(response()))
    expect(html).toMatch(/placed<\/span><span[^>]*>UTC<\/span>/)
    const empty = render(seeded(response({ rows: [], total: { kind: 'exact', value: 0 } })))
    expect(empty).toContain('This table has no rows.')
    expect(empty).not.toContain('role="grid"')
  })

  test('an empty page under a filter says no rows match and offers to clear', () => {
    const filter: FilterNode = { type: 'condition', column: 'id', op: '=', values: ['99'] }
    const client = seeded(response())
    const scope = JSON.stringify(['shop', 'orders', 50, [], filter, null])
    client.setQueryData(['rows', 'shop', 'orders', 'page', 0, scope], {
      response: response({ rows: [], total: { kind: 'exact', value: 0 } }),
      stamp: 3,
    })
    const html = render(client, { initialFilter: filter })
    expect(html).toContain('No rows match the filter or search.')
    expect(html).toContain('Clear filter and search')
    expect(html).toContain('id equals “99”')
  })

  test('read-only and view states are visible; hooks add toolbar and row actions', () => {
    const ro = response({
      permissions: { readOnly: true, insert: false, update: false, delete: false },
    })
    expect(render(seeded(ro))).toContain('Read-only connection')
    const view = response({
      table: { ...model, kind: 'view' },
      identity: { kind: 'none', reason: 'view' },
    })
    expect(render(seeded(view))).toContain('View, read-only')
    const html = render(seeded(response()), {
      hooks: {
        toolbar: (s) => createElement('button', { type: 'button' }, `Insert in ${s.table}`),
        rowActions: ({ rowIndex }) =>
          createElement('button', { type: 'button' }, `Edit ${rowIndex}`),
        onOpenCell: () => {},
        decorateCell: (ctx, content) =>
          ctx.columnName === 'id' ? createElement('a', { href: `#${ctx.cell}` }, content) : content,
      },
    })
    expect(html).toContain('Insert in orders')
    expect(html).toContain('Edit 1')
    expect(html).toContain('data-rows-actions')
    expect(html).toContain('<a href="#1">1</a>')
    expect(html).toContain('aria-label="Open the full value of doc"')
  })

  test('before any data arrives the grid is a skeleton, not a table', () => {
    const client = seeded(response())
    client.clear()
    client.setQueryData(['rows', 'limits'], { ...DEFAULT_ROW_LIMITS, stateless: false })
    client.setQueryData(['rows', 'prefs', 'shop', 'orders'], { values: {}, stateless: false })
    const html = render(client)
    expect(html).not.toContain('role="grid"')
  })

  test('hidden columns from the saved layout are not drawn', () => {
    const html = render(
      seeded(response(), {
        'rows.columns': { order: [], hidden: ['doc', 'state'], widths: { name: 300 } },
      }),
    )
    expect(html).not.toContain('>doc<')
    expect(html).not.toContain('>state<')
    expect(html).toContain('width:300px')
  })
})

// ---- Source rules ---------------------------------------------------------------------------------------------

describe('source rules (FR-ROW-030, no values in browser storage)', () => {
  const files = [
    'rows-grid',
    'grid-table',
    'filter-builder',
    'search-bar',
    'column-menu',
    'pager',
    'selection',
    'rows-popover',
    'server-api-grid',
  ].map((n) => `src/components/rows/${n}.tsx`)

  test.each(files)('%s renders text only and touches no browser storage', (file) => {
    const source = readFileSync(file, 'utf8')
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
  })

  test('only the API module reaches server functions', () => {
    for (const file of files.filter((f) => !f.endsWith('server-api-grid.tsx'))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/rows\.functions|createServerFn/)
    }
  })
})
