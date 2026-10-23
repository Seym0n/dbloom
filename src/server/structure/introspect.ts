import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { NotFoundError, resolveTable } from '../db/schema'
import type { TargetPool } from '../db/target-pool'
import { capabilitiesFor, parseServerInfo } from './deps'
import {
  COLUMN_TYPES,
  REFERENTIAL_ACTIONS,
  type CheckDef,
  type ColumnDef,
  type ColumnDefault,
  type ColumnType,
  type FkDef,
  type IndexDef,
  type ServerInfo,
  type StructureLists,
  type TableDefinition,
} from './types'

type Row = RowDataPacket

const str = (v: unknown): string => String(v)
const optStr = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v)
const optNum = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v)

// ---- Server info and form lists --------------------------------------------------------------------

export async function readServerInfo(pool: TargetPool): Promise<ServerInfo> {
  const [rows] = await pool.query<Row[]>('SELECT VERSION() AS v, @@version_comment AS c')
  return parseServerInfo(str(rows[0]?.v), str(rows[0]?.c))
}

export async function readLists(pool: TargetPool): Promise<StructureLists> {
  const server = await readServerInfo(pool)
  const [engines] = await pool.query<Row[]>('SHOW ENGINES')
  const [charsets] = await pool.query<Row[]>(
    'SELECT CHARACTER_SET_NAME AS name, DEFAULT_COLLATE_NAME AS def FROM information_schema.CHARACTER_SETS ORDER BY CHARACTER_SET_NAME',
  )
  const [collations] = await pool.query<Row[]>(
    'SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS charset FROM information_schema.COLLATIONS ORDER BY COLLATION_NAME',
  )
  return {
    server,
    capabilities: capabilitiesFor(server),
    engines: engines
      .filter((r) => ['YES', 'DEFAULT'].includes(str(r.Support).toUpperCase()))
      .map((r) => str(r.Engine)),
    charsets: charsets.map((r) => ({ name: str(r.name), defaultCollation: str(r.def) })),
    collations: collations.map((r) => ({ name: str(r.name), charset: str(r.charset) })),
  }
}

// ---- Catalog reads ---------------------------------------------------------------------------------

export type Introspected = {
  def: TableDefinition
  /** Columns whose catalog type this model cannot express (e.g. geometry); alter is refused when set. */
  unsupportedColumns: string[]
}

const TYPE_ALIASES: Record<string, ColumnType> = {
  integer: 'int',
  bool: 'boolean',
  numeric: 'decimal',
  dec: 'decimal',
  fixed: 'decimal',
  real: 'double',
}

function mapType(dataType: string): ColumnType | undefined {
  const t = dataType.toLowerCase()
  const alias = TYPE_ALIASES[t] ?? t
  return (COLUMN_TYPES as readonly string[]).includes(alias) ? (alias as ColumnType) : undefined
}

/** Parses the quoted value list of `enum('a','b')` / `set(...)`. */
function parseValueList(columnType: string): string[] {
  const start = columnType.indexOf('(')
  const body = columnType.slice(start + 1, columnType.lastIndexOf(')'))
  const values: string[] = []
  let i = 0
  while (i < body.length) {
    if (body[i] !== "'") {
      i++
      continue
    }
    let value = ''
    i++
    while (i < body.length) {
      const ch = body[i]
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
    values.push(value)
  }
  return values
}

const CURRENT_TS = /^(current_timestamp|now|localtime|localtimestamp)(\((\d)?\))?$/i

function mapDefault(
  raw: unknown,
  extra: string,
  nullable: boolean,
  numeric: boolean,
  product: ServerInfo['product'],
): ColumnDefault {
  if (raw === null || raw === undefined) return nullable ? { kind: 'null' } : { kind: 'none' }
  const text = str(raw)
  const ts = CURRENT_TS.exec(text)
  if (ts) return { kind: 'currentTimestamp', ...(ts[3] ? { fsp: Number(ts[3]) } : {}) }
  if (product === 'mariadb') {
    // MariaDB prints literals quoted, NULL as the word NULL and expressions bare.
    if (text.toUpperCase() === 'NULL') return { kind: 'null' }
    if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
      return { kind: 'literal', value: text.slice(1, -1).replaceAll("''", "'") }
    }
    if (numeric && /^-?\d+(\.\d+)?$/.test(text)) return { kind: 'literal', value: Number(text) }
    return { kind: 'expression', sql: text }
  }
  if (/DEFAULT_GENERATED/i.test(extra)) return { kind: 'expression', sql: text }
  if (numeric && /^-?\d+(\.\d+)?$/.test(text)) return { kind: 'literal', value: Number(text) }
  return { kind: 'literal', value: text }
}

const NUMERIC_TYPES = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'decimal',
  'float',
  'double',
  'bit',
  'boolean',
])

