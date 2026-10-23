import { describe, expect, test } from 'vitest'
import { buildStatements, quoteLiteral } from '~/server/structure/builder'
import { capabilitiesFor, parseServerInfo } from '~/server/structure/capabilities'
import { validateExpression } from '~/server/structure/expression'
import {
  BuildRefusal,
  previewInput,
  type BuildContext,
  type ColumnDef,
  type PreviewInput,
  type ServerInfo,
  type TableDefinition,
} from '~/server/structure/types'

const MYSQL: ServerInfo = { product: 'mysql', version: '8.4.13' }
const MARIA: ServerInfo = { product: 'mariadb', version: '10.11.19' }
const ctxFor = (server: ServerInfo, current?: TableDefinition): BuildContext => ({
  server,
  capabilities: capabilitiesFor(server),
  ...(current ? { current } : {}),
})
const mysql = ctxFor(MYSQL)
const maria = ctxFor(MARIA)

/** Parse through the real schema so defaults (e.g. column default none) are filled in like in production. */
const input = (x: unknown): PreviewInput => previewInput.parse(x)
const col = (name: string, extra: Record<string, unknown> = {}): ColumnDef =>
  (
    input({
      action: 'createTable',
      table: { db: 'd', name: 't', columns: [{ name, type: 'int', nullable: true, ...extra }] },
    }) as Extract<PreviewInput, { action: 'createTable' }>
  ).table.columns[0]!

const alter = (ops: unknown[], db = 'd', table = 't') =>
  input({ action: 'alterTable', db, table, ops })
const sqls = (i: PreviewInput, ctx: BuildContext) =>
  buildStatements(i, ctx).statements.map((s) => s.sql)
const one = (i: PreviewInput, ctx: BuildContext) => buildStatements(i, ctx).statements[0]!
const refusal = (fn: () => unknown): BuildRefusal => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(BuildRefusal)
    return e as BuildRefusal
  }
  throw new Error('expected a BuildRefusal')
}

function current(columns: ColumnDef[] = [col('id'), col('name')]): TableDefinition {
  return { db: 'd', name: 't', columns, indexes: [], fks: [], checks: [] }
}

// ---- quoteLiteral ----------------------------------------------------------------------------------

/** Reference reader for what quoteLiteral writes (MySQL default sql_mode): undoes '' and \\. */
function unquote(lit: string): string {
  expect(lit.startsWith("'") && lit.endsWith("'")).toBe(true)
  const body = lit.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === "'") {
      expect(body[i + 1]).toBe("'") // a lone quote would end the literal early
      out += "'"
      i++
    } else if (c === '\\') {
      expect(body[i + 1]).toBe('\\')
      out += '\\'
      i++
    } else out += c
  }
  return out
}

describe('quoteLiteral', () => {
  test('quotes strings and doubles quotes and backslashes', () => {
    expect(quoteLiteral('abc')).toBe("'abc'")
    expect(quoteLiteral("it's")).toBe("'it''s'")
    expect(quoteLiteral('a\\b')).toBe("'a\\\\b'")
    expect(quoteLiteral("\\'")).toBe("'\\\\'''")
    expect(quoteLiteral('')).toBe("''")
    expect(quoteLiteral('line1\nline2')).toBe("'line1\nline2'")
  })
  test('numbers are unquoted; non-finite numbers and NUL are rejected', () => {
    expect(quoteLiteral(5)).toBe('5')
    expect(quoteLiteral(-1.5)).toBe('-1.5')
    expect(() => quoteLiteral(NaN)).toThrow(BuildRefusal)
    expect(() => quoteLiteral(Infinity)).toThrow(BuildRefusal)
    expect(() => quoteLiteral('a\u0000b')).toThrow(BuildRefusal)
  })
  test('fuzz: the literal is a single token and decodes back to the input', () => {
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const alphabet = [
      "'",
      '\\',
      '"',
      '`',
      ';',
      '--',
      '/*',
      '\n',
      '\r',
      '\t',
      ' ',
      'a',
      'Z',
      '0',
      '%',
      '_',
      'ü',
      '日本',
      '😀',
      '\u001a',
      '\u0008',
      "\\'",
      "''",
      '\\\\',
    ]
    for (let n = 0; n < 2000; n++) {
      const len = Math.floor(rnd() * 20)
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]
      const lit = quoteLiteral(s)
      expect(unquote(lit)).toBe(s)
    }
  })
})

// ---- Expression validator --------------------------------------------------------------------------

