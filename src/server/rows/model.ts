/**
 * Typed row model (FR-ROW-002, FR-ROW-004, spec 5.2): the catalog read of one table or view and the row
 * identity decision. Built from `information_schema` only, never from `SHOW CREATE TABLE` or by parsing SQL.
 *
 * `assembleRowTable` is pure (catalog rows in, `RowTable` out) so the product differences of spec 5.7 are unit
 * tested; `loadRowTable` runs the parameterised catalog queries. Names that come from the client are matched
 * against the catalog (per `lower_case_table_names`) and used as the catalog spells them (SEC-TGT-116).
 */
import type { RowDataPacket } from 'mysql2'
import { NotFoundError } from '../db/schema'
import type { TargetPool } from '../db/target-pool'
import { readServerInfo } from '../structure/introspect'
import type { Product } from '../structure/types'
import { usesDigest } from './codecs'
import type { FkInfo, Identity, RowColumn, RowTable, TypeKind } from './types'

type Row = RowDataPacket

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const optText = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v)
const optNum = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v)

// ---- Pure assembly ---------------------------------------------------------------------------------------------

export type RawColumn = {
  name: string
  ordinal: number
  dataType: string
  columnType: string
  isNullable: string
  columnDefault: string | null
  extra: string
  charLength: number | null
  numericPrecision: number | null
  numericScale: number | null
  datetimePrecision: number | null
  charset: string | null
  collation: string | null
  generationExpression: string | null
  comment: string
  srsId: number | null
}

export type RawStatistic = {
  indexName: string
  nonUnique: number
  seq: number
  /** null for a functional key part. */
  columnName: string | null
}

export type RawFkColumn = {
  constraint: string
  /** Schema and table of the side the foreign key is declared on. */
  schema: string
  table: string
  column: string
  refSchema: string
  refTable: string
  refColumn: string
  position: number
}

export type RawFkRule = {
  schema: string
  constraint: string
  table: string
  updateRule: string
  deleteRule: string
}

export type RawCatalog = {
  product: Product
  db: string
  table: string
  tableType: string
  engine: string | null
  tableRows: number | null
  columns: RawColumn[]
  statistics: RawStatistic[]
  outgoing: { columns: RawFkColumn[]; rules: RawFkRule[] }
  incoming: { columns: RawFkColumn[]; rules: RawFkRule[] }
  /** MariaDB: `json_valid(col)` CHECK clauses by constraint name (JSON is a LONGTEXT alias there). */
  checkClauses: { name: string; clause: string }[]
}

const KIND_BY_TYPE: Record<string, TypeKind> = {
  tinyint: 'int',
  smallint: 'int',
  mediumint: 'int',
  int: 'int',
  integer: 'int',
  bigint: 'int',
  decimal: 'decimal',
  numeric: 'decimal',
  float: 'float',
  double: 'float',
  real: 'float',
  bit: 'bit',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  timestamp: 'timestamp',
  year: 'year',
  char: 'char',
  varchar: 'char',
  tinytext: 'text',
  text: 'text',
  mediumtext: 'text',
  longtext: 'text',
  enum: 'enum',
  set: 'set',
  binary: 'binary',
  varbinary: 'binary',
  tinyblob: 'blob',
  blob: 'blob',
  mediumblob: 'blob',
  longblob: 'blob',
  json: 'json',
  geometry: 'geometry',
  point: 'geometry',
  linestring: 'geometry',
  polygon: 'geometry',
  multipoint: 'geometry',
  multilinestring: 'geometry',
  multipolygon: 'geometry',
  geometrycollection: 'geometry',
  uuid: 'uuid',
  inet6: 'inet6',
}