function toAction(rule: unknown): FkDef['onDelete'] {
  const r = str(rule).toLowerCase()
  return (REFERENTIAL_ACTIONS as readonly string[]).includes(r)
    ? (r as FkDef['onDelete'])
    : 'restrict'
}

/**
 * Reads the definition of an existing table from the catalog. The names are verified first
 * (SEC-TGT-116, via resolveTable); every query is parameterised. Views are refused.
 */
export async function introspectTable(
  pool: TargetPool,
  db: string,
  table: string,
): Promise<Introspected> {
  const resolved = await resolveTable(pool, db, table)
  if (resolved.kind !== 'table') throw new NotFoundError()
  const server = await readServerInfo(pool)
  const p = server.product

  const [tableRows] = await pool.query<Row[]>(
    `SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT, AUTO_INCREMENT, ROW_FORMAT
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  )
  const t: Row = tableRows[0] ?? ({} as Row)
  const tableCollation = optStr(t.TABLE_COLLATION)
  let tableCharset: string | undefined
  if (tableCollation) {
    const [cs] = await pool.query<Row[]>(
      'SELECT CHARACTER_SET_NAME AS cs FROM information_schema.COLLATIONS WHERE COLLATION_NAME = ?',
      [tableCollation],
    )
    tableCharset = optStr(cs[0]?.cs)
  }

  const [colRows] = await pool.query<Row[]>(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION, NUMERIC_SCALE, CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, COLUMN_COMMENT,
            GENERATION_EXPRESSION
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
    [db, table],
  )
  const unsupportedColumns: string[] = []
  const columns: ColumnDef[] = colRows.map((r) => {
    const name = str(r.COLUMN_NAME)
    const dataType = str(r.DATA_TYPE).toLowerCase()
    const columnType = str(r.COLUMN_TYPE)
    let type = mapType(dataType)
    if (!type) {
      unsupportedColumns.push(name)
      type = 'text'
    }
    const extra = str(r.EXTRA)
    const nullable = str(r.IS_NULLABLE).toUpperCase() === 'YES'
    const col: ColumnDef = {
      name,
      type,
      nullable,
      default: mapDefault(r.COLUMN_DEFAULT, extra, nullable, NUMERIC_TYPES.has(type), p),
    }
    if (['char', 'varchar', 'binary', 'varbinary'].includes(type)) {
      const len = optNum(r.CHARACTER_MAXIMUM_LENGTH)
      if (len !== undefined) col.length = len
    } else if (type === 'bit') {
      const len = optNum(r.NUMERIC_PRECISION)
      if (len !== undefined) col.length = len
    } else if (type === 'decimal') {
      const prec = optNum(r.NUMERIC_PRECISION)
      const scale = optNum(r.NUMERIC_SCALE)
      if (prec !== undefined) col.precision = prec
      if (scale !== undefined) col.scale = scale
    } else if (type === 'enum' || type === 'set') {
      col.values = parseValueList(columnType)
    }
    if (/\bunsigned\b/i.test(columnType)) col.unsigned = true
    if (/auto_increment/i.test(extra)) col.autoIncrement = true
    if (/on update/i.test(extra)) col.onUpdateCurrentTimestamp = true
    if (/INVISIBLE/i.test(extra)) col.invisible = true
    const gen = /(VIRTUAL|STORED|PERSISTENT)\s+GENERATED/i.exec(extra)
    if (gen) {
      col.generated = {
        sql: str(r.GENERATION_EXPRESSION),
        storage: gen[1]!.toUpperCase() === 'VIRTUAL' ? 'virtual' : 'stored',
      }
      col.default = { kind: 'none' }
    }
    const cs = optStr(r.CHARACTER_SET_NAME)
    const co = optStr(r.COLLATION_NAME)
    if (cs && cs !== tableCharset) col.charset = cs
    if (co && co !== tableCollation) col.collation = co
    const comment = optStr(r.COLUMN_COMMENT)
    if (comment) col.comment = comment
    return col
  })

  // Indexes. SELECT * because IS_VISIBLE (MySQL) and IGNORED (MariaDB) exist on one product each.
  const [statRows] = await pool.query<Row[]>(
    `SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [db, table],
  )
  const indexMap = new Map<string, IndexDef>()
  for (const r of statRows) {
    const name = str(r.INDEX_NAME)
    if (r.COLUMN_NAME === null) continue // functional key part: outside the model
    let idx = indexMap.get(name)
    if (!idx) {
      const type = str(r.INDEX_TYPE).toUpperCase()
      const kind: IndexDef['kind'] =
        name === 'PRIMARY'
          ? 'primary'
          : type === 'FULLTEXT'
            ? 'fulltext'
            : Number(r.NON_UNIQUE) === 0
              ? 'unique'
              : 'index'
      idx = { kind, parts: [] }
      if (kind !== 'primary') idx.name = name
      if (str(r.IS_VISIBLE).toUpperCase() === 'NO' || str(r.IGNORED).toUpperCase() === 'YES') {
        idx.visibility = 'invisible'
      }
      indexMap.set(name, idx)
    }
    const length = optNum(r.SUB_PART)
    idx.parts.push({
      column: str(r.COLUMN_NAME),
      ...(length !== undefined ? { length } : {}),
      ...(optStr(r.COLLATION) === 'D' ? { order: 'desc' as const } : {}),
    })
  }

  // Foreign keys: KEY_COLUMN_USAGE for the column pairs, REFERENTIAL_CONSTRAINTS for the rules.
  const [fkCols] = await pool.query<Row[]>(
    `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [db, table],
  )
  const [fkRules] = await pool.query<Row[]>(
    `SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  )
  const rules = new Map(fkRules.map((r) => [str(r.CONSTRAINT_NAME), r]))
  const fkMap = new Map<string, FkDef>()
  for (const r of fkCols) {
    const name = str(r.CONSTRAINT_NAME)
    let fk = fkMap.get(name)
    if (!fk) {
      const rule = rules.get(name)
      fk = {
        name,
        columns: [],
        refDb: str(r.REFERENCED_TABLE_SCHEMA),
        refTable: str(r.REFERENCED_TABLE_NAME),
        refColumns: [],
        onDelete: toAction(rule?.DELETE_RULE),
        onUpdate: toAction(rule?.UPDATE_RULE),
      }
      fkMap.set(name, fk)
    }
    fk.columns.push(str(r.COLUMN_NAME))
    fk.refColumns.push(str(r.REFERENCED_COLUMN_NAME))
  }

  // CHECK constraints: names from TABLE_CONSTRAINTS (has the table), clauses from CHECK_CONSTRAINTS.
  const checks: CheckDef[] = []
  try {
    const [tc] = await pool.query<Row[]>(
      `SELECT * FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' ORDER BY CONSTRAINT_NAME`,
      [db, table],
    )
    if (tc.length > 0) {
      const [cc] = await pool.query<Row[]>(
        'SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?',
        [db],
      )
      const clauses = new Map(cc.map((r) => [str(r.CONSTRAINT_NAME), str(r.CHECK_CLAUSE)]))
      for (const r of tc) {
        const name = str(r.CONSTRAINT_NAME)
        const sql = clauses.get(name)
        if (sql === undefined) continue
        // MariaDB adds an implicit JSON_VALID check to every JSON column; it is not user-defined.
        if (/^json_valid\(/i.test(sql) && columns.some((c) => c.name === name)) continue
        checks.push({
          name,
          sql,
          ...(str(r.ENFORCED).toUpperCase() === 'NO' ? { enforced: false } : {}),
        })
      }
    }
  } catch (error) {
    const errno = (error as { errno?: number }).errno
    if (errno !== 1109 && errno !== 1146) throw error // catalog view absent: no CHECK support
  }

  const rowFormat = optStr(t.ROW_FORMAT)?.toLowerCase()
  const def: TableDefinition = {
    db,
    name: table,
    columns,
    indexes: [...indexMap.values()],
    fks: [...fkMap.values()],
    checks,
  }
  if (optStr(t.ENGINE)) def.engine = str(t.ENGINE)
  if (tableCharset) def.charset = tableCharset
  if (tableCollation) def.collation = tableCollation
  if (optStr(t.TABLE_COMMENT)) def.comment = str(t.TABLE_COMMENT)
  if (optNum(t.AUTO_INCREMENT) !== undefined) def.autoIncrement = Number(t.AUTO_INCREMENT)
  if (rowFormat && ['dynamic', 'compact', 'redundant', 'compressed'].includes(rowFormat)) {
    def.rowFormat = rowFormat as TableDefinition['rowFormat']
  }
  return { def, unsupportedColumns }
}

// ---- Fingerprint -----------------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonical(v)
    }
    return out
  }
  return value
}

/** Stable SHA-256 of the canonical definition. The AUTO_INCREMENT counter is left out (FR-STR-012). */
export function fingerprint(def: TableDefinition): string {
  const { autoIncrement, ...rest } = def
  void autoIncrement
  return createHash('sha256')
    .update(JSON.stringify(canonical(rest)))
    .digest('hex')
}

/** Introspects and fingerprints; the one place preview and execute both use. */
export async function fingerprintTable(
  pool: TargetPool,
  db: string,
  table: string,
): Promise<string> {
  return fingerprint((await introspectTable(pool, db, table)).def)
}

/** Existing databases are accepted by name only when the catalog holds them (SEC-TGT-116). */
export async function databaseExists(pool: TargetPool, db: string): Promise<boolean> {
  const [rows] = await pool.query<Row[]>(
    'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [db],
  )
  return rows.some((r) => str(r.name) === db)
}
