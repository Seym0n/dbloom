import { describe, expect, test } from 'vitest'
import { createNameHider } from '~/server/assistant/pii/names'
import { compileRules, mergeRules, parseRule, parseRuleList } from '~/server/assistant/pii/rules'
import { shapeForModel } from '~/server/assistant/pii/shape'
import { createTokenMap, labelOf } from '~/server/assistant/pii/tokens'

// SPEC/34 FR-AST-006 (markings), FR-AST-007 (tokens), FR-AST-010 (tokens in SQL), FR-AST-016 (hidden names).

describe('markings', () => {
  test('parse: three parts, wildcards, case folded; anything else is refused', () => {
    expect(parseRule('Shop.Customers.Email')).toEqual({ db: 'shop', table: 'customers', column: 'email' })
    expect(parseRule('*.*.email')).toEqual({ db: '*', table: '*', column: 'email' })
    expect(parseRule(' shop.customers.* ')).toEqual({ db: 'shop', table: 'customers', column: '*' })
    for (const bad of ['', 'email', 'a.b', 'a.b.c.d', 'a..c', 'a.b.', "a.b.c'", 'a.b.`c`', 'a b.c.d', 'a.b.c*', 'a.*b.c']) {
      expect(parseRule(bad), bad).toBeUndefined()
    }
  })

  test('list: skips and reports bad entries, drops duplicates', () => {
    const r = parseRuleList('a.b.c, A.B.C, nonsense, *.*.email, , x.y')
    expect(r.rules).toEqual([
      { db: 'a', table: 'b', column: 'c' },
      { db: '*', table: '*', column: 'email' },
    ])
    expect(r.errors).toEqual(['nonsense', 'x.y'])
    expect(parseRuleList(undefined)).toEqual({ rules: [], errors: [] })
  })

  test('merge is a union in first-seen order', () => {
    const a = parseRuleList('a.b.c').rules
    const b = parseRuleList('a.b.c, d.e.f').rules
    expect(mergeRules(a, b).map((r) => `${r.db}.${r.table}.${r.column}`)).toEqual(['a.b.c', 'd.e.f'])
  })

  test('matching: wildcard parts, case, unknown database matches any database', () => {
    const c = compileRules(parseRuleList('shop.customers.email, *.*.ssn, hr.*.*').rules)
    expect(c.count).toBe(3)
    expect(c.isPiiColumn('shop', 'customers', 'EMAIL')).toBe(true)
    expect(c.isPiiColumn('shop', 'customers', 'city')).toBe(false)
    expect(c.isPiiColumn('shop', 'orders', 'email')).toBe(false)
    expect(c.isPiiColumn('other', 'any', 'SSN')).toBe(true)
    expect(c.isPiiColumn('hr', 'staff', 'anything')).toBe(true)
    expect(c.isPiiColumn(undefined, 'customers', 'email')).toBe(true)
    expect(c.isPiiColumn(undefined, 'orders', 'email')).toBe(true) // hr.*.* could apply: an unknown database only marks more
    expect(c.tableMayHavePii('hr', 'staff')).toBe(true)
    expect(c.tableMayHavePii('shop', 'orders')).toBe(true) // the *.*.ssn marking could apply
  })
})

