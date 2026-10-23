/**
 * The one place DDL is produced (FR-STR-002, SEC-TGT-117). Pure and synchronous: no connection, no I/O.
 *
 * Identifiers go through `quoteIdent`; every other piece of user text is either a closed enum mapped
 * here, an integer, a simple word checked against `^[A-Za-z0-9_]+$`, a literal escaped by
 * `quoteLiteral`, or an expression accepted by `validateExpression`.
 */
import { quoteIdent as q } from '../db/identifiers'
import { validateExpression } from './expression'
import {
  BuildRefusal,
  type AlterOp,
  type BuildContext,
  type BuiltPlan,
  type CheckDef,
  type ColumnDef,
  type FkDef,
  type IndexDef,
  type PlanWarning,
  type PreviewInput,
  type Statement,
  type StatementClass,
  type StatementKind,
  type TableDefinition,
  type TableOptions,
} from './types'

// ---- Literals --------------------------------------------------------------------------------------

/**
 * Central escaping for DEFAULT literals, enum/set values and comments. Strings are single-quoted with
 * `'` and `\` doubled (valid in the default sql_mode; NO_BACKSLASH_ESCAPES is not supported and the
 * target pool does not enable it). NUL bytes and non-finite numbers are rejected. Numbers are emitted
 * unquoted.
 */
export function quoteLiteral(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BuildRefusal('invalid', 'Number literal is not finite')
    return String(value)
  }
  if (typeof value !== 'string')
    throw new BuildRefusal('invalid', 'Literal must be a string or number')
  if (value.includes('\u0000')) throw new BuildRefusal('invalid', 'Literal contains a NUL byte')
  return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'"
}

// ---- Small helpers ---------------------------------------------------------------------------------

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])
const SIMPLE_WORD = /^[A-Za-z0-9_]{1,64}$/

function invalid(message: string): never {
  throw new BuildRefusal('invalid', message)
}

function word(what: string, value: string): string {
  if (!SIMPLE_WORD.test(value)) invalid(`${what} must consist of letters, digits and underscores`)
  return value
}

function qt(db: string, table: string): string {
  return `${q(db)}.${q(table)}`
}

function guardSchema(db: string): void {
  if (SYSTEM_SCHEMAS.has(db.toLowerCase())) {
    throw new BuildRefusal('system-schema', `System schema ${db} cannot be changed`)
  }
}

function requireCap(
  ctx: BuildContext,
  key: keyof BuildContext['capabilities'],
  what: string,
): void {
  if (!ctx.capabilities[key]) {
    throw new BuildRefusal('capability', `${what} is not supported by this server`)
  }
}

const rank: Record<StatementClass, number> = { none: 0, soft: 1, hard: 2 }
function maxClass(a: StatementClass, b: StatementClass): StatementClass {
  return rank[b] > rank[a] ? b : a
}

function st(sql: string, kind: StatementKind, cls: StatementClass, effect: string): Statement {
  return { sql, kind, class: cls, effect }
}

function lc(s: string): string {
  return s.toLowerCase()
}

function expr(sql: string, columns: readonly string[] | undefined, what: string): string {
  const r = validateExpression(sql, columns ? { columns } : {})
  if (!r.ok) throw new BuildRefusal('expression', `${what}: ${r.reason}`)
  return sql.trim()
}

// ---- Column definition -----------------------------------------------------------------------------

const INT_TYPES = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'] as const
const NUMERIC_TYPES = new Set<string>([...INT_TYPES, 'decimal', 'float', 'double'])
const STRING_TYPES = new Set<string>([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
])
const TIME_TYPES = new Set<string>(['time', 'datetime', 'timestamp'])

function fsp(c: ColumnDef): string {
  if (c.length === undefined) return ''
  if (!Number.isInteger(c.length) || c.length < 0 || c.length > 6) {
    invalid(`Fractional seconds of column ${c.name} must be between 0 and 6`)
  }
  return `(${c.length})`
}

function lengthOf(c: ColumnDef, required: boolean, fallback?: number): string {
  const len = c.length ?? fallback
  if (len === undefined) {
    if (required) invalid(`Column ${c.name} needs a length`)
    return ''
  }
  return `(${len})`
}