/** Quoted member list of `enum('a','b')` / `set(...)`, with `''` and backslash escapes. */
export function parseMembers(columnType: string): string[] {
  const body = columnType.slice(columnType.indexOf('(') + 1, columnType.lastIndexOf(')'))
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    if (body[i] !== "'") {
      i++
      continue
    }
    let value = ''
    i++
    while (i < body.length) {
      const ch = body[i]!
      if (ch === "'" && body[i + 1] === "'") {
        value += "'"
        i += 2
      } else if (ch === '\\' && i + 1 < body.length) {
        value += body[i + 1]
        i += 2
      } else if (ch === "'") {
        i++
        break
      } else {
        value += ch
        i++
      }
    }
    out.push(value)
  }
  return out
}

const JSON_VALID = /^json_valid\(`((?:[^`]|``)+)`\)$/i

/** Default of a column per product (spec 5.7): the two servers spell "no default" and expressions differently. */
export function decideDefault(
  raw: string | null,
  extra: string,
  nullable: boolean,
  product: Product,
): RowColumn['default'] {
  if (raw === null) return nullable ? { kind: 'null' } : { kind: 'none' }
  if (product === 'mysql') {
    if (/DEFAULT_GENERATED/i.test(extra)) return { kind: 'expression', text: raw }
    return { kind: 'literal', text: raw }
  }
  // MariaDB: strings quoted, `NULL` for a nullable column without default, expressions bare.
  if (raw.toUpperCase() === 'NULL') return { kind: 'null' }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return {
      kind: 'literal',
      text: raw.slice(1, -1).replaceAll("''", "'").replaceAll("\\'", "'").replaceAll('\\\\', '\\'),
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { kind: 'literal', text: raw }
  return { kind: 'expression', text: raw }
}

const TRANSACTIONAL = new Set(['innodb', 'xtradb', 'ndbcluster', 'ndb', 'tokudb', 'rocksdb'])

function assembleColumn(raw: RawColumn, product: Product, jsonColumns: Set<string>): RowColumn {
  const baseType = raw.dataType.toLowerCase()
  let kind: TypeKind = KIND_BY_TYPE[baseType] ?? 'unknown'
  if (product === 'mariadb' && baseType === 'longtext' && jsonColumns.has(raw.name)) kind = 'json'
  const nullable = raw.isNullable.toUpperCase() === 'YES'
  const extra = raw.extra
  const generated = /(VIRTUAL|STORED|PERSISTENT)\s+GENERATED/i.exec(extra)
  const onUpdate = /on update\s+(.+)$/i.exec(extra)
  const col: RowColumn = {
    name: raw.name,
    ordinal: raw.ordinal,
    kind,
    baseType,
    fullType: raw.columnType,
    nullable,
    default: generated
      ? { kind: 'none' }
      : decideDefault(raw.columnDefault, extra, nullable, product),
    autoIncrement: /auto_increment/i.test(extra),
    invisible: /\bINVISIBLE\b/i.test(extra),
    comment: raw.comment,
  }
  if (/\bunsigned\b/i.test(raw.columnType)) col.unsigned = true
  if (kind === 'char' || kind === 'binary' || kind === 'text' || kind === 'blob') {
    if (raw.charLength !== null) col.length = raw.charLength
  }
  if (kind === 'bit' && raw.numericPrecision !== null) col.length = raw.numericPrecision
  if (kind === 'decimal') {
    if (raw.numericPrecision !== null) col.precision = raw.numericPrecision
    if (raw.numericScale !== null) col.scale = raw.numericScale
  }
  if (
    (kind === 'time' || kind === 'datetime' || kind === 'timestamp') &&
    raw.datetimePrecision !== null
  ) {
    col.fsp = raw.datetimePrecision
  }
  if (kind === 'enum' || kind === 'set') col.members = parseMembers(raw.columnType)
  if (kind === 'geometry' && raw.srsId !== null) col.srid = raw.srsId
  if (generated) col.generated = generated[1]!.toUpperCase() === 'VIRTUAL' ? 'virtual' : 'stored'
  if (onUpdate) col.onUpdate = onUpdate[1]!
  if (raw.charset !== null) col.charset = raw.charset
  if (raw.collation !== null) col.collation = raw.collation
  return col
}

function groupFks(
  side: { columns: RawFkColumn[]; rules: RawFkRule[] },
  incoming: boolean,
): FkInfo[] {
  const rules = new Map<string, RawFkRule>(
    side.rules.map(
      (r) => [`${r.schema}\u0000${r.table}\u0000${r.constraint}`, r] as [string, RawFkRule],
    ),
  )
  const map = new Map<string, FkInfo>()
  for (const c of [...side.columns].sort((a, b) => a.position - b.position)) {
    const key = `${c.schema}\u0000${c.table}\u0000${c.constraint}`
    let fk = map.get(key)
    if (!fk) {
      const rule = rules.get(key)
      fk = {
        name: c.constraint,
        columns: [],
        // Incoming: `refDb`/`refTable` name the referencing table, so db, table and columns belong together.
        refDb: incoming ? c.schema : c.refSchema,
        refTable: incoming ? c.table : c.refTable,
        refColumns: [],
        onDelete: rule?.deleteRule ?? 'RESTRICT',
        onUpdate: rule?.updateRule ?? 'RESTRICT',
      }
      map.set(key, fk)
    }
    fk.columns.push(c.column)
    fk.refColumns.push(c.refColumn)
  }
  return [...map.values()]
}

/** Builds the typed model from catalog rows. Pure; the unit tests feed it hand-made MySQL and MariaDB rows. */
export function assembleRowTable(raw: RawCatalog): RowTable {
  const jsonColumns = new Set<string>()
  for (const c of raw.checkClauses) {
    const m = JSON_VALID.exec(c.clause.trim())
    if (m) jsonColumns.add(m[1]!.replaceAll('``', '`'))
  }
  const columns = [...raw.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => assembleColumn(c, raw.product, jsonColumns))
  const byLower = new Map(columns.map((c) => [c.name.toLowerCase(), c] as const))

  const indexes = new Map<string, RawStatistic[]>()
  for (const s of raw.statistics) {
    const list = indexes.get(s.indexName) ?? []
    list.push(s)
    indexes.set(s.indexName, list)
  }
  let primaryKey: string[] | undefined
  const uniqueKeys: RowTable['uniqueKeys'] = []
  for (const [name, parts] of indexes) {
    if (parts.some((p) => p.columnName === null)) continue // functional key part: not an identity
    const names = [...parts]
      .sort((a, b) => a.seq - b.seq)
      .map((p) => byLower.get(p.columnName!.toLowerCase())?.name ?? p.columnName!)
    if (name === 'PRIMARY') {
      primaryKey = names
    } else if (parts[0]!.nonUnique === 0) {
      uniqueKeys.push({
        name,
        columns: names,
        allNotNull: names.every((n) => byLower.get(n.toLowerCase())?.nullable === false),
      })
    }
  }

  const type = raw.tableType.toUpperCase()
  const kind: RowTable['kind'] =
    type === 'BASE TABLE' || type === 'SYSTEM VERSIONED' ? 'table' : 'view'
  const table: RowTable = {
    db: raw.db,
    table: raw.table,
    kind,
    transactional: raw.engine !== null && TRANSACTIONAL.has(raw.engine.toLowerCase()),
    columns,
    uniqueKeys,
    outgoing: groupFks(raw.outgoing, false),
    incoming: groupFks(raw.incoming, true),
    estimatedRows: raw.tableRows,
  }
  if (raw.engine !== null) table.engine = raw.engine
  if (primaryKey) table.primaryKey = primaryKey
  return table
}