describe('token map', () => {
  test('same value, same token; other value, next number; per label group; epoch is random per map', () => {
    const m = createTokenMap('abcd')
    const a = m.tokenFor('email', 'anna@x.example')
    expect(a).toBe('<email:abcd:1>')
    expect(m.tokenFor('email', 'anna@x.example')).toBe(a)
    expect(m.tokenFor('email', 'ben@x.example')).toBe('<email:abcd:2>')
    expect(m.tokenFor('city', 'anna@x.example')).toBe('<city:abcd:1>')
    expect(m.valueOf(a)).toBe('anna@x.example')
    expect(m.isIssued(a)).toBe(true)
    expect(m.isIssued('<email:abcd:9>')).toBe(false)
    expect(m.isIssued('<email:zzzz:1>')).toBe(false)
    const epochs = new Set(Array.from({ length: 20 }, () => createTokenMap().epoch))
    expect(epochs.size).toBeGreaterThan(15)
    for (const e of epochs) expect(e).toMatch(/^[a-z0-9]{4}$/)
  })

  test('long and binary cells are tokenized by what they stand for', () => {
    const m = createTokenMap('abcd')
    const cut = { cut: 'aaaa', length: 900 }
    expect(m.tokenFor('note', cut)).toBe(m.tokenFor('note', { cut: 'aaaa', length: 900 }))
    expect(m.tokenFor('note', cut)).not.toBe(m.tokenFor('note', { cut: 'aaaa', length: 901 }))
    expect(m.tokenFor('blob', { binary: 'AAEC', size: 3 })).toMatch(/^<blob:abcd:\d+>$/)
  })

  test('label from a column name', () => {
    expect(labelOf('E-Mail Address')).toBe('e_mail_address')
    expect(labelOf('3rd')).toBe('c_3rd')
    expect(labelOf('')).toBe('pii')
    expect(labelOf('x'.repeat(80)).length).toBeLessThanOrEqual(32)
  })

  describe('tokens in SQL', () => {
    const m = createTokenMap('abcd')
    m.tokenFor('email', 'anna@x.example')
    m.tokenFor('name', "O'Brien")
    m.tokenFor('path', 'C:\\temp')
    m.tokenFor('line', 'a\nb')

    test('a whole literal is replaced by its value, quotes doubled', () => {
      expect(m.detokenizeSql("SELECT id FROM c WHERE email = '<email:abcd:1>'")).toEqual({
        ok: true,
        sql: "SELECT id FROM c WHERE email = 'anna@x.example'",
        substituted: 1,
      })
      expect(m.detokenizeSql("SELECT 1 WHERE n IN ('<name:abcd:1>', \"<email:abcd:1>\")")).toEqual({
        ok: true,
        sql: "SELECT 1 WHERE n IN ('O''Brien', \"anna@x.example\")",
        substituted: 2,
      })
    })

    test('text without tokens is returned as it was, comments and identifiers included', () => {
      const sql = "SELECT 'plain' /* <email:abcd:1> */ FROM `t` -- <email:abcd:1>"
      expect(m.detokenizeSql(sql)).toEqual({ ok: true, sql, substituted: 0 })
    })

    test('a token of another map or never issued is refused', () => {
      expect(m.detokenizeSql("SELECT '<email:zzzz:1>'")).toMatchObject({ ok: false, reason: 'token-unknown' })
      expect(m.detokenizeSql("SELECT '<email:abcd:7>'")).toMatchObject({ ok: false, reason: 'token-unknown' })
      expect(createTokenMap('qqqq').detokenizeSql("SELECT '<email:abcd:1>'")).toMatchObject({ ok: false, reason: 'token-unknown' })
    })

    test('a token inside a longer literal or an identifier is refused', () => {
      expect(m.detokenizeSql("SELECT 'x<email:abcd:1>'")).toMatchObject({ ok: false, reason: 'token-embedded' })
      expect(m.detokenizeSql("SELECT '%<email:abcd:1>%'")).toMatchObject({ ok: false, reason: 'token-embedded' })
      expect(m.detokenizeSql('SELECT `<email:abcd:1>` FROM t')).toMatchObject({ ok: false, reason: 'token-embedded' })
    })

    test('a value that would need backslash or control escapes is never put into SQL', () => {
      expect(m.detokenizeSql("SELECT '<path:abcd:1>'")).toMatchObject({ ok: false, reason: 'token-value-unsafe' })
      expect(m.detokenizeSql("SELECT '<line:abcd:1>'")).toMatchObject({ ok: false, reason: 'token-value-unsafe' })
    })

    test('an unterminated literal is refused, not guessed', () => {
      expect(m.detokenizeSql("SELECT '<email:abcd:1>")).toMatchObject({ ok: false, reason: 'unterminated' })
    })
  })

  test('reveal: issued tokens in model text become values, others stay', () => {
    const m = createTokenMap('abcd')
    m.tokenFor('name', 'Anna Meyer')
    expect(m.revealText('The biggest customer is <name:abcd:1> (and <name:abcd:2>, <name:zzzz:1>).')).toBe(
      'The biggest customer is Anna Meyer (and <name:abcd:2>, <name:zzzz:1>).',
    )
  })
})