function typeSql(c: ColumnDef, ctx: BuildContext): string {
  let t: string
  switch (c.type) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'bigint':
    case 'float':
    case 'double':
      t = c.type
      break
    case 'boolean':
      t = 'boolean'
      break
    case 'decimal':
      t =
        c.precision === undefined
          ? 'decimal'
          : `decimal(${c.precision}${c.scale === undefined ? '' : `,${c.scale}`})`
      break
    case 'bit':
      t = `bit${lengthOf(c, false)}`
      break
    case 'char':
      t = `char${lengthOf(c, false, 1)}`
      break
    case 'varchar':
      t = `varchar${lengthOf(c, true)}`
      break
    case 'binary':
      t = `binary${lengthOf(c, false, 1)}`
      break
    case 'varbinary':
      t = `varbinary${lengthOf(c, true)}`
      break
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
    case 'date':
    case 'year':
      t = c.type
      break
    case 'time':
    case 'datetime':
    case 'timestamp':
      t = c.type + fsp(c)
      break
    case 'enum':
    case 'set': {
      const values = c.values
      if (!values || values.length === 0) invalid(`Column ${c.name} needs at least one value`)
      if (values.length > 255) invalid(`Column ${c.name} has more than 255 values`)
      t = `${c.type}(${values.map((v) => quoteLiteral(v)).join(',')})`
      break
    }
    case 'json':
      requireCap(ctx, 'type-json', 'JSON')
      t = 'json'
      break
    case 'uuid':
      requireCap(ctx, 'type-uuid', 'UUID')
      t = 'uuid'
      break
    case 'inet6':
      requireCap(ctx, 'type-inet6', 'INET6')
      t = 'inet6'
      break
  }
  if (c.unsigned) {
    if (!NUMERIC_TYPES.has(c.type)) invalid(`Column ${c.name}: UNSIGNED needs a numeric type`)
    t += ' unsigned'
  }
  if (c.charset !== undefined || c.collation !== undefined) {
    if (!STRING_TYPES.has(c.type)) {
      invalid(`Column ${c.name}: character set and collation need a text type`)
    }
    if (c.charset !== undefined) t += ` CHARACTER SET ${word('Character set', c.charset)}`
    if (c.collation !== undefined) t += ` COLLATE ${word('Collation', c.collation)}`
  }
  return t
}

/** One column definition: `name type attributes`. `columns` feeds the expression validator. */
function columnSql(
  c: ColumnDef,
  ctx: BuildContext,
  columns: readonly string[] | undefined,
): string {
  const parts: string[] = [q(c.name), typeSql(c, ctx)]
  if (c.generated) {
    requireCap(ctx, 'generated-column', 'Generated columns')
    if (c.default.kind !== 'none') invalid(`Generated column ${c.name} cannot have a default`)
    if (c.autoIncrement) invalid(`Generated column ${c.name} cannot be AUTO_INCREMENT`)
    if (c.onUpdateCurrentTimestamp) invalid(`Generated column ${c.name} cannot have ON UPDATE`)
    const e = expr(c.generated.sql, columns, `Generated column ${c.name}`)
    // STORED is accepted by both products (MariaDB's PERSISTENT is an alias that MySQL rejects).
    parts.push(
      `GENERATED ALWAYS AS (${e}) ${c.generated.storage === 'stored' ? 'STORED' : 'VIRTUAL'}`,
    )
  }
  if (!c.generated) {
    parts.push(c.nullable ? 'NULL' : 'NOT NULL')
  } else if (!c.nullable) {
    // Verified: MariaDB 10.11 rejects NULL / NOT NULL on a generated column, MySQL 8.4 accepts them
    // only after the STORED/VIRTUAL keyword. Generated columns are nullable by default.
    if (ctx.server.product === 'mariadb') {
      invalid(`Generated column ${c.name} cannot be NOT NULL on this server`)
    }
    parts.push('NOT NULL')
  }
  if (c.invisible) {
    requireCap(ctx, 'column-invisible', 'Invisible columns')
    parts.push('INVISIBLE')
  }
  switch (c.default.kind) {
    case 'none':
      break
    case 'null':
      parts.push('DEFAULT NULL')
      break
    case 'literal':
      parts.push(`DEFAULT ${quoteLiteral(c.default.value)}`)
      break
    case 'currentTimestamp': {
      const f = c.default.fsp
      if (f !== undefined && (!Number.isInteger(f) || f < 0 || f > 6)) invalid('Invalid fsp')
      parts.push(`DEFAULT CURRENT_TIMESTAMP${f === undefined ? '' : `(${f})`}`)
      break
    }
    case 'expression':
      parts.push(`DEFAULT (${expr(c.default.sql, columns, `Default of ${c.name}`)})`)
      break
  }
  if (c.autoIncrement) parts.push('AUTO_INCREMENT')
  if (c.onUpdateCurrentTimestamp) {
    if (!TIME_TYPES.has(c.type)) invalid(`Column ${c.name}: ON UPDATE needs a time type`)
    parts.push(`ON UPDATE CURRENT_TIMESTAMP${fsp(c)}`)
  }
  if (c.comment !== undefined && c.comment !== '') parts.push(`COMMENT ${quoteLiteral(c.comment)}`)
  return parts.join(' ')
}