// ---- Catalog queries ----------------------------------------------------------------------------------------------

/** Per pool: `@@lower_case_table_names` does not change while the server runs. */
const lowerCaseCache = new WeakMap<TargetPool, number>()

async function lowerCaseMode(pool: TargetPool): Promise<number> {
  const known = lowerCaseCache.get(pool)
  if (known !== undefined) return known
  const [rows] = await pool.execute<Row[]>('SELECT @@lower_case_table_names AS v')
  const v = Number(rows[0]?.v ?? 0)
  lowerCaseCache.set(pool, v)
  return v
}

const FK_COLUMN_SQL = `SELECT CONSTRAINT_NAME AS c, TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS col,
       REFERENCED_TABLE_SCHEMA AS rs, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rcol,
       ORDINAL_POSITION AS pos
  FROM information_schema.KEY_COLUMN_USAGE`

function fkColumns(rows: Row[]): RawFkColumn[] {
  return rows.map((r) => ({
    constraint: text(r.c),
    schema: text(r.s),
    table: text(r.t),
    column: text(r.col),
    refSchema: text(r.rs),
    refTable: text(r.rt),
    refColumn: text(r.rcol),
    position: Number(r.pos),
  }))
}

function fkRules(rows: Row[]): RawFkRule[] {
  return rows.map((r) => ({
    schema: text(r.s),
    constraint: text(r.c),
    table: text(r.t),
    updateRule: text(r.ur).toUpperCase(),
    deleteRule: text(r.dr).toUpperCase(),
  }))
}

