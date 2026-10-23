import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createConnection, type Connection } from 'mysql2/promise'
import { buildStatements, quoteLiteral } from '~/server/structure/builder'
import { capabilitiesFor, parseServerInfo } from '~/server/structure/capabilities'
import {
  previewInput,
  type BuildContext,
  type PreviewInput,
  type TableDefinition,
} from '~/server/structure/types'

const servers = [
  { name: 'MySQL 8.4', port: 33064, product: 'mysql' },
  { name: 'MariaDB 10.11', port: 33061, product: 'mariadb' },
] as const

const DB = 'structure_a_scratch'
const input = (x: unknown): PreviewInput => previewInput.parse(x)

describe.each(servers)('structure builder against $name', ({ port, product }) => {
  let conn: Connection
  let ctx: BuildContext

  /** Builds the plan and EXECUTES every statement, one query each (no multipleStatements). */
  async function run(i: unknown, current?: TableDefinition) {
    const plan = buildStatements(input(i), { ...ctx, ...(current ? { current } : {}) })
    for (const s of plan.statements) await conn.query(s.sql)
    return plan
  }
  const rows = async (sql: string, params: unknown[] = []) =>
    (await conn.query(sql, params))[0] as Record<string, unknown>[]
  const works = async (sql: string) => {
    try {
      await conn.query(sql)
      return true
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_PARSE_ERROR') return false
      throw e
    }
  }

  beforeAll(async () => {
    conn = await createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      charset: 'utf8mb4',
    })
    await conn.query(`DROP DATABASE IF EXISTS ${DB}`)
    await conn.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    const [r] = await rows('SELECT VERSION() AS v, @@version_comment AS c')
    const server = parseServerInfo(String(r!.v), String(r!.c))
    ctx = { server, capabilities: capabilitiesFor(server) }
  })
  afterAll(async () => {
    await conn?.query(`DROP DATABASE IF EXISTS ${DB}`)
    await conn?.query(`DROP DATABASE IF EXISTS ${DB}_x`)
    await conn?.end()
  })

  test('the probe maps to the expected product', () => {
    expect(ctx.server.product).toBe(product)
  })

  test('capability table matches the experiments on this server', async () => {
    const t = `${DB}.cap_probe`
    await conn.query(`DROP TABLE IF EXISTS ${t}`)
    await conn.query(`CREATE TABLE ${t} (id INT PRIMARY KEY, a INT, b INT, KEY ia (a))`)
    const caps = ctx.capabilities
    expect(await works(`ALTER TABLE ${t} RENAME COLUMN a TO a2`)).toBe(caps['rename-column'])
    expect(await works(`ALTER TABLE ${t} ALTER INDEX ia INVISIBLE`)).toBe(product === 'mysql')
    expect(await works(`ALTER TABLE ${t} ALTER INDEX ia IGNORED`)).toBe(product === 'mariadb')
    expect(caps['index-hide']).toBe(true)
    expect(await works(`ALTER TABLE ${t} ADD CONSTRAINT c1 CHECK (b >= 0)`)).toBe(
      caps['check-constraint'],
    )
    expect(await works(`ALTER TABLE ${t} ALTER CHECK c1 NOT ENFORCED`)).toBe(
      caps['check-enforcement-toggle'],
    )
    expect(await works(`ALTER TABLE ${t} DROP CONSTRAINT c1`)).toBe(true)
    expect(await works(`CREATE TABLE ${t}_g (x INT, y INT AS (x+1) PERSISTENT)`)).toBe(
      product === 'mariadb',
    )
    expect(await works(`CREATE TABLE ${t}_g2 (x INT, y INT AS (x+1) STORED)`)).toBe(
      caps['generated-column'],
    )
    expect(await works(`CREATE TABLE ${t}_i (id INT, x INT INVISIBLE)`)).toBe(
      caps['column-invisible'],
    )
    expect(await works(`CREATE TABLE ${t}_u (x UUID)`)).toBe(caps['type-uuid'])
    expect(await works(`CREATE TABLE ${t}_n (x INET6)`)).toBe(caps['type-inet6'])
    expect(await works(`CREATE TABLE ${t}_j (x JSON)`)).toBe(caps['type-json'])
    expect(await works(`CREATE TABLE ${t}_c (x TEXT COMPRESSED)`)).toBe(caps['compressed-column'])
    for (const s of ['', '_g', '_g2', '_i', '_u', '_n', '_j', '_c']) {
      await conn.query(`DROP TABLE IF EXISTS ${t}${s}`)
    }
  })

  test('create and drop a database', async () => {
    const created = await run({
      action: 'createDatabase',
      name: `${DB}_x`,
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })
    expect(created.statements[0]!.sql).toContain('CHARACTER SET utf8mb4')
    const [d] = await rows(
      'SELECT DEFAULT_COLLATION_NAME AS c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [`${DB}_x`],
    )
    expect(d!.c).toBe('utf8mb4_unicode_ci')
    await run({ action: 'dropDatabase', name: `${DB}_x` })
    expect(
      await rows('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [`${DB}_x`]),
    ).toHaveLength(0)
  })

  const parent = () => {
    const columns: Record<string, unknown>[] = [
      { name: 'id', type: 'bigint', unsigned: true, nullable: false, autoIncrement: true },
      { name: 'name', type: 'varchar', length: 100, nullable: false, comment: "it's a \\ name" },
      {
        name: 'price',
        type: 'decimal',
        precision: 10,
        scale: 2,
        nullable: false,
        default: { kind: 'literal', value: 0 },
      },
      { name: 'note', type: 'text', nullable: true },
      {
        name: 'status',
        type: 'enum',
        values: ['new', "o'ld", 'a\\b'],
        nullable: false,
        default: { kind: 'literal', value: 'new' },
      },
      { name: 'flags', type: 'set', values: ['x', 'y'], nullable: true },
      {
        name: 'created_at',
        type: 'timestamp',
        length: 3,
        nullable: false,
        default: { kind: 'currentTimestamp', fsp: 3 },
        onUpdateCurrentTimestamp: true,
      },
      { name: 'j', type: 'json', nullable: true },
      { name: 'b8', type: 'bit', length: 8, nullable: true },
      { name: 'flag', type: 'boolean', nullable: false, default: { kind: 'literal', value: 1 } },
      {
        name: 'total',
        type: 'decimal',
        precision: 12,
        scale: 2,
        nullable: true,
        generated: { sql: 'price * 2', storage: 'stored' },
      },
      {
        name: 'upper_name',
        type: 'varchar',
        length: 100,
        nullable: true,
        generated: { sql: 'UPPER(name)', storage: 'virtual' },
      },
      {
        name: 'expr_def',
        type: 'int',
        nullable: false,
        default: { kind: 'expression', sql: '(1 + 2) * 3' },
      },
      { name: 'hidden_c', type: 'int', nullable: true, invisible: true },
      {
        name: 'cs',
        type: 'varchar',
        length: 10,
        nullable: true,
        charset: 'latin1',
        collation: 'latin1_bin',
      },
      { name: 'dt', type: 'datetime', length: 6, nullable: true },
    ]
    if (ctx.capabilities['type-uuid']) columns.push({ name: 'u', type: 'uuid', nullable: true })
    if (ctx.capabilities['type-inet6']) columns.push({ name: 'ip', type: 'inet6', nullable: true })
    return {
      action: 'createTable',
      table: {
        db: DB,
        name: 'par',
        columns,
        indexes: [
          { kind: 'primary', parts: [{ column: 'id' }] },
          { kind: 'unique', name: 'uq_name', parts: [{ column: 'name' }] },
          {
            kind: 'index',
            name: 'ix_desc',
            parts: [{ column: 'name', length: 20, order: 'desc' }],
          },
          { kind: 'fulltext', name: 'ft_note', parts: [{ column: 'note' }] },
          {
            kind: 'index',
            name: 'ix_hidden',
            parts: [{ column: 'price' }],
            visibility: 'invisible',
          },
        ],
        checks: [{ name: 'chk_price', sql: 'price >= 0' }],
        engine: 'InnoDB',
        charset: 'utf8mb4',
        collation: 'utf8mb4_unicode_ci',
        comment: "parent 'table'",
        rowFormat: 'dynamic',
        autoIncrement: 10,
      },
    }
  }

  test('createTable with every column kind, keys, check and options', async () => {
    const def = parent()
    await run(def)
    const cols = await rows(
      `SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t, IS_NULLABLE AS nul, COLUMN_COMMENT AS c, EXTRA AS e
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'par' ORDER BY ORDINAL_POSITION`,
      [DB],
    )
    const by = Object.fromEntries(cols.map((c) => [c.n as string, c]))
    expect(by.id!.t).toMatch(/^bigint(\(20\))? unsigned$/)
    expect(String(by.id!.e)).toContain('auto_increment')
    expect(by.name!.c).toBe("it's a \\ name")
    expect(by.status!.t).toBe("enum('new','o''ld','a\\\\b')")
    expect(String(by.total!.e).toLowerCase()).toMatch(/stored generated|persistent/)
    expect(String(by.upper_name!.e).toLowerCase()).toMatch(/virtual generated/)
    expect(String(by.hidden_c!.e).toLowerCase()).toContain('invisible')
    expect(by.cs!.t).toBe('varchar(10)')
    const [t] = await rows(
      'SELECT TABLE_COMMENT AS c, AUTO_INCREMENT AS ai, TABLE_COLLATION AS col FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB, 'par'],
    )
    expect(t).toMatchObject({ c: "parent 'table'", col: 'utf8mb4_unicode_ci' })
    const idx = await rows(`SHOW INDEX FROM ${DB}.par`)
    expect(idx.map((r) => r.Key_name as string)).toEqual(
      expect.arrayContaining(['PRIMARY', 'uq_name', 'ix_desc', 'ft_note', 'ix_hidden']),
    )
    // the default expression and the literal defaults took effect
    await conn.query(`INSERT INTO ${DB}.par (name, note) VALUES ('first', 'hello world')`)
    const [row] = await rows(`SELECT status, expr_def, total, upper_name, flag FROM ${DB}.par`)
    expect(row).toMatchObject({ status: 'new', expr_def: 9, upper_name: 'FIRST', flag: 1 })
    expect(Number(row!.total)).toBe(0)
    // the hidden index state
    const hidden = idx.find((r) => r.Key_name === 'ix_hidden')!
    if (product === 'mysql') expect(hidden.Visible).toBe('NO')
    else expect(hidden.Ignored).toBe('YES')
    // the check works
    await expect(
      conn.query(`INSERT INTO ${DB}.par (name, price) VALUES ('neg', -1)`),
    ).rejects.toMatchObject({
      errno: product === 'mysql' ? 3819 : 4025,
    })
  })

  test('hostile table, column and index names', async () => {
    const evil = 'we`ird"; DROP TABLE x; -- ünï'
    const col = "col`1'"
    await run({
      action: 'createTable',
      table: {
        db: DB,
        name: evil,
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: col, type: 'varchar', length: 10, nullable: true, comment: evil },
        ],
        indexes: [
          { kind: 'primary', parts: [{ column: 'id' }] },
          { kind: 'index', name: evil, parts: [{ column: col }] },
        ],
        checks: [{ name: evil + '2', sql: `\`${col.replaceAll('`', '``')}\` <> 'x'` }],
      },
    })
    const t = await rows(
      'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [DB],
    )
    expect(t.map((x) => x.n)).toContain(evil)
    await run({ action: 'renameTable', db: DB, table: evil, newName: evil + 'b' })
    await run({
      action: 'alterTable',
      db: DB,
      table: evil + 'b',
      ops: [{ op: 'dropCheck', name: evil + '2' }],
    })
    await run({
      action: 'alterTable',
      db: DB,
      table: evil + 'b',
      ops: [
        { op: 'renameColumn', from: col, to: 'plain' },
        { op: 'dropIndex', name: evil },
      ],
    })
    await run({ action: 'dropTable', db: DB, table: evil + 'b' })
  })

  test('foreign keys: to another table and to itself, in one CREATE', async () => {
    await run({
      action: 'createTable',
      table: {
        db: DB,
        name: 'child',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'par_id', type: 'bigint', unsigned: true, nullable: true },
          { name: 'up', type: 'int', nullable: true },
        ],
        indexes: [{ kind: 'primary', parts: [{ column: 'id' }] }],
        fks: [
          {
            name: 'fk_par',
            columns: ['par_id'],
            refDb: DB,
            refTable: 'par',
            refColumns: ['id'],
            onDelete: 'set null',
            onUpdate: 'cascade',
          },
          { name: 'fk_self', columns: ['up'], refDb: DB, refTable: 'child', refColumns: ['id'] },
        ],
      },
    })
    const fks = await rows(
      'SELECT CONSTRAINT_NAME AS n, DELETE_RULE AS d, UPDATE_RULE AS u FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? ORDER BY 1',
      [DB, 'child'],
    )
    expect(fks).toEqual([
      { n: 'fk_par', d: 'SET NULL', u: 'CASCADE' },
      { n: 'fk_self', d: 'RESTRICT', u: 'RESTRICT' },
    ])
  })

  test('merged ALTER: add column + index + check + options in one statement', async () => {
    const plan = await run({
      action: 'alterTable',
      db: DB,
      table: 'par',
      ops: [
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
        { op: 'addColumn', after: null, column: { name: 'first_c', type: 'int', nullable: true } },
        {
          op: 'addIndex',
          index: { kind: 'unique', name: 'uq_email', parts: [{ column: 'email' }] },
        },
        { op: 'addCheck', check: { name: 'chk_email', sql: 'CHAR_LENGTH(email) > 3' } },
        { op: 'setOptions', options: { comment: 'altered' } },
      ],
    })
    expect(plan.statements).toHaveLength(1)
    const cols = await rows(
      'SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [DB, 'par'],
    )
    const names = cols.map((c) => c.n)
    expect(names[0]).toBe('first_c')
    expect(names.indexOf('email')).toBe(names.indexOf('name') + 1)
  })

  test('modify (widen), rename, move, visibility, options', async () => {
    const current = input(parent()) as Extract<PreviewInput, { action: 'createTable' }>
    const cur = current.table
    const widen = await run(
      {
        action: 'alterTable',
        db: DB,
        table: 'par',
        ops: [
          {
            op: 'modifyColumn',
            name: 'name',
            column: {
              name: 'name',
              type: 'varchar',
              length: 150,
              nullable: false,
              comment: 'wider',
            },
          },
        ],
      },
      cur,
    )
    expect(widen.statements[0]!.class).toBe('soft')
    await run({
      action: 'alterTable',
      db: DB,
      table: 'par',
      ops: [{ op: 'renameColumn', from: 'note', to: 'notes' }],
    })
    // rename + redefine in one CHANGE COLUMN, and FIRST/AFTER on modify
    await run(
      {
        action: 'alterTable',
        db: DB,
        table: 'par',
        ops: [
          {
            op: 'modifyColumn',
            name: 'j',
            after: 'name',
            column: { name: 'jj', type: 'json', nullable: true },
          },
        ],
      },
      cur,
    )
    const pos = await rows(
      'SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN (?, ?) ORDER BY ORDINAL_POSITION',
      [DB, 'par', 'name', 'jj'],
    )
    expect(pos.map((p) => p.n)).toEqual(['name', 'jj'])
    // visibility toggles both ways
    await run({
      action: 'alterTable',
      db: DB,
      table: 'par',
      ops: [{ op: 'setIndexVisibility', name: 'ix_hidden', visibility: 'visible' }],
    })
    let idx = await rows(`SHOW INDEX FROM ${DB}.par`)
    let hidden = idx.find((r) => r.Key_name === 'ix_hidden')!
    expect(product === 'mysql' ? hidden.Visible : hidden.Ignored).toBe(
      product === 'mysql' ? 'YES' : 'NO',
    )
    await run({
      action: 'alterTable',
      db: DB,
      table: 'par',
      ops: [{ op: 'setIndexVisibility', name: 'ix_hidden', visibility: 'invisible' }],
    })
    idx = await rows(`SHOW INDEX FROM ${DB}.par`)
    hidden = idx.find((r) => r.Key_name === 'ix_hidden')!
    expect(product === 'mysql' ? hidden.Visible : hidden.Ignored).toBe(
      product === 'mysql' ? 'NO' : 'YES',
    )
    await run({
      action: 'alterTable',
      db: DB,
      table: 'par',
      ops: [
        {
          op: 'setOptions',
          options: { engine: 'InnoDB', rowFormat: 'default', autoIncrement: 500, comment: "x'y" },
        },
      ],
    })
    const [t] = await rows(
      'SELECT TABLE_COMMENT AS c, ROW_FORMAT AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB, 'par'],
    )
    expect(t).toMatchObject({ c: "x'y", r: 'Dynamic' })
  })

  test('drops: index, check, foreign key, column, primary key', async () => {
    await run({
      action: 'alterTable',
      db: DB,
      table: 'par',
      ops: [
        { op: 'dropIndex', name: 'uq_email' },
        { op: 'dropCheck', name: 'chk_email' },
        { op: 'dropColumn', name: 'email' },
      ],
    })
    await run({
      action: 'alterTable',
      db: DB,
      table: 'child',
      ops: [{ op: 'dropFk', name: 'fk_par' }],
    })
    await run({
      action: 'createTable',
      table: {
        db: DB,
        name: 'pk_t',
        columns: [{ name: 'id', type: 'int', nullable: false }],
        indexes: [{ kind: 'primary', parts: [{ column: 'id' }] }],
      },
    })
    const dropPk = await run({
      action: 'alterTable',
      db: DB,
      table: 'pk_t',
      ops: [{ op: 'dropIndex', name: 'PRIMARY' }],
    })
    expect(dropPk.statements[0]!.class).toBe('hard')
    await run({
      action: 'alterTable',
      db: DB,
      table: 'pk_t',
      ops: [{ op: 'addIndex', index: { kind: 'primary', parts: [{ column: 'id' }] } }],
    })
    // NOT NULL / narrowing on a table, classes come from the current definition
    const cur: TableDefinition = {
      db: DB,
      name: 'pk_t',
      columns: [
        { name: 'v', type: 'varchar', length: 200, nullable: true, default: { kind: 'none' } },
      ],
      indexes: [],
      fks: [],
      checks: [],
    }
    await conn.query(`ALTER TABLE ${DB}.pk_t ADD COLUMN v varchar(200) NULL`)
    const narrow = await run(
      {
        action: 'alterTable',
        db: DB,
        table: 'pk_t',
        ops: [
          {
            op: 'modifyColumn',
            name: 'v',
            column: { name: 'v', type: 'varchar', length: 50, nullable: false },
          },
        ],
      },
      cur,
    )
    expect(narrow.statements[0]!.class).toBe('hard')
  })

  test('check enforcement toggle follows the capability', async () => {
    const i = {
      action: 'alterTable',
      db: DB,
      table: 'pk_t',
      ops: [{ op: 'addCheck', check: { name: 'chk_ne', sql: "v <> 'z'", enforced: false } }],
    }
    if (ctx.capabilities['check-enforcement-toggle']) {
      await run(i)
      const [c] = await rows(
        'SELECT ENFORCED AS e FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = ?',
        [DB, 'chk_ne'],
      )
      expect(c!.e).toBe('NO')
    } else {
      expect(() => buildStatements(input(i), ctx)).toThrow(/not supported/)
    }
  })

  test('rename, truncate and drop (with and without foreign key checks)', async () => {
    await run({ action: 'renameTable', db: DB, table: 'pk_t', newName: 'pk_renamed' })
    await conn.query(`INSERT INTO ${DB}.pk_renamed (id) VALUES (1)`).catch(() => undefined)
    await run({ action: 'truncateTable', db: DB, table: 'pk_renamed' })
    await run({ action: 'dropTable', db: DB, table: 'pk_renamed' })
    // child references par: a plain drop fails with the server's FK error, nothing changes
    await conn.query(
      `ALTER TABLE ${DB}.child ADD CONSTRAINT fk_par2 FOREIGN KEY (par_id) REFERENCES ${DB}.par (id)`,
    )
    await expect(run({ action: 'dropTable', db: DB, table: 'par' })).rejects.toMatchObject({
      errno: expect.any(Number),
    })
    await expect(run({ action: 'truncateTable', db: DB, table: 'par' })).rejects.toBeDefined()
    // with the option: the three statements run on this one connection and the variable is back at 1
    const plan = await run({ action: 'dropTable', db: DB, table: 'par', ignoreForeignKeys: true })
    expect(plan.statements).toHaveLength(3)
    const [v] = await rows('SELECT @@foreign_key_checks AS v')
    expect(Number(v!.v)).toBe(1)
    await run({ action: 'truncateTable', db: DB, table: 'child', ignoreForeignKeys: true })
    await run({ action: 'dropTable', db: DB, table: 'child' })
  })

  test('quoteLiteral round-trips random strings through the server (default, comment, enum)', async () => {
    let seed = 987654321
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
      '-- ',
      '/*',
      '*/',
      '\n',
      '\r',
      '\t',
      ' ',
      'a',
      'Z',
      '7',
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
      '\\n',
      '\\0',
    ]
    const make = () => {
      const len = 1 + Math.floor(rnd() * 12)
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]
      return s
    }
    // Column comments are stored in the server's utf8mb3 metadata: 4-byte characters become '?'.
    const bmp = (s: string) => s.replace(/[𐀀-􏿿]/gu, 'x')
    const N = 40
    const strings = Array.from({ length: N }, make)
    const enumValues = [...new Set(strings.map((s) => s.trimEnd()).filter((s) => s !== ''))]
    const t = `${DB}.lit`
    await conn.query(`DROP TABLE IF EXISTS ${t}`)
    const cols = strings
      .map(
        (s, i) =>
          `c${i} VARCHAR(100) NULL DEFAULT ${quoteLiteral(s)} COMMENT ${quoteLiteral(bmp(s))}`,
      )
      .join(', ')
    await conn.query(`CREATE TABLE ${t} (id INT AUTO_INCREMENT PRIMARY KEY, ${cols})`)
    await conn.query(`INSERT INTO ${t} () VALUES ()`)
    const [row] = await rows(`SELECT * FROM ${t}`)
    const comments = await rows(
      'SELECT COLUMN_NAME AS n, COLUMN_COMMENT AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB, 'lit'],
    )
    for (const [i, s] of strings.entries()) {
      expect(row![`c${i}`], `default ${JSON.stringify(s)}`).toBe(s)
      expect(comments.find((c) => c.n === `c${i}`)!.c, `comment ${JSON.stringify(s)}`).toBe(bmp(s))
    }
    // enum: the first value is the implicit default and comes back verbatim
    for (const v of enumValues) {
      await conn.query(`DROP TABLE IF EXISTS ${DB}.en`)
      await conn.query(`CREATE TABLE ${DB}.en (e ENUM(${quoteLiteral(v)}, 'other') NOT NULL)`)
      await conn.query(`INSERT INTO ${DB}.en () VALUES ()`)
      const [e] = await rows(`SELECT e FROM ${DB}.en`)
      expect(e!.e, `enum ${JSON.stringify(v)}`).toBe(v)
    }
    await conn.query(`DROP TABLE IF EXISTS ${t}`)
    await conn.query(`DROP TABLE IF EXISTS ${DB}.en`)
  }, 30_000)

  test('the builder emits literals that round-trip in a real createTable', async () => {
    const bmp = (s: string) => s.replace(/[𐀀-􏿿]/gu, 'x')
    const value = "Robert'); DROP TABLE students;-- \\ \\' ü😀\n"
    await run({
      action: 'createTable',
      table: {
        db: DB,
        name: 'lit2',
        columns: [
          {
            name: 'v',
            type: 'varchar',
            length: 100,
            nullable: true,
            default: { kind: 'literal', value },
            comment: bmp(value),
          },
          { name: 'e', type: 'enum', values: [value.trimEnd()], nullable: false },
        ],
      },
    })
    await conn.query(`INSERT INTO ${DB}.lit2 () VALUES ()`)
    const [r] = await rows(`SELECT v, e FROM ${DB}.lit2`)
    expect(r).toEqual({ v: value, e: value.trimEnd() })
    const [c] = await rows(
      "SELECT COLUMN_COMMENT AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lit2' AND COLUMN_NAME = 'v'",
      [DB],
    )
    expect(c!.c).toBe(bmp(value))
  })
})