// ---- Keys, constraints, options --------------------------------------------------------------------

function isPrimaryName(name: string): boolean {
  return name.toUpperCase() === 'PRIMARY'
}

function hideWord(ctx: BuildContext, visibility: 'visible' | 'invisible'): string {
  // Dialect strategy: MySQL INVISIBLE/VISIBLE, MariaDB IGNORED/NOT IGNORED (verified, see capabilities.ts).
  if (ctx.server.product === 'mariadb')
    return visibility === 'invisible' ? 'IGNORED' : 'NOT IGNORED'
  return visibility === 'invisible' ? 'INVISIBLE' : 'VISIBLE'
}

function indexSql(ix: IndexDef, ctx: BuildContext, alter: boolean): string {
  if (ix.kind !== 'primary' && ix.name !== undefined && isPrimaryName(ix.name)) {
    invalid('The name of the primary key must be PRIMARY, and only a primary key may use it')
  }
  const parts = ix.parts
    .map(
      (p) =>
        q(p.column) +
        (p.length === undefined ? '' : `(${p.length})`) +
        (p.order === 'desc' ? ' DESC' : ''),
    )
    .join(', ')
  const name = ix.name === undefined ? '' : ` ${q(ix.name)}`
  let head: string
  switch (ix.kind) {
    case 'primary':
      head = 'PRIMARY KEY'
      if (ix.visibility === 'invisible') invalid('A primary key cannot be hidden')
      break
    case 'unique':
      head = `UNIQUE KEY${name}`
      break
    case 'fulltext':
      head = `FULLTEXT KEY${name}`
      break
    case 'index':
      head = `KEY${name}`
      break
  }
  let sql = `${head} (${parts})`
  if (ix.visibility === 'invisible') {
    requireCap(ctx, 'index-hide', 'Hiding an index')
    sql += ` ${hideWord(ctx, 'invisible')}`
  }
  return alter ? `ADD ${sql}` : sql
}

const ACTIONS = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  'set null': 'SET NULL',
  'no action': 'NO ACTION',
} as const