/**
 * Reads the model of one table or view. Throws `NotFoundError` when the catalog has no such object. With
 * `lower_case_table_names` 1 or 2 the match ignores case and the model carries the catalog's spelling.
 */
export async function loadRowTable(pool: TargetPool, db: string, table: string): Promise<RowTable> {
  const lctn = await lowerCaseMode(pool)
  const [found] = await pool.execute<Row[]>(
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_TYPE AS ty, ENGINE AS e, TABLE_ROWS AS r
       FROM information_schema.TABLES
      WHERE LOWER(TABLE_SCHEMA) = LOWER(?) AND LOWER(TABLE_NAME) = LOWER(?)`,
    [db, table],
  )
  const hit = found.find((r) =>
    lctn === 0
      ? text(r.s) === db && text(r.t) === table
      : text(r.s).toLowerCase() === db.toLowerCase() &&
        text(r.t).toLowerCase() === table.toLowerCase(),
  )
  if (!hit) throw new NotFoundError()
  const schema = text(hit.s)
  const name = text(hit.t)
  const { product } = await readServerInfo(pool)

  const [cols] = await pool.execute<Row[]>(
    `SELECT COLUMN_NAME AS n, ORDINAL_POSITION AS o, DATA_TYPE AS dt, COLUMN_TYPE AS ct, IS_NULLABLE AS nl,
            COLUMN_DEFAULT AS d, EXTRA AS x, CHARACTER_MAXIMUM_LENGTH AS cl, NUMERIC_PRECISION AS np,
            NUMERIC_SCALE AS ns, DATETIME_PRECISION AS dp, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS co,
            GENERATION_EXPRESSION AS ge, COLUMN_COMMENT AS cm${product === 'mysql' ? ', SRS_ID AS srs' : ''}
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, name],
  )
  const [stats] = await pool.execute<Row[]>(
    `SELECT INDEX_NAME AS i, NON_UNIQUE AS nu, SEQ_IN_INDEX AS s, COLUMN_NAME AS c
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [schema, name],
  )
  const [outCols] = await pool.execute<Row[]>(
    `${FK_COLUMN_SQL} WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [schema, name],
  )
  const [outRules] = await pool.execute<Row[]>(
    `SELECT CONSTRAINT_SCHEMA AS s, CONSTRAINT_NAME AS c, TABLE_NAME AS t, UPDATE_RULE AS ur, DELETE_RULE AS dr
       FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, name],
  )
  const [inCols] = await pool.execute<Row[]>(
    `${FK_COLUMN_SQL} WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
      ORDER BY CONSTRAINT_SCHEMA, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [schema, name],
  )
  const [inRules] = await pool.execute<Row[]>(
    `SELECT CONSTRAINT_SCHEMA AS s, CONSTRAINT_NAME AS c, TABLE_NAME AS t, UPDATE_RULE AS ur, DELETE_RULE AS dr
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE UNIQUE_CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?`,
    [schema, name],
  )
  let checkClauses: RawCatalog['checkClauses'] = []
  if (product === 'mariadb') {
    const [checks] = await pool.execute<Row[]>(
      `SELECT CONSTRAINT_NAME AS n, CHECK_CLAUSE AS cl FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    )
    checkClauses = checks.map((r) => ({ name: text(r.n), clause: text(r.cl) }))
  }

  return assembleRowTable({
    product,
    db: schema,
    table: name,
    tableType: text(hit.ty),
    engine: optText(hit.e) ?? null,
    tableRows: optNum(hit.r) ?? null,
    columns: cols.map((r) => ({
      name: text(r.n),
      ordinal: Number(r.o),
      dataType: text(r.dt),
      columnType: text(r.ct),
      isNullable: text(r.nl),
      columnDefault: optText(r.d) ?? null,
      extra: text(r.x),
      charLength: optNum(r.cl) ?? null,
      numericPrecision: optNum(r.np) ?? null,
      numericScale: optNum(r.ns) ?? null,
      datetimePrecision: optNum(r.dp) ?? null,
      charset: optText(r.cs) ?? null,
      collation: optText(r.co) ?? null,
      generationExpression: optText(r.ge) ?? null,
      comment: text(r.cm),
      srsId: optNum(r.srs) ?? null,
    })),
    statistics: stats.map((r) => ({
      indexName: text(r.i),
      nonUnique: Number(r.nu),
      seq: Number(r.s),
      columnName: optText(r.c) ?? null,
    })),
    outgoing: { columns: fkColumns(outCols), rules: fkRules(outRules) },
    incoming: { columns: fkColumns(inCols), rules: fkRules(inRules) },
    checkClauses,
  })
}

/** Looks a column up by name; names are the catalog's own spelling (SEC-TGT-116). */
export function findColumn(table: RowTable, name: string): RowColumn | undefined {
  return table.columns.find((c) => c.name === name)
}

// ---- Row identity (FR-ROW-004, G1) ----------------------------------------------------------------------------------

export type IdentityOptions = {
  /** Columns the page query selected; absent means all of them. */
  selectedColumns?: string[]
}

/**
 * Primary key, else the first unique key whose columns are all NOT NULL, else `all-columns` (only for a base
 * table without float, JSON, geometry or large BLOB/TEXT columns and with every column selected), else none.
 * Views never have an identity. Key columns that are generated or invisible (MySQL GIPK `my_row_id`) count.
 */
export function identityFor(table: RowTable, options: IdentityOptions = {}): Identity {
  if (table.kind === 'view') return { kind: 'none', reason: 'view' }
  const byLower = new Map(table.columns.map((c) => [c.name.toLowerCase(), c] as const))
  const selected = options.selectedColumns
    ? new Set(options.selectedColumns.map((n) => n.toLowerCase()))
    : undefined
  const usable = (names: string[]): string[] | undefined => {
    const cols = names.map((n) => byLower.get(n.toLowerCase()))
    if (cols.some((c) => c === undefined || c.kind === 'unknown')) return undefined
    if (selected && cols.some((c) => !selected.has(c!.name.toLowerCase()))) return undefined
    return cols.map((c) => c!.name)
  }
  if (table.primaryKey && table.primaryKey.length > 0) {
    const cols = usable(table.primaryKey)
    if (cols) return { kind: 'primary', columns: cols }
  }
  for (const key of table.uniqueKeys) {
    if (!key.allNotNull) continue
    const cols = usable(key.columns)
    if (cols) return { kind: 'unique', columns: cols }
  }
  if (table.columns.some((c) => c.kind === 'unknown'))
    return { kind: 'none', reason: 'unknown-type' }
  if (table.columns.some((c) => usesDigest(c)))
    return { kind: 'none', reason: 'no-key-unsafe-columns' }
  if (selected && table.columns.some((c) => !selected.has(c.name.toLowerCase()))) {
    return { kind: 'none', reason: 'columns-not-selected' }
  }
  return { kind: 'all-columns', columns: table.columns.map((c) => c.name) }
}

// ---- Privileges (advisory, FR-ROW-022) --------------------------------------------------------------------------------

export type TablePrivileges = {
  select: boolean
  insert: boolean
  update: boolean
  delete: boolean
  /** Per column when column-level grants exist. */
  columns: Record<string, { select: boolean; insert: boolean; update: boolean }>
}

/**
 * Privileges of the current account on the table, from the `information_schema` privilege views (no
 * `SHOW GRANTS` parsing). `null` means unknown: the views are not readable, or a role is active and nothing was
 * found (role grants do not appear there on either product), so the controls stay enabled and the server decides.
 */
export async function readPrivileges(
  pool: TargetPool,
  table: RowTable,
): Promise<TablePrivileges | null> {
  try {
    const [who] = await pool.execute<Row[]>('SELECT CURRENT_USER() AS u, CURRENT_ROLE() AS r')
    const current = text(who[0]?.u)
    const at = current.lastIndexOf('@')
    const grantee = `'${current.slice(0, at)}'@'${current.slice(at + 1)}'`
    const roleActive = who[0]?.r !== null && who[0]?.r !== undefined && text(who[0]?.r) !== 'NONE'
    const types = new Set<string>()
    const add = (rows: Row[]) => rows.forEach((r) => types.add(text(r.p).toUpperCase()))
    const [g] = await pool.execute<Row[]>(
      'SELECT PRIVILEGE_TYPE AS p FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?',
      [grantee],
    )
    add(g)
    const [s] = await pool.execute<Row[]>(
      `SELECT PRIVILEGE_TYPE AS p FROM information_schema.SCHEMA_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ?`,
      [grantee, table.db],
    )
    add(s)
    const [t] = await pool.execute<Row[]>(
      `SELECT PRIVILEGE_TYPE AS p FROM information_schema.TABLE_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [grantee, table.db, table.table],
    )
    add(t)
    const [c] = await pool.execute<Row[]>(
      `SELECT PRIVILEGE_TYPE AS p, COLUMN_NAME AS c FROM information_schema.COLUMN_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [grantee, table.db, table.table],
    )
    const columns: TablePrivileges['columns'] = {}
    const has = (p: string) => types.has(p)
    for (const col of table.columns) {
      columns[col.name] = { select: has('SELECT'), insert: has('INSERT'), update: has('UPDATE') }
    }
    for (const r of c) {
      const entry = columns[text(r.c)]
      const p = text(r.p).toUpperCase()
      if (entry && (p === 'SELECT' || p === 'INSERT' || p === 'UPDATE')) {
        entry[p.toLowerCase() as 'select' | 'insert' | 'update'] = true
      }
    }
    const any = (k: 'select' | 'insert' | 'update') =>
      has(k.toUpperCase()) || Object.values(columns).some((e) => e[k])
    const found = types.size > 0 || c.length > 0
    if (!found && roleActive) return null
    return {
      select: any('select'),
      insert: any('insert'),
      update: any('update'),
      delete: has('DELETE'),
      columns,
    }
  } catch {
    return null
  }
}

/** Writes the advisory privileges into the model's columns. */
export function applyPrivileges(table: RowTable, p: TablePrivileges | null): RowTable {
  if (!p) return table
  return {
    ...table,
    columns: table.columns.map((c) => ({ ...c, privileges: p.columns[c.name] ?? c.privileges })),
  }
}