describe('validateExpression', () => {
  const ok = [
    'price >= 0',
    'a + b * 2',
    "(a + b) / 2 > 1 AND c IS NOT NULL OR d = 'x'",
    'COALESCE(a, 0) + ABS(b)',
    "CONCAT(`first`, ' ', last)",
    'CASE WHEN a > 1 THEN 1 ELSE 0 END',
    'a IN (1, 2, 3)',
    'a NOT IN (1, 2)',
    "name LIKE 'a%'",
    'NOW()',
    'CURRENT_TIMESTAMP',
    'CURRENT_TIMESTAMP(3)',
    '-a',
    'a <=> b',
    "x = 'it''s'",
    "x = 'a\\'b'",
    '1.5e3',
    '`weird``name` > 0',
  ]
  test.each(ok)('accepts %s', (sql) => {
    expect(validateExpression(sql)).toEqual({ ok: true })
  })

  const bad: [string, RegExp][] = [
    ['a; DROP TABLE x', /semicolon/],
    ['a -- comment', /comment/],
    ['a # comment', /comment/],
    ['a /* c */ + 1', /comment/],
    ['a */ 1', /comment/],
    ['(SELECT 1)', /SELECT/],
    ['a IN (SELECT id FROM t)', /SELECT/],
    ['EXISTS (SELECT 1)', /EXISTS/],
    ["'unterminated", /single quote/],
    ['`unterminated', /backtick/],
    ['"double"', /double/],
    ['@x', /variable/],
    ['@@global.x', /variable/],
    ['a := 1', /not allowed/],
    ['SLEEP(5)', /function SLEEP/],
    ["LOAD_FILE('/etc/passwd')", /LOAD_FILE/],
    ['mysql.user', /not allowed/],
    ['a b', /unexpected identifier/],
    ['a +', /ends unexpectedly/],
    ['(a', /unbalanced/],
    ['a)', /unbalanced|unexpected/],
    ['a ? 1 : 2', /not allowed/],
    ['a | b', /not allowed/],
    ['1; SELECT 1', /semicolon/],
    ["1' OR '1'='1", /unbalanced|unexpected/],
    ['', /empty/],
    ['   ', /empty/],
    ['a\u0000', /NUL/],
    ['0x41', /malformed/],
    ['a INTO OUTFILE', /INTO/],
    ['UNION', /UNION/],
    ['x'.repeat(2001), /too long/],
  ]
  test.each(bad)('rejects %s', (sql, re) => {
    const r = validateExpression(sql)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(re)
  })

  test('with a column list, identifiers must be columns of the table', () => {
    expect(validateExpression('a + b', { columns: ['A', 'b'] })).toEqual({ ok: true })
    const r = validateExpression('a + secret', { columns: ['a'] })
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('unknown column') })
    expect(validateExpression('`a``b` > 1', { columns: ['a`b'] })).toEqual({ ok: true })
  })
})

// ---- Capabilities ----------------------------------------------------------------------------------

describe('capabilities', () => {
  test('parseServerInfo', () => {
    expect(parseServerInfo('8.4.13', 'MySQL Community Server - GPL')).toEqual({
      product: 'mysql',
      version: '8.4.13',
    })
    expect(parseServerInfo('10.11.19-MariaDB-ubu2204', 'mariadb.org binary distribution')).toEqual({
      product: 'mariadb',
      version: '10.11.19',
    })
    expect(parseServerInfo('5.5.5-10.11.19-MariaDB', '')).toEqual({
      product: 'mariadb',
      version: '10.11.19',
    })
    expect(parseServerInfo('8.4.0-log', 'Percona Server')).toEqual({
      product: 'mysql',
      version: '8.4.0',
    })
  })
  test('per product values and independence of the returned object', () => {
    const a = capabilitiesFor(MYSQL)
    const b = capabilitiesFor(MARIA)
    expect(a['check-enforcement-toggle']).toBe(true)
    expect(b['check-enforcement-toggle']).toBe(false)
    expect(a['type-uuid']).toBe(false)
    expect(b['type-uuid']).toBe(true)
    expect(b['compressed-column']).toBe(true)
    a['type-json'] = false
    expect(capabilitiesFor(MYSQL)['type-json']).toBe(true)
  })
})

// ---- Databases -------------------------------------------------------------------------------------

describe('databases', () => {
  test('create with charset and collation', () => {
    const s = one(
      input({
        action: 'createDatabase',
        name: 'new`db',
        charset: 'utf8mb4',
        collation: 'utf8mb4_bin',
      }),
      mysql,
    )
    expect(s).toMatchObject({
      sql: 'CREATE DATABASE `new``db` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      kind: 'createDatabase',
      class: 'none',
    })
  })
  test('charset and collation must be simple words', () => {
    refusal(() =>
      buildStatements(input({ action: 'createDatabase', name: 'x', charset: "a'; DROP" }), mysql),
    )
    refusal(() =>
      buildStatements(input({ action: 'createDatabase', name: 'x', collation: 'a b' }), mysql),
    )
  })
  test('drop is hard, and system schemas are refused', () => {
    const s = one(input({ action: 'dropDatabase', name: 'app' }), mysql)
    expect(s).toMatchObject({ sql: 'DROP DATABASE `app`', kind: 'dropDatabase', class: 'hard' })
    expect(s.effect).toBe('Drops database `app` with all its tables and data')
    for (const n of ['mysql', 'sys', 'Information_Schema', 'performance_schema']) {
      expect(
        refusal(() => buildStatements(input({ action: 'dropDatabase', name: n }), mysql)).code,
      ).toBe('system-schema')
    }
  })
})

// ---- createTable -----------------------------------------------------------------------------------

const customer = {
  action: 'createTable',
  table: {
    db: 'e2e_x',
    name: 'customer',
    columns: [
      { name: 'id', type: 'bigint', unsigned: true, nullable: false, autoIncrement: true },
      { name: 'name', type: 'varchar', length: 100, nullable: false },
      {
        name: 'created_at',
        type: 'timestamp',
        nullable: false,
        default: { kind: 'currentTimestamp' },
      },
    ],
    indexes: [{ kind: 'primary', parts: [{ column: 'id' }] }],
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  },
}