function fkSql(fk: FkDef): string {
  if (fk.columns.length !== fk.refColumns.length) {
    invalid('A foreign key needs as many referenced columns as local columns')
  }
  const onDelete = ACTIONS[fk.onDelete]
  const onUpdate = ACTIONS[fk.onUpdate]
  if (!onDelete || !onUpdate) invalid('Unknown referential action')
  return (
    (fk.name === undefined ? '' : `CONSTRAINT ${q(fk.name)} `) +
    `FOREIGN KEY (${fk.columns.map((c) => q(c)).join(', ')}) ` +
    `REFERENCES ${qt(fk.refDb, fk.refTable)} (${fk.refColumns.map((c) => q(c)).join(', ')}) ` +
    `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
  )
}

function checkSql(ck: CheckDef, ctx: BuildContext, columns: readonly string[] | undefined): string {
  requireCap(ctx, 'check-constraint', 'CHECK constraints')
  const e = expr(ck.sql, columns, 'CHECK')
  let sql = (ck.name === undefined ? '' : `CONSTRAINT ${q(ck.name)} `) + `CHECK (${e})`
  if (ck.enforced === false) {
    requireCap(ctx, 'check-enforcement-toggle', 'NOT ENFORCED')
    sql += ' NOT ENFORCED'
  }
  return sql
}

function optionsSql(o: TableOptions): string {
  const items: string[] = []
  if (o.engine !== undefined) items.push(`ENGINE=${word('Engine', o.engine)}`)
  if (o.charset !== undefined) items.push(`DEFAULT CHARSET=${word('Character set', o.charset)}`)
  if (o.collation !== undefined) items.push(`COLLATE=${word('Collation', o.collation)}`)
  if (o.rowFormat !== undefined) {
    const formats = {
      default: 'DEFAULT',
      dynamic: 'DYNAMIC',
      compact: 'COMPACT',
      redundant: 'REDUNDANT',
      compressed: 'COMPRESSED',
    } as const
    const f = formats[o.rowFormat]
    if (!f) invalid('Unknown row format')
    items.push(`ROW_FORMAT=${f}`)
  }
  if (o.autoIncrement !== undefined) {
    if (!Number.isSafeInteger(o.autoIncrement) || o.autoIncrement < 1)
      invalid('Invalid AUTO_INCREMENT')
    items.push(`AUTO_INCREMENT=${o.autoIncrement}`)
  }
  if (o.comment !== undefined) items.push(`COMMENT=${quoteLiteral(o.comment)}`)
  return items.join(' ')
}

// ---- Data-loss analysis for modifyColumn -----------------------------------------------------------

const INT_RANK: Record<string, number> = {
  boolean: 1,
  tinyint: 1,
  smallint: 2,
  mediumint: 3,
  int: 4,
  bigint: 5,
}
const TEXT_RANK: Record<string, number> = { tinytext: 1, text: 2, mediumtext: 3, longtext: 4 }
const BLOB_RANK: Record<string, number> = { tinyblob: 1, blob: 2, mediumblob: 3, longblob: 4 }
const TEXT_LIMIT: Record<number, number> = { 1: 255, 2: 65535, 3: 16777215, 4: 4294967295 }

/** True when changing `o` into `n` may lose or alter stored data (narrowing, incompatible type). */
function isLossy(o: ColumnDef, n: ColumnDef): boolean {
  const gen = (c: ColumnDef) => (c.generated ? `${c.generated.storage}:${c.generated.sql}` : '')
  if (gen(o) !== gen(n)) return true
  if ((o.charset ?? '') !== (n.charset ?? '') || (o.collation ?? '') !== (n.collation ?? '')) {
    // Changing from the default (unset) to an explicit value is also treated as lossy: the effective
    // set may differ and the server converts the data.
    return true
  }
  const ot = o.type
  const nt = n.type
  const ou = o.unsigned ?? false
  const nu = n.unsigned ?? false
  if (ot in INT_RANK && nt in INT_RANK) {
    const or = INT_RANK[ot]!
    const nr = INT_RANK[nt]!
    if (nr < or) return true
    if (!ou && nu) return true
    if (ou && !nu) return nr <= or
    return false
  }
  if (ot === 'decimal' && nt === 'decimal') {
    const op = o.precision ?? 10
    const os = o.scale ?? 0
    const np = n.precision ?? 10
    const ns = n.scale ?? 0
    if (np - ns < op - os || ns < os) return true
    return !ou && nu
  }
  if ((ot === 'float' || ot === 'double') && (nt === 'float' || nt === 'double')) {
    if (ot === 'double' && nt === 'float') return true
    return !ou && nu
  }
  if ((ot === 'char' || ot === 'varchar') && (nt === 'char' || nt === 'varchar')) {
    return (n.length ?? (nt === 'char' ? 1 : 0)) < (o.length ?? (ot === 'char' ? 1 : 0))
  }
  if ((ot === 'binary' || ot === 'varbinary') && (nt === 'binary' || nt === 'varbinary')) {
    return (n.length ?? (nt === 'binary' ? 1 : 0)) < (o.length ?? (ot === 'binary' ? 1 : 0))
  }
  if (ot in TEXT_RANK && nt in TEXT_RANK) return TEXT_RANK[nt]! < TEXT_RANK[ot]!
  if (ot in BLOB_RANK && nt in BLOB_RANK) return BLOB_RANK[nt]! < BLOB_RANK[ot]!
  if ((ot === 'char' || ot === 'varchar') && nt in TEXT_RANK) {
    return (o.length ?? 1) > TEXT_LIMIT[TEXT_RANK[nt]!]!
  }
  if ((ot === 'binary' || ot === 'varbinary') && nt in BLOB_RANK) {
    return (o.length ?? 1) > TEXT_LIMIT[BLOB_RANK[nt]!]!
  }
  if ((ot === 'enum' || ot === 'set') && ot === nt) {
    const ov = o.values ?? []
    const nv = n.values ?? []
    return !(nv.length >= ov.length && ov.every((v, i) => nv[i] === v))
  }
  if (ot === nt && TIME_TYPES.has(ot)) return (n.length ?? 0) < (o.length ?? 0)
  if (ot === 'date' && (nt === 'datetime' || nt === 'timestamp')) return false
  if (ot === 'bit' && nt === 'bit') return (n.length ?? 1) < (o.length ?? 1)
  if (ot === nt) return false // date, year, json, uuid, inet6
  return true // different families: data may not convert
}

function typeSignature(c: ColumnDef): string {
  return JSON.stringify([
    c.type,
    c.length,
    c.precision,
    c.scale,
    c.values,
    c.unsigned ?? false,
    c.charset,
    c.collation,
    c.generated,
  ])
}

function modifyClass(o: ColumnDef | undefined, n: ColumnDef): StatementClass {
  if (!o) return 'hard' // cannot tell without the current definition: be conservative
  if (isLossy(o, n)) return 'hard'
  if (o.nullable && !n.nullable) return 'hard' // existing NULLs would fail or be converted
  return typeSignature(o) === typeSignature(n) ? 'none' : 'soft'
}

// ---- createDatabase / dropDatabase -----------------------------------------------------------------

function buildCreateDatabase(
  input: Extract<PreviewInput, { action: 'createDatabase' }>,
): Statement[] {
  let sql = `CREATE DATABASE ${q(input.name)}`
  if (input.charset !== undefined) sql += ` CHARACTER SET ${word('Character set', input.charset)}`
  if (input.collation !== undefined) sql += ` COLLATE ${word('Collation', input.collation)}`
  return [st(sql, 'createDatabase', 'none', `Creates database \`${input.name}\``)]
}