describe('what goes to the model', () => {
  const cols = [
    { name: 'id', type: 'int' },
    { name: 'email', type: 'varchar' },
    { name: 'note', type: 'text' },
  ]
  const rows = [
    ['1', 'anna@x.example', { cut: 'long', length: 900 }],
    ['2', null, null],
    ['3', 'anna@x.example', { binary: 'AA', size: 9 }],
  ] as const

  test('PII cells become tokens, NULL stays NULL, clean cells pass as text', () => {
    const m = createTokenMap('abcd')
    const out = shapeForModel(
      [{ name: 'id', taint: 'clean' }, { name: 'email', taint: 'pii' }, { name: 'note', taint: 'clean' }],
      cols,
      rows.map((r) => [...r]),
      m,
      { maxRows: 50 },
    )
    if (out.mode !== 'rows') throw new Error(out.mode)
    expect(out.rows).toEqual([
      ['1', '<email:abcd:1>', 'long… (900 characters)'],
      ['2', null, null],
      ['3', '<email:abcd:1>', '[binary, 9 bytes]'],
    ])
    expect(out.columns.map((c) => c.anonymized)).toEqual([false, true, false])
    expect(JSON.stringify(out)).not.toContain('anna@x.example')
    expect(out.truncated).toBe(false)
  })

  test('rows beyond the cap are cut and said so', () => {
    const m = createTokenMap('abcd')
    const out = shapeForModel([{ name: 'id', taint: 'clean' }], [cols[0]!], [['1'], ['2'], ['3']], m, { maxRows: 2 })
    if (out.mode !== 'rows') throw new Error(out.mode)
    expect(out.rows).toHaveLength(2)
    expect(out.rowCount).toBe(3)
    expect(out.truncated).toBe(true)
  })

  test('an unknown origin, a different column count or no analysis gives metadata only, never a value', () => {
    const m = createTokenMap('abcd')
    const clean = cols.map((c) => ({ name: c.name, taint: 'clean' as const }))
    const unknown = [clean[0]!, { name: 'email', taint: 'unknown' as const }, clean[2]!]
    for (const [taints, reason] of [
      [unknown, 'unknown-origin'],
      [clean.slice(0, 2), 'column-mismatch'],
      [undefined, 'unanalysed'],
    ] as const) {
      const out = shapeForModel(taints, cols, rows.map((r) => [...r]), m, { maxRows: 50 })
      expect(out).toMatchObject({ mode: 'metadata', reason, rowCount: 3 })
      expect(JSON.stringify(out)).not.toContain('anna')
    }
  })
})

describe('hidden names', () => {
  const h = createNameHider([
    { db: 'shop', table: 'customers', column: 'email' },
    { db: 'shop', table: 'customers', column: 'Last Name' },
    { db: 'shop', table: 'staff', column: 'email' },
  ])

  test('aliases are stable and per column', () => {
    expect(h.aliasOf('shop', 'customers', 'email')).toBe('col_1')
    expect(h.aliasOf('SHOP', 'Customers', 'EMAIL')).toBe('col_1')
    expect(h.aliasOf('shop', 'customers', 'Last Name')).toBe('col_2')
    expect(h.aliasOf('shop', 'staff', 'email')).toBe('col_3')
    expect(h.aliasOf('shop', 'customers', 'city')).toBe('city') // not hidden
  })

  test('the model SQL gets the real quoted name back; strings, comments and other words stay', () => {
    expect(h.restoreSql("SELECT col_1, col_2, id FROM customers WHERE col_1 = 'col_1' /* col_2 */")).toBe(
      "SELECT `email`, `Last Name`, id FROM customers WHERE `email` = 'col_1' /* col_2 */",
    )
    expect(h.restoreSql('SELECT `col_3` FROM staff')).toBe('SELECT `email` FROM staff')
    expect(h.restoreSql('SELECT col_10, column_1 FROM t')).toBe('SELECT col_10, column_1 FROM t')
  })

  test('result column names are hidden the same way', () => {
    expect(h.hideResultName('email')).toBe('col_1')
    expect(h.hideResultName('last name')).toBe('col_2')
    expect(h.hideResultName('city')).toBe('city')
  })
})