describe('createTable', () => {
  test('SCN-012 statement (snapshot, identical on both products)', () => {
    const expected = [
      'CREATE TABLE `e2e_x`.`customer` (',
      '  `id` bigint unsigned NOT NULL AUTO_INCREMENT,',
      '  `name` varchar(100) NOT NULL,',
      '  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    ].join('\n')
    for (const ctx of [mysql, maria]) {
      const plan = buildStatements(input(customer), ctx)
      expect(plan.statements).toHaveLength(1)
      expect(plan.statements[0]).toMatchObject({
        sql: expected,
        kind: 'createTable',
        class: 'none',
      })
      expect(plan.warnings).toEqual([])
    }
  })

  test('hostile names are quoted, never interpreted', () => {
    const evil = 'x`; DROP TABLE users; -- ü"\''
    const plan = buildStatements(
      input({
        action: 'createTable',
        table: {
          db: evil,
          name: evil,
          columns: [{ name: evil, type: 'int', nullable: true }],
          indexes: [{ name: evil, kind: 'index', parts: [{ column: evil }] }],
        },
      }),
      mysql,
    )
    const q = '`x``; DROP TABLE users; -- ü"\'`'
    expect(plan.statements[0]!.sql).toBe(
      `CREATE TABLE ${q}.${q} (\n  ${q} int NULL,\n  KEY ${q} (${q})\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    )
  })

  test('a 64 character name is fine; the zod schema rejects 65', () => {
    expect(() =>
      buildStatements(input({ action: 'dropTable', db: 'd', table: 'a'.repeat(64) }), mysql),
    ).not.toThrow()
    expect(() => input({ action: 'dropTable', db: 'd', table: 'a'.repeat(65) })).toThrow()
  })

  test('types: decimal, enum with hostile values, set, fsp, bit, boolean, json', () => {
    const s = one(
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [
            { name: 'a', type: 'decimal', precision: 10, scale: 2, nullable: false },
            { name: 'b', type: 'enum', values: ["a'b", 'c\\d', 'é'], nullable: false },
            { name: 'c', type: 'set', values: ['x', 'y'], nullable: true },
            { name: 'd', type: 'datetime', length: 3, nullable: true },
            { name: 'e', type: 'bit', length: 8, nullable: true },
            { name: 'f', type: 'boolean', nullable: false, default: { kind: 'literal', value: 1 } },
            { name: 'g', type: 'json', nullable: true },
            {
              name: 'h',
              type: 'text',
              nullable: true,
              charset: 'utf8mb4',
              collation: 'utf8mb4_bin',
            },
            {
              name: 'i',
              type: 'timestamp',
              length: 6,
              nullable: false,
              default: { kind: 'currentTimestamp', fsp: 6 },
              onUpdateCurrentTimestamp: true,
            },
          ],
        },
      }),
      mysql,
    )
    expect(s.sql).toContain('`a` decimal(10,2) NOT NULL')
    expect(s.sql).toContain("`b` enum('a''b','c\\\\d','é') NOT NULL")
    expect(s.sql).toContain("`c` set('x','y') NULL")
    expect(s.sql).toContain('`d` datetime(3) NULL')
    expect(s.sql).toContain('`e` bit(8) NULL')
    expect(s.sql).toContain('`f` boolean NOT NULL DEFAULT 1')
    expect(s.sql).toContain('`g` json NULL')
    expect(s.sql).toContain('`h` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL')
    expect(s.sql).toContain(
      '`i` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)',
    )
  })

  test('defaults: literal escaping, null, expression, comments', () => {
    const s = one(
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [
            {
              name: 'a',
              type: 'varchar',
              length: 20,
              nullable: false,
              default: { kind: 'literal', value: "x' OR '1'='1" },
              comment: "it's \\ ok",
            },
            { name: 'b', type: 'int', nullable: true, default: { kind: 'null' } },
            {
              name: 'c',
              type: 'int',
              nullable: false,
              default: { kind: 'expression', sql: 'a + 1' },
            },
          ],
        },
      }),
      mysql,
    )
    expect(s.sql).toContain("DEFAULT 'x'' OR ''1''=''1' COMMENT 'it''s \\\\ ok'")
    expect(s.sql).toContain('`b` int NULL DEFAULT NULL')
    expect(s.sql).toContain('`c` int NOT NULL DEFAULT (a + 1)')
  })

  test('keys: unique, fulltext, desc, prefix length, foreign key (also to itself), check', () => {
    const s = one(
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [
            { name: 'id', type: 'int', nullable: false },
            { name: 'parent', type: 'int', nullable: true },
            { name: 'title', type: 'varchar', length: 200, nullable: true },
            { name: 'price', type: 'int', nullable: true },
          ],
          indexes: [
            { kind: 'unique', name: 'uq', parts: [{ column: 'id', order: 'desc' }] },
            { kind: 'fulltext', name: 'ft', parts: [{ column: 'title' }] },
            { kind: 'primary', parts: [{ column: 'id' }] },
            { kind: 'index', name: 'ix', parts: [{ column: 'title', length: 20 }] },
          ],
          fks: [
            {
              name: 'fk_self',
              columns: ['parent'],
              refDb: 'd',
              refTable: 't',
              refColumns: ['id'],
              onDelete: 'set null',
              onUpdate: 'cascade',
            },
          ],
          checks: [{ name: 'chk_price', sql: 'price >= 0' }],
        },
      }),
      mysql,
    )
    expect(s.sql).toBe(
      [
        'CREATE TABLE `d`.`t` (',
        '  `id` int NOT NULL,',
        '  `parent` int NULL,',
        '  `title` varchar(200) NULL,',
        '  `price` int NULL,',
        '  PRIMARY KEY (`id`),', // primary key is moved first
        '  UNIQUE KEY `uq` (`id` DESC),',
        '  FULLTEXT KEY `ft` (`title`),',
        '  KEY `ix` (`title`(20)),',
        '  CONSTRAINT `fk_self` FOREIGN KEY (`parent`) REFERENCES `d`.`t` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,',
        '  CONSTRAINT `chk_price` CHECK (price >= 0)',
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
      ].join('\n'),
    )
  })

  test('create table spells out engine, charset and the server default collation (FR-TGT-243)', () => {
    const table = (extra: object = {}) =>
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [{ name: 'a', type: 'int', nullable: true }],
          ...extra,
        },
      })
    const tail = (i: PreviewInput, ctx: BuildContext) =>
      buildStatements(i, ctx).statements[0]!.sql.split('\n)')[1]
    expect(tail(table(), mysql)).toBe(
      ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    )
    expect(tail(table(), maria)).toBe(
      ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',
    )
    // the server's list wins over the built-in fallback
    expect(tail(table(), { ...mysql, charsetDefaults: { utf8mb4: 'utf8mb4_xx' } })).toContain(
      'COLLATE=utf8mb4_xx',
    )
    // a user choice is kept; a charset alone gets that charset's default collation
    expect(
      tail(table({ charset: 'latin1' }), {
        ...mysql,
        charsetDefaults: { latin1: 'latin1_swedish_ci' },
      }),
    ).toBe(' ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci')
    expect(tail(table({ engine: 'MyISAM', collation: 'utf8mb4_bin' }), mysql)).toBe(
      ' ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    )
  })

  test('hidden index uses the product keyword', () => {
    const def = {
      action: 'createTable',
      table: {
        db: 'd',
        name: 't',
        columns: [{ name: 'a', type: 'int', nullable: true }],
        indexes: [{ kind: 'index', name: 'ix', parts: [{ column: 'a' }], visibility: 'invisible' }],
      },
    }
    expect(one(input(def), mysql).sql).toContain('KEY `ix` (`a`) INVISIBLE')
    expect(one(input(def), maria).sql).toContain('KEY `ix` (`a`) IGNORED')
  })

  test('generated columns: STORED/VIRTUAL, validated expression, no default', () => {
    const base = (generated: unknown, extra = {}) =>
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [
            { name: 'x', type: 'int', nullable: true },
            { name: 'y', type: 'int', nullable: true, generated, ...extra },
          ],
        },
      })
    expect(one(base({ sql: 'x + 1', storage: 'stored' }), mysql).sql).toContain(
      '`y` int GENERATED ALWAYS AS (x + 1) STORED',
    )
    expect(one(base({ sql: 'x + 1', storage: 'virtual' }), maria).sql).toContain(
      '`y` int GENERATED ALWAYS AS (x + 1) VIRTUAL',
    )
    expect(
      one(base({ sql: 'x + 1', storage: 'stored' }, { nullable: false }), mysql).sql,
    ).toContain('`y` int GENERATED ALWAYS AS (x + 1) STORED NOT NULL')
    expect(
      refusal(() =>
        buildStatements(base({ sql: 'x + 1', storage: 'stored' }, { nullable: false }), maria),
      ).code,
    ).toBe('invalid')
    expect(
      refusal(() => buildStatements(base({ sql: '(SELECT 1)', storage: 'stored' }), mysql)).code,
    ).toBe('expression')
    expect(
      refusal(() => buildStatements(base({ sql: 'nope + 1', storage: 'stored' }), mysql)).message,
    ).toMatch(/unknown column/)
    expect(
      refusal(() =>
        buildStatements(
          base({ sql: 'x', storage: 'stored' }, { default: { kind: 'literal', value: 1 } }),
          mysql,
        ),
      ).code,
    ).toBe('invalid')
    expect(
      refusal(() =>
        buildStatements(base({ sql: 'x', storage: 'stored' }, { autoIncrement: true }), mysql),
      ).code,
    ).toBe('invalid')
  })

  test('invalid definitions are refused', () => {
    const t = (columns: unknown[], more: Record<string, unknown> = {}) =>
      input({ action: 'createTable', table: { db: 'd', name: 't', columns, ...more } })
    const a = { name: 'a', type: 'int', nullable: true }
    expect(refusal(() => buildStatements(t([a, { ...a, name: 'A' }]), mysql)).code).toBe('invalid')
    expect(
      refusal(() => buildStatements(t([{ name: 'a', type: 'varchar', nullable: true }]), mysql))
        .code,
    ).toBe('invalid')
    expect(
      refusal(() => buildStatements(t([{ name: 'a', type: 'enum', nullable: true }]), mysql)).code,
    ).toBe('invalid')
    expect(
      refusal(() =>
        buildStatements(t([{ ...a, unsigned: true, type: 'varchar', length: 3 }]), mysql),
      ).code,
    ).toBe('invalid')
    expect(refusal(() => buildStatements(t([{ ...a, charset: 'utf8mb4' }]), mysql)).code).toBe(
      'invalid',
    )
    expect(
      refusal(() =>
        buildStatements(
          t([a], { indexes: [{ kind: 'index', parts: [{ column: 'nope' }] }] }),
          mysql,
        ),
      ).code,
    ).toBe('invalid')
    expect(
      refusal(() =>
        buildStatements(
          t([a], {
            indexes: [
              { kind: 'primary', parts: [{ column: 'a' }] },
              { kind: 'primary', parts: [{ column: 'a' }] },
            ],
          }),
          mysql,
        ),
      ).code,
    ).toBe('invalid')
    expect(
      refusal(() =>
        buildStatements(
          t([a], { indexes: [{ kind: 'unique', name: 'primary', parts: [{ column: 'a' }] }] }),
          mysql,
        ),
      ).message,
    ).toMatch(/primary key must be PRIMARY/)
    expect(
      refusal(() =>
        buildStatements(
          t([a], { fks: [{ columns: ['a'], refDb: 'd', refTable: 'x', refColumns: ['a', 'b'] }] }),
          mysql,
        ),
      ).code,
    ).toBe('invalid')
    expect(
      refusal(() =>
        buildStatements(t([{ ...a, default: { kind: 'literal', value: 'a\u0000b' } }]), mysql),
      ).code,
    ).toBe('invalid')
    expect(refusal(() => buildStatements(t([a], { engine: 'InnoDB; DROP' }), mysql)).code).toBe(
      'invalid',
    )
  })

  test('system schema tables cannot be created', () => {
    expect(
      refusal(() =>
        buildStatements(
          input({
            action: 'createTable',
            table: {
              db: 'mysql',
              name: 't',
              columns: [{ name: 'a', type: 'int', nullable: true }],
            },
          }),
          mysql,
        ),
      ).code,
    ).toBe('system-schema')
  })
})

describe('capability refusals', () => {
  const colOf = (type: string) =>
    input({
      action: 'createTable',
      table: { db: 'd', name: 't', columns: [{ name: 'a', type, nullable: true }] },
    })
  test('uuid and inet6 only where the server has them', () => {
    expect(one(colOf('uuid'), maria).sql).toContain('`a` uuid NULL')
    expect(one(colOf('inet6'), maria).sql).toContain('`a` inet6 NULL')
    expect(refusal(() => buildStatements(colOf('uuid'), mysql)).code).toBe('capability')
    expect(refusal(() => buildStatements(colOf('inet6'), mysql)).code).toBe('capability')
  })
  test('with no capabilities everything optional is refused', () => {
    const none = {
      server: MYSQL,
      capabilities: Object.fromEntries(Object.keys(capabilitiesFor(MYSQL)).map((k) => [k, false])),
    } as BuildContext
    const checks = [
      colOf('json'),
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [
            { name: 'a', type: 'int', nullable: true, generated: { sql: '1', storage: 'stored' } },
          ],
        },
      }),
      input({
        action: 'createTable',
        table: {
          db: 'd',
          name: 't',
          columns: [{ name: 'a', type: 'int', nullable: true, invisible: true }],
        },
      }),
      alter([{ op: 'addCheck', check: { sql: 'a > 0' } }]),
      alter([{ op: 'setIndexVisibility', name: 'ix', visibility: 'invisible' }]),
      alter([{ op: 'dropCheck', name: 'c' }]),
    ]
    for (const c of checks) expect(refusal(() => buildStatements(c, none)).code).toBe('capability')
  })
})

// ---- alterTable ------------------------------------------------------------------------------------

describe('alterTable', () => {
  test('SCN-013: add column after, one statement, class none', () => {
    const plan = buildStatements(
      alter([
        {
          op: 'addColumn',
          after: 'name',
          column: {
            name: 'email',
            type: 'varchar',
            length: 255,
            nullable: true,
            comment: 'login mail',
          },
        },
      ]),
      mysql,
    )
    expect(plan.statements).toEqual([
      {
        sql: "ALTER TABLE `d`.`t` ADD COLUMN `email` varchar(255) NULL COMMENT 'login mail' AFTER `name`",
        kind: 'alterTable',
        class: 'none',
        effect: 'Adds column `email`',
      },
    ])
  })
  test('FIRST when after is null', () => {
    expect(
      one(
        alter([
          { op: 'addColumn', after: null, column: { name: 'a', type: 'int', nullable: true } },
        ]),
        mysql,
      ).sql,
    ).toBe('ALTER TABLE `d`.`t` ADD COLUMN `a` int NULL FIRST')
  })

  test('merges all operations on one table into one ALTER, class is the maximum', () => {
    const plan = buildStatements(
      alter([
        { op: 'addColumn', column: { name: 'n', type: 'int', nullable: true } },
        { op: 'addIndex', index: { name: 'ix', kind: 'index', parts: [{ column: 'n' }] } },
        { op: 'dropColumn', name: 'old' },
        { op: 'dropIndex', name: 'ix_old' },
        {
          op: 'addFk',
          fk: {
            name: 'fk',
            columns: ['n'],
            refDb: 'd',
            refTable: 'o',
            refColumns: ['id'],
            onDelete: 'cascade',
            onUpdate: 'restrict',
          },
        },
        { op: 'dropFk', name: 'fk_old' },
        { op: 'addCheck', check: { name: 'c1', sql: 'n > 0' } },
        { op: 'dropCheck', name: 'c0' },
        { op: 'setOptions', options: { comment: "it's", autoIncrement: 100 } },
      ]),
      mysql,
    )
    expect(plan.statements).toHaveLength(1)
    const s = plan.statements[0]!
    expect(s.class).toBe('hard')
    expect(s.sql).toBe(
      [
        'ALTER TABLE `d`.`t`',
        '  ADD COLUMN `n` int NULL,',
        '  ADD KEY `ix` (`n`),',
        '  DROP COLUMN `old`,',
        '  DROP INDEX `ix_old`,',
        '  ADD CONSTRAINT `fk` FOREIGN KEY (`n`) REFERENCES `d`.`o` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,',
        '  DROP FOREIGN KEY `fk_old`,',
        '  ADD CONSTRAINT `c1` CHECK (n > 0),',
        '  DROP CONSTRAINT `c0`,',
        "  AUTO_INCREMENT=100 COMMENT='it''s'",
      ].join('\n'),
    )
    expect(s.effect).toContain('Adds column `n`; ')
    expect(plan.warnings.map((w) => w.code)).toEqual(['data-loss'])
  })

  test('classes per operation', () => {
    const cls = (op: unknown, ctx = mysql) => one(alter([op]), ctx).class
    expect(cls({ op: 'addColumn', column: { name: 'a', type: 'int', nullable: false } })).toBe(
      'none',
    )
    expect(cls({ op: 'dropColumn', name: 'a' })).toBe('hard')
    expect(cls({ op: 'dropIndex', name: 'ix' })).toBe('soft')
    expect(cls({ op: 'dropIndex', name: 'PRIMARY' })).toBe('hard')
    expect(cls({ op: 'dropIndex', name: 'primary' })).toBe('hard')
    expect(cls({ op: 'dropFk', name: 'f' })).toBe('soft')
    expect(cls({ op: 'dropCheck', name: 'c' })).toBe('soft')
    expect(cls({ op: 'renameColumn', from: 'a', to: 'b' })).toBe('soft')
    expect(cls({ op: 'addIndex', index: { kind: 'index', parts: [{ column: 'a' }] } })).toBe('none')
    expect(cls({ op: 'setIndexVisibility', name: 'ix', visibility: 'visible' })).toBe('none')
    expect(cls({ op: 'setOptions', options: { comment: 'x' } })).toBe('none')
    expect(cls({ op: 'setOptions', options: { engine: 'InnoDB' } })).toBe('soft')
  })

  test('drop primary key', () => {
    const s = one(alter([{ op: 'dropIndex', name: 'PRIMARY' }]), mysql)
    expect(s.sql).toBe('ALTER TABLE `d`.`t` DROP PRIMARY KEY')
    expect(s.class).toBe('hard')
    expect(
      one(alter([{ op: 'addIndex', index: { kind: 'primary', parts: [{ column: 'id' }] } }]), mysql)
        .sql,
    ).toBe('ALTER TABLE `d`.`t` ADD PRIMARY KEY (`id`)')
  })

  test('index visibility per product, primary refused', () => {
    const op = { op: 'setIndexVisibility', name: 'ix`1', visibility: 'invisible' }
    expect(one(alter([op]), mysql).sql).toBe('ALTER TABLE `d`.`t` ALTER INDEX `ix``1` INVISIBLE')
    expect(one(alter([op]), maria).sql).toBe('ALTER TABLE `d`.`t` ALTER INDEX `ix``1` IGNORED')
    expect(one(alter([{ ...op, visibility: 'visible' }]), mysql).sql).toMatch(/ VISIBLE$/)
    expect(one(alter([{ ...op, visibility: 'visible' }]), maria).sql).toMatch(/ NOT IGNORED$/)
    expect(refusal(() => buildStatements(alter([{ ...op, name: 'PRIMARY' }]), mysql)).code).toBe(
      'invalid',
    )
  })

  test('check enforcement only where the toggle exists', () => {
    const ck = (enforced: boolean) =>
      alter([{ op: 'addCheck', check: { name: 'c', sql: 'a > 0', enforced } }])
    expect(one(ck(false), mysql).sql).toMatch(/CHECK \(a > 0\) NOT ENFORCED$/)
    expect(one(ck(true), mysql).sql).toMatch(/CHECK \(a > 0\)$/)
    expect(refusal(() => buildStatements(ck(false), maria)).code).toBe('capability')
    expect(one(ck(true), maria).sql).toMatch(/CHECK \(a > 0\)$/)
  })

  test('expressions are validated against the current columns', () => {
    const cur = current([col('price')])
    const ok = buildStatements(
      alter([{ op: 'addCheck', check: { sql: 'price >= 0' } }]),
      ctxFor(MYSQL, cur),
    )
    expect(ok.statements[0]!.sql).toContain('CHECK (price >= 0)')
    expect(
      refusal(() =>
        buildStatements(
          alter([{ op: 'addCheck', check: { sql: 'other > 0' } }]),
          ctxFor(MYSQL, cur),
        ),
      ).code,
    ).toBe('expression')
    expect(
      refusal(() =>
        buildStatements(alter([{ op: 'addCheck', check: { sql: '1); DROP TABLE t; --' } }]), mysql),
      ).code,
    ).toBe('expression')
  })

  test('index and fk columns must exist when the current table is known', () => {
    const cur = current([col('id')])
    expect(
      refusal(() =>
        buildStatements(
          alter([{ op: 'addIndex', index: { kind: 'index', parts: [{ column: 'zzz' }] } }]),
          ctxFor(MYSQL, cur),
        ),
      ).code,
    ).toBe('invalid')
  })

  test('rename column: RENAME COLUMN when the capability is there', () => {
    const op = { op: 'renameColumn', from: 'name', to: 'full_name' }
    expect(one(alter([op]), mysql).sql).toBe(
      'ALTER TABLE `d`.`t` RENAME COLUMN `name` TO `full_name`',
    )
    expect(one(alter([op]), maria).sql).toBe(
      'ALTER TABLE `d`.`t` RENAME COLUMN `name` TO `full_name`',
    )
    expect(refusal(() => buildStatements(alter([{ ...op, to: 'name' }]), mysql)).code).toBe(
      'invalid',
    )
  })

  test('rename column falls back to CHANGE COLUMN with the full definition', () => {
    const noRename: BuildContext = {
      server: MYSQL,
      capabilities: { ...capabilitiesFor(MYSQL), 'rename-column': false },
    }
    const op = { op: 'renameColumn', from: 'name', to: 'full_name' }
    expect(refusal(() => buildStatements(alter([op]), noRename)).code).toBe('missing-current')
    const cur = current([col('id'), col('name', { type: 'varchar', length: 50, nullable: false })])
    const s = one(alter([op]), { ...noRename, current: cur })
    expect(s.sql).toBe('ALTER TABLE `d`.`t` CHANGE COLUMN `name` `full_name` varchar(50) NOT NULL')
    expect(s.class).toBe('soft')
    expect(
      refusal(() =>
        buildStatements(alter([{ ...op, from: 'nope' }]), { ...noRename, current: cur }),
      ).code,
    ).toBe('invalid')
  })

  describe('modifyColumn classes (data loss analysis)', () => {
    const run = (
      before: Record<string, unknown>,
      after: Record<string, unknown>,
      nullable = true,
    ) => {
      const cur = current([col('a', { nullable, ...before })])
      return one(
        alter([
          { op: 'modifyColumn', name: 'a', column: { name: 'a', type: 'int', nullable, ...after } },
        ]),
        ctxFor(MYSQL, cur),
      )
    }
    test('widening is not hard', () => {
      expect(run({ type: 'int' }, { type: 'bigint' }).class).toBe('soft')
      expect(run({ type: 'varchar', length: 10 }, { type: 'varchar', length: 20 }).class).toBe(
        'soft',
      )
      expect(
        run(
          { type: 'decimal', precision: 10, scale: 2 },
          { type: 'decimal', precision: 12, scale: 2 },
        ).class,
      ).toBe('soft')
      expect(run({ type: 'float' }, { type: 'double' }).class).toBe('soft')
      expect(run({ type: 'varchar', length: 10 }, { type: 'text' }).class).toBe('soft')
      expect(run({ type: 'enum', values: ['a'] }, { type: 'enum', values: ['a', 'b'] }).class).toBe(
        'soft',
      )
      expect(run({ type: 'date' }, { type: 'datetime' }).class).toBe('soft')
      expect(run({ type: 'int', unsigned: true }, { type: 'bigint' }).class).toBe('soft')
    })
    test('only comment or default changes are none', () => {
      expect(run({ type: 'int' }, { type: 'int', comment: 'x' }).class).toBe('none')
      expect(
        run({ type: 'int' }, { type: 'int', default: { kind: 'literal', value: 3 } }).class,
      ).toBe('none')
    })
    test('narrowing and incompatible changes are hard', () => {
      expect(run({ type: 'bigint' }, { type: 'int' }).class).toBe('hard')
      expect(run({ type: 'varchar', length: 20 }, { type: 'varchar', length: 10 }).class).toBe(
        'hard',
      )
      expect(
        run(
          { type: 'decimal', precision: 10, scale: 2 },
          { type: 'decimal', precision: 10, scale: 4 },
        ).class,
      ).toBe('hard')
      expect(
        run(
          { type: 'decimal', precision: 10, scale: 2 },
          { type: 'decimal', precision: 8, scale: 2 },
        ).class,
      ).toBe('hard')
      expect(run({ type: 'double' }, { type: 'float' }).class).toBe('hard')
      expect(run({ type: 'int' }, { type: 'int', unsigned: true }).class).toBe('hard')
      expect(run({ type: 'int', unsigned: true }, { type: 'int' }).class).toBe('hard')
      expect(run({ type: 'text' }, { type: 'varchar', length: 100 }).class).toBe('hard')
      expect(run({ type: 'longtext' }, { type: 'text' }).class).toBe('hard')
      expect(
        run({ type: 'varchar', length: 100000 > 65535 ? 60000 : 1 }, { type: 'tinytext' }).class,
      ).toBe('hard')
      expect(run({ type: 'varchar', length: 10 }, { type: 'int' }).class).toBe('hard')
      expect(run({ type: 'enum', values: ['a', 'b'] }, { type: 'enum', values: ['a'] }).class).toBe(
        'hard',
      )
      expect(
        run({ type: 'enum', values: ['a', 'b'] }, { type: 'enum', values: ['b', 'a'] }).class,
      ).toBe('hard')
      expect(run({ type: 'datetime', length: 6 }, { type: 'datetime' }).class).toBe('hard')
      expect(run({ type: 'datetime' }, { type: 'timestamp' }).class).toBe('hard')
      expect(
        run(
          { type: 'varchar', length: 10 },
          { type: 'varchar', length: 10, collation: 'utf8mb4_bin' },
        ).class,
      ).toBe('hard')
    })
    test('making a column NOT NULL is hard; making it nullable is not', () => {
      const cur = current([col('a', { nullable: true })])
      const mod = (nullable: boolean) =>
        one(
          alter([{ op: 'modifyColumn', name: 'a', column: { name: 'a', type: 'int', nullable } }]),
          ctxFor(MYSQL, cur),
        )
      expect(mod(false).class).toBe('hard')
      const cur2 = current([col('a', { nullable: false })])
      expect(
        one(
          alter([
            { op: 'modifyColumn', name: 'a', column: { name: 'a', type: 'int', nullable: true } },
          ]),
          ctxFor(MYSQL, cur2),
        ).class,
      ).toBe('none')
    })
    test('without the current definition modify is treated as hard', () => {
      const s = one(
        alter([
          { op: 'modifyColumn', name: 'a', column: { name: 'a', type: 'int', nullable: true } },
        ]),
        mysql,
      )
      expect(s.class).toBe('hard')
      expect(s.effect).toMatch(/unknown/)
    })
    test('modify keeps position, rename inside modify uses CHANGE COLUMN', () => {
      const cur = current([col('a'), col('b')])
      expect(
        one(
          alter([
            {
              op: 'modifyColumn',
              name: 'a',
              after: 'b',
              column: { name: 'a', type: 'bigint', nullable: true },
            },
          ]),
          ctxFor(MYSQL, cur),
        ).sql,
      ).toBe('ALTER TABLE `d`.`t` MODIFY COLUMN `a` bigint NULL AFTER `b`')
      expect(
        one(
          alter([
            {
              op: 'modifyColumn',
              name: 'a',
              after: null,
              column: { name: 'z', type: 'int', nullable: true },
            },
          ]),
          ctxFor(MYSQL, cur),
        ).sql,
      ).toBe('ALTER TABLE `d`.`t` CHANGE COLUMN `a` `z` int NULL FIRST')
      expect(
        refusal(() =>
          buildStatements(
            alter([
              {
                op: 'modifyColumn',
                name: 'nope',
                column: { name: 'nope', type: 'int', nullable: true },
              },
            ]),
            ctxFor(MYSQL, cur),
          ),
        ).code,
      ).toBe('invalid')
    })
  })

  test('setOptions needs at least one option and checks words', () => {
    expect(
      refusal(() => buildStatements(alter([{ op: 'setOptions', options: {} }]), mysql)).code,
    ).toBe('invalid')
    expect(
      one(
        alter([
          {
            op: 'setOptions',
            options: {
              engine: 'InnoDB',
              charset: 'utf8mb4',
              collation: 'utf8mb4_bin',
              rowFormat: 'dynamic',
              comment: 'c',
            },
          },
        ]),
        mysql,
      ).sql,
    ).toBe(
      "ALTER TABLE `d`.`t` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC COMMENT='c'",
    )
    expect(
      refusal(() =>
        buildStatements(alter([{ op: 'setOptions', options: { charset: "x' y" } }]), mysql),
      ).code,
    ).toBe('invalid')
  })

  test('hostile names in alter', () => {
    const evil = 'e`vil"; --'
    const s = one(
      alter(
        [
          { op: 'dropColumn', name: evil },
          { op: 'dropIndex', name: evil },
        ],
        evil,
        evil,
      ),
      mysql,
    )
    const q = '`e``vil"; --`'
    expect(s.sql).toBe(`ALTER TABLE ${q}.${q}\n  DROP COLUMN ${q},\n  DROP INDEX ${q}`)
  })

  test('system schema is refused', () => {
    expect(
      refusal(() => buildStatements(alter([{ op: 'dropColumn', name: 'a' }], 'sys'), mysql)).code,
    ).toBe('system-schema')
  })
})

// ---- rename / truncate / drop ----------------------------------------------------------------------

describe('rename, truncate, drop', () => {
  test('rename table is soft', () => {
    const s = one(
      input({ action: 'renameTable', db: 'e2e_x', table: 'customer', newName: 'client' }),
      mysql,
    )
    expect(s).toEqual({
      sql: 'RENAME TABLE `e2e_x`.`customer` TO `e2e_x`.`client`',
      kind: 'renameTable',
      class: 'soft',
      effect: 'Renames `e2e_x`.`customer` to `e2e_x`.`client`',
    })
    const moved = buildStatements(
      input({ action: 'renameTable', db: 'a', table: 't', newName: 't2', newDb: 'b' }),
      maria,
    )
    expect(moved.statements[0]!.sql).toBe('RENAME TABLE `a`.`t` TO `b`.`t2`')
    expect(moved.warnings.map((w) => w.code)).toEqual(['cross-database-move'])
    expect(
      refusal(() =>
        buildStatements(input({ action: 'renameTable', db: 'a', table: 't', newName: 't' }), mysql),
      ).code,
    ).toBe('invalid')
  })

  test('truncate and drop table are hard', () => {
    expect(one(input({ action: 'truncateTable', db: 'd', table: 't' }), mysql)).toMatchObject({
      sql: 'TRUNCATE TABLE `d`.`t`',
      kind: 'truncateTable',
      class: 'hard',
    })
    expect(one(input({ action: 'dropTable', db: 'd', table: 't' }), mysql)).toMatchObject({
      sql: 'DROP TABLE `d`.`t`',
      kind: 'dropTable',
      class: 'hard',
    })
  })

  test('a view is dropped with DROP VIEW', () => {
    const st = one(input({ action: 'dropTable', db: 'd', table: 'v', view: true }), mysql)
    expect(st).toMatchObject({ sql: 'DROP VIEW `d`.`v`', kind: 'dropTable', class: 'hard' })
    expect(st.effect).toBe('Drops view `d`.`v` (its data is not affected)')
    expect(() =>
      buildStatements(
        input({ action: 'dropTable', db: 'd', table: 'v', view: true, ignoreForeignKeys: true }),
        mysql,
      ),
    ).toThrow()
  })

  test('ignoreForeignKeys wraps the statement', () => {
    for (const action of ['truncateTable', 'dropTable'] as const) {
      const plan = buildStatements(
        input({ action, db: 'd', table: 't', ignoreForeignKeys: true }),
        mysql,
      )
      expect(plan.statements.map((s) => s.sql)).toEqual([
        'SET SESSION foreign_key_checks=0',
        action === 'dropTable' ? 'DROP TABLE `d`.`t`' : 'TRUNCATE TABLE `d`.`t`',
        'SET SESSION foreign_key_checks=1',
      ])
      expect(plan.statements.map((s) => s.kind)).toEqual([
        'setForeignKeyChecks',
        action,
        'setForeignKeyChecks',
      ])
      expect(plan.statements[1]!.class).toBe('hard')
      expect(plan.warnings.map((w) => w.code).sort()).toEqual(['data-loss', 'ddl-not-atomic'])
    }
    expect(
      sqls(input({ action: 'dropTable', db: 'd', table: 't', ignoreForeignKeys: false }), mysql),
    ).toHaveLength(1)
  })

  test('system schemas are refused for truncate, drop, rename', () => {
    for (const i of [
      input({ action: 'truncateTable', db: 'mysql', table: 'user' }),
      input({ action: 'dropTable', db: 'sys', table: 'x' }),
      input({
        action: 'renameTable',
        db: 'd',
        table: 'x',
        newName: 'y',
        newDb: 'performance_schema',
      }),
    ]) {
      expect(refusal(() => buildStatements(i, mysql)).code).toBe('system-schema')
    }
  })

  test('every statement has a one-line effect', () => {
    const inputs: PreviewInput[] = [
      input({ action: 'createDatabase', name: 'x' }),
      input({ action: 'dropDatabase', name: 'x' }),
      input(customer),
      alter([{ op: 'dropColumn', name: 'note' }]),
      input({ action: 'renameTable', db: 'd', table: 'a', newName: 'b' }),
      input({ action: 'truncateTable', db: 'd', table: 'a', ignoreForeignKeys: true }),
      input({ action: 'dropTable', db: 'd', table: 'a' }),
    ]
    for (const i of inputs) {
      for (const s of buildStatements(i, mysql).statements) {
        expect(s.effect).toMatch(/^\S.*\S$/)
        expect(s.effect).not.toContain('\n')
      }
    }
    expect(one(alter([{ op: 'dropColumn', name: 'note' }]), mysql).effect).toBe(
      'Drops column `note` and all its data',
    )
  })
})