function buildDropDatabase(input: Extract<PreviewInput, { action: 'dropDatabase' }>): Statement[] {
  guardSchema(input.name)
  return [
    st(
      `DROP DATABASE ${q(input.name)}`,
      'dropDatabase',
      'hard',
      `Drops database \`${input.name}\` with all its tables and data`,
    ),
  ]
}

// ---- createTable -----------------------------------------------------------------------------------

function checkNames(
  kind: string,
  names: readonly string[],
  columns: ReadonlySet<string>,
  table: string,
): void {
  for (const n of names) {
    if (!columns.has(lc(n))) invalid(`${kind} refers to unknown column ${n} of ${table}`)
  }
}

/** Product fallback when the caller did not pass the server's list (FR-TGT-243). */
const FALLBACK_UTF8MB4_COLLATION = { mysql: 'utf8mb4_0900_ai_ci', mariadb: 'utf8mb4_general_ci' }

/**
 * A new table always spells out engine, character set and collation, so the preview shows what the
 * server will really use (FR-TGT-243). Only the options the user left empty are filled.
 */
function withCreateDefaults(o: TableOptions, ctx: BuildContext): TableOptions {
  const charset =
    o.charset ?? (o.collation !== undefined ? o.collation.split('_')[0] : undefined) ?? 'utf8mb4'
  const collation =
    o.collation ??
    ctx.charsetDefaults?.[charset] ??
    (charset === 'utf8mb4' ? FALLBACK_UTF8MB4_COLLATION[ctx.server.product] : undefined)
  return {
    ...o,
    engine: o.engine ?? 'InnoDB',
    charset,
    ...(collation !== undefined ? { collation } : {}),
  }
}

function buildCreateTable(
  input: Extract<PreviewInput, { action: 'createTable' }>,
  ctx: BuildContext,
): Statement[] {
  const t: TableDefinition = input.table
  guardSchema(t.db)
  const colNames = t.columns.map((c) => c.name)
  const colSet = new Set(colNames.map(lc))
  if (colSet.size !== colNames.length) invalid('Duplicate column names')
  const lines: string[] = t.columns.map((c) => columnSql(c, ctx, colNames))

  const primaries = t.indexes.filter((i) => i.kind === 'primary')
  if (primaries.length > 1) invalid('A table can have only one primary key')
  const ordered = [...primaries, ...t.indexes.filter((i) => i.kind !== 'primary')]
  for (const ix of ordered) {
    checkNames(
      'Index',
      ix.parts.map((p) => p.column),
      colSet,
      t.name,
    )
    lines.push(indexSql(ix, ctx, false))
  }
  for (const fk of t.fks) {
    checkNames('Foreign key', fk.columns, colSet, t.name)
    lines.push(fkSql(fk))
  }
  for (const ck of t.checks) lines.push(checkSql(ck, ctx, colNames))

  const opts = optionsSql(withCreateDefaults(t, ctx))
  const sql =
    `CREATE TABLE ${qt(t.db, t.name)} (\n  ${lines.join(',\n  ')}\n)` + (opts ? ` ${opts}` : '')
  return [
    st(
      sql,
      'createTable',
      'none',
      `Creates table \`${t.db}\`.\`${t.name}\` with ${t.columns.length} column${t.columns.length === 1 ? '' : 's'}`,
    ),
  ]
}

// ---- alterTable ------------------------------------------------------------------------------------

type OpResult = { sql: string; cls: StatementClass; effect: string }

function position(after: string | null | undefined): string {
  if (after === undefined) return ''
  return after === null ? ' FIRST' : ` AFTER ${q(after)}`
}

function buildAlterTable(
  input: Extract<PreviewInput, { action: 'alterTable' }>,
  ctx: BuildContext,
): Statement[] {
  guardSchema(input.db)
  const cur = ctx.current
  const find = (name: string): ColumnDef | undefined =>
    cur?.columns.find((c) => lc(c.name) === lc(name))

  // Columns visible to expressions: the current ones plus everything the ops add or rename to.
  let columns: string[] | undefined
  if (cur) {
    const set = new Set(cur.columns.map((c) => c.name))
    for (const op of input.ops) {
      if (op.op === 'addColumn') set.add(op.column.name)
      else if (op.op === 'modifyColumn') set.add(op.column.name)
      else if (op.op === 'renameColumn') set.add(op.to)
    }
    columns = [...set]
  }
  const knownCols = columns ? new Set(columns.map(lc)) : undefined

  const results: OpResult[] = input.ops.map((op: AlterOp): OpResult => {
    switch (op.op) {
      case 'addColumn':
        return {
          sql: `ADD COLUMN ${columnSql(op.column, ctx, columns)}${position(op.after)}`,
          cls: 'none',
          effect: `Adds column \`${op.column.name}\``,
        }
      case 'modifyColumn': {
        const old = find(op.name)
        if (cur && !old) invalid(`Column ${op.name} does not exist`)
        const def = columnSql(op.column, ctx, columns)
        const renamed = op.name !== op.column.name
        return {
          sql:
            (renamed ? `CHANGE COLUMN ${q(op.name)} ` : 'MODIFY COLUMN ') +
            def +
            position(op.after),
          cls: modifyClass(old, op.column),
          effect:
            `Changes column \`${op.name}\`` +
            (renamed ? ` (renamed to \`${op.column.name}\`)` : '') +
            (old ? '' : ' (current definition unknown, treated as destructive)'),
        }
      }
      case 'renameColumn': {
        if (op.from === op.to) invalid('The new column name is the same')
        if (ctx.capabilities['rename-column']) {
          return {
            sql: `RENAME COLUMN ${q(op.from)} TO ${q(op.to)}`,
            cls: 'soft',
            effect: `Renames column \`${op.from}\` to \`${op.to}\``,
          }
        }
        if (!cur) {
          throw new BuildRefusal(
            'missing-current',
            'Renaming a column on this server needs the current table definition',
          )
        }
        const old = find(op.from)
        if (!old) invalid(`Column ${op.from} does not exist`)
        return {
          sql: `CHANGE COLUMN ${q(op.from)} ${columnSql({ ...old, name: op.to }, ctx, columns)}`,
          cls: 'soft',
          effect: `Renames column \`${op.from}\` to \`${op.to}\``,
        }
      }
      case 'dropColumn':
        return {
          sql: `DROP COLUMN ${q(op.name)}`,
          cls: 'hard',
          effect: `Drops column \`${op.name}\` and all its data`,
        }
      case 'addIndex': {
        if (knownCols) {
          checkNames(
            'Index',
            op.index.parts.map((p) => p.column),
            knownCols,
            input.table,
          )
        }
        return {
          sql: indexSql(op.index, ctx, true),
          cls: 'none',
          effect:
            op.index.kind === 'primary'
              ? 'Adds a primary key'
              : `Adds ${op.index.kind} index${op.index.name === undefined ? '' : ` \`${op.index.name}\``}`,
        }
      }
      case 'dropIndex':
        if (isPrimaryName(op.name)) {
          return {
            sql: 'DROP PRIMARY KEY',
            cls: 'hard',
            effect: 'Drops the primary key (rows lose their unique identity)',
          }
        }
        return {
          sql: `DROP INDEX ${q(op.name)}`,
          cls: 'soft',
          effect: `Drops index \`${op.name}\``,
        }
      case 'setIndexVisibility': {
        requireCap(ctx, 'index-hide', 'Hiding an index')
        if (isPrimaryName(op.name)) invalid('The primary key cannot be hidden')
        return {
          sql: `ALTER INDEX ${q(op.name)} ${hideWord(ctx, op.visibility)}`,
          cls: 'none',
          effect:
            op.visibility === 'invisible'
              ? `Hides index \`${op.name}\` from the optimizer`
              : `Makes index \`${op.name}\` visible to the optimizer`,
        }
      }
      case 'addFk': {
        if (knownCols) checkNames('Foreign key', op.fk.columns, knownCols, input.table)
        return {
          sql: `ADD ${fkSql(op.fk)}`,
          cls: 'none',
          effect: `Adds foreign key to \`${op.fk.refDb}\`.\`${op.fk.refTable}\``,
        }
      }
      case 'dropFk':
        return {
          sql: `DROP FOREIGN KEY ${q(op.name)}`,
          cls: 'soft',
          effect: `Drops foreign key \`${op.name}\``,
        }
      case 'addCheck':
        return {
          sql: `ADD ${checkSql(op.check, ctx, columns)}`,
          cls: 'none',
          effect: `Adds CHECK constraint${op.check.name === undefined ? '' : ` \`${op.check.name}\``}`,
        }
      case 'dropCheck':
        requireCap(ctx, 'check-constraint', 'CHECK constraints')
        // DROP CONSTRAINT works for CHECK on both products; DROP CHECK only on MySQL (verified).
        return {
          sql: `DROP CONSTRAINT ${q(op.name)}`,
          cls: 'soft',
          effect: `Drops CHECK constraint \`${op.name}\``,
        }
      case 'setOptions': {
        const sql = optionsSql(op.options)
        if (!sql) invalid('No table option given')
        const o = op.options
        return {
          sql,
          cls:
            o.engine !== undefined ||
            o.charset !== undefined ||
            o.collation !== undefined ||
            o.rowFormat !== undefined
              ? 'soft'
              : 'none',
          effect: 'Changes table options',
        }
      }
    }
  })

  const cls = results.reduce<StatementClass>((a, r) => maxClass(a, r.cls), 'none')
  const effect = results.map((r) => r.effect).join('; ')
  const sql =
    `ALTER TABLE ${qt(input.db, input.table)}` +
    (results.length === 1
      ? ` ${results[0]!.sql}`
      : `\n  ${results.map((r) => r.sql).join(',\n  ')}`)
  return [st(sql, 'alterTable', cls, effect)]
}

// ---- rename / truncate / drop ----------------------------------------------------------------------

function buildRenameTable(input: Extract<PreviewInput, { action: 'renameTable' }>): Statement[] {
  const newDb = input.newDb ?? input.db
  guardSchema(input.db)
  guardSchema(newDb)
  if (newDb === input.db && input.newName === input.table) invalid('The new table name is the same')
  return [
    st(
      `RENAME TABLE ${qt(input.db, input.table)} TO ${qt(newDb, input.newName)}`,
      'renameTable',
      'soft',
      `Renames \`${input.db}\`.\`${input.table}\` to \`${newDb}\`.\`${input.newName}\``,
    ),
  ]
}

function withFkChecksOff(main: Statement, ignore: boolean | undefined): Statement[] {
  if (!ignore) return [main]
  return [
    st(
      'SET SESSION foreign_key_checks=0',
      'setForeignKeyChecks',
      'hard',
      'Turns foreign key checks off for this connection until the next statement restores them',
    ),
    main,
    st(
      'SET SESSION foreign_key_checks=1',
      'setForeignKeyChecks',
      'none',
      'Turns foreign key checks back on',
    ),
  ]
}

function buildTruncate(input: Extract<PreviewInput, { action: 'truncateTable' }>): Statement[] {
  guardSchema(input.db)
  return withFkChecksOff(
    st(
      `TRUNCATE TABLE ${qt(input.db, input.table)}`,
      'truncateTable',
      'hard',
      `Deletes all rows of \`${input.db}\`.\`${input.table}\` and resets AUTO_INCREMENT`,
    ),
    input.ignoreForeignKeys,
  )
}

function buildDropTable(input: Extract<PreviewInput, { action: 'dropTable' }>): Statement[] {
  guardSchema(input.db)
  if (input.view) {
    if (input.ignoreForeignKeys) invalid('Foreign key checks do not apply to a view')
    return [
      st(
        `DROP VIEW ${qt(input.db, input.table)}`,
        'dropTable',
        'hard',
        `Drops view \`${input.db}\`.\`${input.table}\` (its data is not affected)`,
      ),
    ]
  }
  return withFkChecksOff(
    st(
      `DROP TABLE ${qt(input.db, input.table)}`,
      'dropTable',
      'hard',
      `Drops table \`${input.db}\`.\`${input.table}\` with all its data`,
    ),
    input.ignoreForeignKeys,
  )
}

// ---- Entry point -----------------------------------------------------------------------------------

/**
 * Turns a validated `PreviewInput` into the exact statements to run. Throws `BuildRefusal` for input it
 * must refuse (missing capability, invalid combination, rejected expression, system schema).
 */
export function buildStatements(input: PreviewInput, ctx: BuildContext): BuiltPlan {
  let statements: Statement[]
  switch (input.action) {
    case 'createDatabase':
      statements = buildCreateDatabase(input)
      break
    case 'dropDatabase':
      statements = buildDropDatabase(input)
      break
    case 'createTable':
      statements = buildCreateTable(input, ctx)
      break
    case 'alterTable':
      statements = buildAlterTable(input, ctx)
      break
    case 'renameTable':
      statements = buildRenameTable(input)
      break
    case 'truncateTable':
      statements = buildTruncate(input)
      break
    case 'dropTable':
      statements = buildDropTable(input)
      break
  }
  const warnings: PlanWarning[] = []
  if (statements.some((s) => s.class === 'hard')) {
    warnings.push({
      code: 'data-loss',
      message: 'This plan can destroy data permanently and cannot be undone.',
    })
  }
  if (statements.length > 1) {
    warnings.push({
      code: 'ddl-not-atomic',
      message:
        'These statements run one after another; the server commits each one and cannot undo earlier ones.',
    })
  }
  if (input.action === 'renameTable' && input.newDb !== undefined && input.newDb !== input.db) {
    warnings.push({
      code: 'cross-database-move',
      message: 'Moving a table to another database does not move its triggers or privileges.',
    })
  }
  return { statements, warnings }
}
