/**
 * Pure helpers of the table designer: the draft the form edits, the cleaned model sent to the server,
 * validation (the zod schemas of `structure/types.ts` plus the rules zod cannot express), and the diff
 * that turns an edited existing table into `AlterOp[]`. No React, no I/O: unit-testable.
 */
import type { MessageKey } from '~/i18n'
import {
  tableDefinition,
  type AlterOp,
  type Capabilities,
  type CheckDef,
  type ColumnDef,
  type ColumnType,
  type FkDef,
  type IndexDef,
  type PreviewInput,
  type TableDefinition,
  type TableOptions,
} from '~/server/structure/types'

// ---- Draft ----------------------------------------------------------------------------------------

export type ColRow = {
  key: string
  /** Name on the server, when the column already exists. */
  orig?: string
  removed?: boolean
  /** The name that indexes and keys in the draft currently use for this column. */
  ref: string
  def: ColumnDef
}
export type IdxRow = { key: string; orig?: string; def: IndexDef }
export type FkRow = { key: string; orig?: string; def: FkDef }
export type ChkRow = { key: string; orig?: string; def: CheckDef }

export type Draft = {
  name: string
  columns: ColRow[]
  indexes: IdxRow[]
  fks: FkRow[]
  checks: ChkRow[]
  options: TableOptions
}

let counter = 0
/** Identity of an existing index on the server: PRIMARY for the primary key, else its name. */
export const idxId = (i: IndexDef) => (i.kind === 'primary' ? 'PRIMARY' : (i.name ?? ''))

export const newKey = () => `r${++counter}`

export function blankColumn(name = ''): ColumnDef {
  return { name, type: 'varchar', length: 255, nullable: true, default: { kind: 'none' } }
}

export function emptyDraft(): Draft {
  const id = newKey()
  return {
    name: '',
    columns: [
      {
        key: id,
        ref: 'id',
        def: {
          name: 'id',
          type: 'bigint',
          unsigned: true,
          nullable: false,
          autoIncrement: true,
          default: { kind: 'none' },
        },
      },
    ],
    indexes: [{ key: newKey(), def: { kind: 'primary', parts: [{ column: 'id' }] } }],
    fks: [],
    checks: [],
    options: {},
  }
}

export function draftFromDefinition(def: TableDefinition): Draft {
  return {
    name: def.name,
    columns: def.columns.map((c) => ({
      key: newKey(),
      orig: c.name,
      ref: c.name,
      def: structuredClone(c),
    })),
    indexes: def.indexes.map((i) => ({ key: newKey(), orig: idxId(i), def: structuredClone(i) })),
    fks: def.fks.map((f) => ({ key: newKey(), orig: f.name, def: structuredClone(f) })),
    checks: def.checks.map((c) => ({ key: newKey(), orig: c.name, def: structuredClone(c) })),
    options: {
      engine: def.engine,
      charset: def.charset,
      collation: def.collation,
      comment: def.comment,
      autoIncrement: def.autoIncrement,
      rowFormat: def.rowFormat,
    },
  }
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

// ---- Types and capabilities -----------------------------------------------------------------------

const INTEGERS: ColumnType[] = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint']
const NUMERIC: ColumnType[] = [...INTEGERS, 'decimal', 'float', 'double']
const SIZED: ColumnType[] = ['char', 'varchar', 'binary', 'varbinary', 'bit']
const CHARSET_TYPES: ColumnType[] = [
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'enum',
  'set',
]

export function traits(type: ColumnType) {
  return {
    integer: INTEGERS.includes(type),
    unsigned: NUMERIC.includes(type),
    sized: SIZED.includes(type),
    lengthRequired: type === 'varchar' || type === 'varbinary',
    decimal: type === 'decimal',
    list: type === 'enum' || type === 'set',
    timestamp: type === 'datetime' || type === 'timestamp',
    numeric: NUMERIC.includes(type),
    charset: CHARSET_TYPES.includes(type),
  }
}

const TYPE_CAPABILITY: Partial<Record<ColumnType, keyof Capabilities>> = {
  uuid: 'type-uuid',
  inet6: 'type-inet6',
  json: 'type-json',
}

/** Null when the type can be used on this server; otherwise the key of the reason. */
export function typeDisabledReason(
  type: ColumnType,
  caps: Capabilities | undefined,
): MessageKey | null {
  const key = TYPE_CAPABILITY[type]
  if (!key || !caps) return null
  return caps[key] ? null : 'structure.unsupported'
}

/** Resets the parameters that do not belong to the new type and fills the ones it needs. */
export function applyType(def: ColumnDef, type: ColumnType): ColumnDef {
  const t = traits(type)
  const next: ColumnDef = { ...def, type }
  if (!t.sized) delete next.length
  else if (t.lengthRequired && !next.length) next.length = 255
  if (!t.decimal) {
    delete next.precision
    delete next.scale
  } else {
    next.precision ??= 10
    next.scale ??= 0
  }
  if (!t.list) delete next.values
  else next.values ??= []
  if (!t.unsigned) delete next.unsigned
  if (!t.integer) delete next.autoIncrement
  if (!t.timestamp) {
    delete next.onUpdateCurrentTimestamp
    if (next.default.kind === 'currentTimestamp') next.default = { kind: 'none' }
  }
  return next
}

// ---- Cleaning (draft -> model) --------------------------------------------------------------------

const blank = (s: string | undefined) => s === undefined || s.trim() === ''

export function cleanColumn(def: ColumnDef): ColumnDef {
  const t = traits(def.type)
  const out: ColumnDef = {
    name: def.name,
    type: def.type,
    nullable: def.nullable,
    default: { kind: 'none' },
  }
  if (t.sized && def.length !== undefined) out.length = def.length
  if (t.decimal) {
    if (def.precision !== undefined) out.precision = def.precision
    if (def.scale !== undefined) out.scale = def.scale
  }
  if (t.list) out.values = (def.values ?? []).filter((v) => v !== '')
  if (t.unsigned && def.unsigned) out.unsigned = true
  const generated = def.generated && !blank(def.generated.sql) ? def.generated : undefined
  if (generated) {
    out.generated = { sql: generated.sql.trim(), storage: generated.storage }
  } else {
    const d = def.default
    if (d.kind === 'literal') {
      const asNumber =
        t.numeric && d.value !== '' && Number.isFinite(Number(d.value)) ? Number(d.value) : d.value
      out.default = { kind: 'literal', value: asNumber }
    } else if (d.kind === 'expression') {
      out.default = { kind: 'expression', sql: d.sql.trim() }
    } else {
      out.default = d
    }
    if (t.integer && def.autoIncrement) out.autoIncrement = true
    if (t.timestamp && def.onUpdateCurrentTimestamp) out.onUpdateCurrentTimestamp = true
  }
  if (!blank(def.comment)) out.comment = def.comment
  if (def.invisible) out.invisible = true
  if (!blank(def.charset)) out.charset = def.charset
  if (!blank(def.collation)) out.collation = def.collation
  return out
}

export function cleanIndex(def: IndexDef): IndexDef {
  const out: IndexDef = {
    kind: def.kind,
    parts: def.parts.map((p) => {
      const part: IndexDef['parts'][number] = { column: p.column }
      if (p.length !== undefined) part.length = p.length
      if (p.order === 'desc') part.order = 'desc'
      return part
    }),
  }
  if (def.kind !== 'primary' && !blank(def.name)) out.name = def.name
  if (def.visibility === 'invisible') out.visibility = 'invisible'
  return out
}

export function cleanFk(def: FkDef): FkDef {
  const out: FkDef = {
    columns: def.columns,
    refDb: def.refDb,
    refTable: def.refTable,
    refColumns: def.refColumns,
    onDelete: def.onDelete,
    onUpdate: def.onUpdate,
  }
  if (!blank(def.name)) out.name = def.name
  return out
}

export function cleanCheck(def: CheckDef): CheckDef {
  const out: CheckDef = { sql: def.sql.trim() }
  if (!blank(def.name)) out.name = def.name
  if (def.enforced === false) out.enforced = false
  return out
}

export function cleanOptions(o: TableOptions): TableOptions {
  const out: TableOptions = {}
  if (!blank(o.engine)) out.engine = o.engine
  if (!blank(o.charset)) out.charset = o.charset
  if (!blank(o.collation)) out.collation = o.collation
  if (!blank(o.comment)) out.comment = o.comment
  if (o.autoIncrement !== undefined) out.autoIncrement = o.autoIncrement
  if (o.rowFormat && o.rowFormat !== 'default') out.rowFormat = o.rowFormat
  return out
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The candidate TableDefinition the zod schema is run against (removed columns left out). */
export function candidateDefinition(db: string, tableName: string, draft: Draft) {
  const kept = draft.columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.removed)
  return {
    kept: kept.map(({ i }) => i),
    value: {
      ...cleanOptions(draft.options),
      db,
      name: tableName,
      columns: kept.map(({ c }) => cleanColumn(c.def)),
      indexes: draft.indexes.map((r) => cleanIndex(r.def)),
      fks: draft.fks.map((r) => cleanFk(r.def)),
      checks: draft.checks.map((r) => cleanCheck(r.def)),
    },
  }
}

// ---- Validation -----------------------------------------------------------------------------------

export type FieldError = { key: MessageKey; values?: Record<string, string | number> }
export type FieldErrors = Record<string, FieldError>

type Issue = {
  code: string
  path: PropertyKey[]
  minimum?: unknown
  maximum?: unknown
  message?: string
  origin?: string
}

function issueError(issue: Issue): FieldError {
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array'
        ? { key: 'structure.err.required' }
        : { key: 'structure.err.min', values: { min: String(issue.minimum) } }
    case 'too_big':
      return issue.origin === 'string'
        ? { key: 'structure.err.tooLong', values: { max: String(issue.maximum) } }
        : { key: 'structure.err.max', values: { max: String(issue.maximum) } }
    case 'invalid_type':
      return { key: 'structure.err.required' }
    case 'custom':
      return { key: 'structure.err.invalidName' }
    default:
      return { key: 'structure.err.invalid' }
  }
}

export type ValidateContext = {
  db: string
  /** Table name for the model: the typed name when creating, the existing name when altering. */
  tableName: string
  draft: Draft
  caps: Capabilities | undefined
}

export function validateDraft({ db, tableName, draft, caps }: ValidateContext): FieldErrors {
  const errors: FieldErrors = {}
  const set = (path: string, error: FieldError) => {
    errors[path] ??= error
  }

  const { kept, value } = candidateDefinition(db, tableName, draft)
  const parsed = tableDefinition.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues as Issue[]) {
      const path = issue.path.map(String)
      if (path[0] === 'db') continue
      if (path[0] === 'name') {
        set('name', issueError(issue))
        continue
      }
      if (path[0] === 'columns' && path[1] !== undefined) {
        path[1] = String(kept[Number(path[1])] ?? path[1])
      }
      set(path.join('.'), issueError(issue))
    }
  }

  // Rules beyond the schema.
  const names = new Set<string>()
  draft.columns.forEach((row, i) => {
    if (row.removed) return
    const def = cleanColumn(row.def)
    const t = traits(def.type)
    const lower = def.name.toLowerCase()
    if (def.name !== '' && names.has(lower))
      set(`columns.${i}.name`, { key: 'structure.err.duplicate' })
    names.add(lower)
    if (t.lengthRequired && def.length === undefined)
      set(`columns.${i}.length`, { key: 'structure.err.required' })
    if (t.decimal && def.precision !== undefined && (def.scale ?? 0) > def.precision) {
      set(`columns.${i}.scale`, { key: 'structure.err.scale' })
    }
    if (t.list && (def.values ?? []).length === 0)
      set(`columns.${i}.values`, { key: 'structure.err.values' })
    if (def.default.kind === 'currentTimestamp' && !t.timestamp) {
      set(`columns.${i}.default`, { key: 'structure.err.defaultType' })
    }
    if (def.default.kind === 'null' && !def.nullable) {
      set(`columns.${i}.default`, { key: 'structure.err.defaultNull' })
    }
    if (def.default.kind === 'literal' && t.numeric && typeof def.default.value === 'string') {
      set(`columns.${i}.default`, { key: 'structure.err.defaultNumber' })
    }
    if (def.generated && caps && !caps['generated-column']) {
      set(`columns.${i}.generated`, { key: 'structure.unsupported' })
    }
    const unavailable = typeDisabledReason(def.type, caps)
    if (unavailable) set(`columns.${i}.type`, { key: unavailable })
  })

  let primaries = 0
  draft.indexes.forEach((row, i) => {
    const def = cleanIndex(row.def)
    if (def.kind === 'primary' && ++primaries > 1)
      set(`indexes.${i}.kind`, { key: 'structure.err.onePrimary' })
    if (def.kind !== 'primary' && def.name?.toLowerCase() === 'primary') {
      set(`indexes.${i}.name`, { key: 'structure.err.primaryName' })
    }
    def.parts.forEach((p, j) => {
      if (p.column !== '' && !names.has(p.column.toLowerCase())) {
        set(`indexes.${i}.parts.${j}.column`, { key: 'structure.err.unknownColumn' })
      }
    })
    if (def.visibility === 'invisible' && caps && !caps['index-hide']) {
      set(`indexes.${i}.visibility`, { key: 'structure.unsupported' })
    }
  })

  draft.fks.forEach((row, i) => {
    const def = cleanFk(row.def)
    if (def.columns.length !== def.refColumns.length)
      set(`fks.${i}.refColumns`, { key: 'structure.err.fkCount' })
    def.columns.forEach((c, j) => {
      if (c !== '' && !names.has(c.toLowerCase()))
        set(`fks.${i}.columns.${j}`, { key: 'structure.err.unknownColumn' })
    })
  })

  if (draft.checks.length > 0 && caps && !caps['check-constraint']) {
    set('checks.0.sql', { key: 'structure.unsupported' })
  }
  return errors
}

// ---- Alter diff -----------------------------------------------------------------------------------

const sameColumn = (a: ColumnDef, b: ColumnDef) =>
  stableStringify(cleanColumn(a)) === stableStringify(cleanColumn(b))
const withoutName = (c: ColumnDef): ColumnDef => ({ ...c, name: '' })

/** Turns the edited draft of an existing table into the alter operations that produce it. */
export function diffToOps(
  current: TableDefinition,
  draft: Draft,
  caps: Capabilities | undefined,
): AlterOp[] {
  const ops: AlterOp[] = []
  const currentCols = new Map(current.columns.map((c) => [c.name, c]))

  // A renamed column keeps its indexes and keys on the server, so compare them under the old names.
  const origOf = new Map(
    draft.columns.filter((c) => c.orig && !c.removed).map((c) => [c.def.name, c.orig as string]),
  )
  const old = (name: string) => origOf.get(name) ?? name
  const indexUnderOldNames = (def: IndexDef): IndexDef => ({
    ...def,
    parts: def.parts.map((p) => ({ ...p, column: old(p.column) })),
  })
  const fkUnderOldNames = (def: FkDef): FkDef => ({ ...def, columns: def.columns.map(old) })

  // 1. Drops of constraints and indexes first, so they never block a column change.
  const droppedFk = new Set<string>()
  const droppedChk = new Set<string>()
  const fkByName = new Map(draft.fks.filter((r) => r.orig).map((r) => [r.orig as string, r]))
  for (const fk of current.fks) {
    const row = fk.name ? fkByName.get(fk.name) : undefined
    if (
      fk.name &&
      (!row || stableStringify(cleanFk(fkUnderOldNames(row.def))) !== stableStringify(cleanFk(fk)))
    ) {
      ops.push({ op: 'dropFk', name: fk.name })
      droppedFk.add(fk.name)
    }
  }
  const chkByName = new Map(draft.checks.filter((r) => r.orig).map((r) => [r.orig as string, r]))
  for (const chk of current.checks) {
    const row = chk.name ? chkByName.get(chk.name) : undefined
    if (
      chk.name &&
      (!row || stableStringify(cleanCheck(row.def)) !== stableStringify(cleanCheck(chk)))
    ) {
      ops.push({ op: 'dropCheck', name: chk.name })
      droppedChk.add(chk.name)
    }
  }
  const idxById = new Map(draft.indexes.filter((r) => r.orig).map((r) => [r.orig as string, r]))
  const visibilityOnly: AlterOp[] = []
  const idxRecreate = new Set<string>()
  for (const idx of current.indexes) {
    const name = idxId(idx)
    if (!name) continue
    const match = idxById.get(name)
    if (!match) {
      ops.push({ op: 'dropIndex', name })
      continue
    }
    const { visibility: av, ...restA } = cleanIndex(indexUnderOldNames(match.def))
    const { visibility: bv, ...restB } = cleanIndex(idx)
    if (stableStringify(restA) !== stableStringify(restB)) {
      ops.push({ op: 'dropIndex', name })
      idxRecreate.add(match.key)
    } else if ((av ?? 'visible') !== (bv ?? 'visible')) {
      visibilityOnly.push({ op: 'setIndexVisibility', name, visibility: av ?? 'visible' })
    }
  }

  // 2. Columns: drops, then renames/modifications, then positions and additions.
  for (const row of draft.columns) {
    if (row.orig && row.removed) ops.push({ op: 'dropColumn', name: row.orig })
  }
  const kept = draft.columns.filter((r) => !r.removed)
  const sim = current.columns
    .map((c) => c.name)
    .filter((n) => !draft.columns.some((r) => r.removed && r.orig === n))
  const pendingModify = new Map<string, Extract<AlterOp, { op: 'modifyColumn' }>>()
  for (const row of kept) {
    if (!row.orig) continue
    const before = currentCols.get(row.orig)
    if (!before) continue
    const renamed = row.def.name !== row.orig
    const changed = !sameColumn(withoutName(row.def), withoutName(before))
    if (renamed && !changed && (!caps || caps['rename-column'])) {
      ops.push({ op: 'renameColumn', from: row.orig, to: row.def.name })
    } else if (renamed || changed) {
      const op: Extract<AlterOp, { op: 'modifyColumn' }> = {
        op: 'modifyColumn',
        name: row.orig,
        column: cleanColumn(row.def),
      }
      ops.push(op)
      pendingModify.set(row.def.name, op)
    }
    const at = sim.indexOf(row.orig)
    if (at >= 0) sim[at] = row.def.name
  }
  const target = kept.map((r) => r.def.name)
  kept.forEach((row, i) => {
    const name = target[i] as string
    const previous = i === 0 ? null : (target[i - 1] as string)
    if (!row.orig) {
      ops.push({ op: 'addColumn', column: cleanColumn(row.def), after: previous })
      sim.splice(i, 0, name)
      return
    }
    if (sim[i] === name) return
    sim.splice(sim.indexOf(name), 1)
    sim.splice(i, 0, name)
    const pending = pendingModify.get(name)
    if (pending) pending.after = previous
    else ops.push({ op: 'modifyColumn', name, column: cleanColumn(row.def), after: previous })
  })

  // 3. Additions and option changes.
  for (const row of draft.indexes) {
    if (!row.orig || idxRecreate.has(row.key))
      ops.push({ op: 'addIndex', index: cleanIndex(row.def) })
  }
  for (const row of draft.fks) {
    if (!row.orig || droppedFk.has(row.orig)) ops.push({ op: 'addFk', fk: cleanFk(row.def) })
  }
  for (const row of draft.checks) {
    if (!row.orig || droppedChk.has(row.orig))
      ops.push({ op: 'addCheck', check: cleanCheck(row.def) })
  }
  ops.push(...visibilityOnly)

  const next = cleanOptions(draft.options)
  const before = cleanOptions({
    engine: current.engine,
    charset: current.charset,
    collation: current.collation,
    comment: current.comment,
    autoIncrement: current.autoIncrement,
    rowFormat: current.rowFormat,
  })
  const changedOptions: TableOptions = {}
  for (const key of [
    'engine',
    'charset',
    'collation',
    'comment',
    'autoIncrement',
    'rowFormat',
  ] as const) {
    if (next[key] !== undefined && next[key] !== before[key])
      Object.assign(changedOptions, { [key]: next[key] })
  }
  if (draft.options.comment === '' && before.comment) changedOptions.comment = ''
  if (Object.keys(changedOptions).length > 0)
    ops.push({ op: 'setOptions', options: changedOptions })

  return ops
}

export function buildCreateInput(db: string, draft: Draft): PreviewInput {
  const { value } = candidateDefinition(db, draft.name, draft)
  return { action: 'createTable', table: value as TableDefinition }
}

export function buildAlterInput(db: string, table: string, ops: AlterOp[]): PreviewInput {
  return { action: 'alterTable', db, table, ops }
}

// ---- Draft edits that touch several lists ---------------------------------------------------------

export function setColumnName(draft: Draft, key: string, name: string): Draft {
  const row = draft.columns.find((c) => c.key === key)
  if (!row) return draft
  const from = row.ref
  const rename = name !== '' && from !== '' && from !== name
  return {
    ...draft,
    columns: draft.columns.map((c) =>
      c.key === key ? { ...c, ref: name === '' ? c.ref : name, def: { ...c.def, name } } : c,
    ),
    indexes: rename
      ? draft.indexes.map((i) => ({
          ...i,
          def: {
            ...i.def,
            parts: i.def.parts.map((p) => (p.column === from ? { ...p, column: name } : p)),
          },
        }))
      : draft.indexes,
    fks: rename
      ? draft.fks.map((f) => ({
          ...f,
          def: { ...f.def, columns: f.def.columns.map((c) => (c === from ? name : c)) },
        }))
      : draft.fks,
  }
}

export const hasPrimaryColumn = (draft: Draft, column: string) =>
  draft.indexes.some(
    (i) => i.def.kind === 'primary' && i.def.parts.some((p) => p.column === column),
  )

export function togglePrimaryKey(draft: Draft, column: string): Draft {
  if (column === '') return draft
  const primary = draft.indexes.find((i) => i.def.kind === 'primary')
  if (!primary) {
    return {
      ...draft,
      indexes: [{ key: newKey(), def: { kind: 'primary', parts: [{ column }] } }, ...draft.indexes],
    }
  }
  const has = primary.def.parts.some((p) => p.column === column)
  const parts = has
    ? primary.def.parts.filter((p) => p.column !== column)
    : [...primary.def.parts, { column }]
  const indexes =
    parts.length === 0
      ? draft.indexes.filter((i) => i !== primary)
      : draft.indexes.map((i) => (i === primary ? { ...i, def: { ...i.def, parts } } : i))
  return { ...draft, indexes }
}

/** Removes a column row: a new one disappears (and leaves the indexes), an existing one is marked. */
export function removeColumn(draft: Draft, key: string): Draft {
  const row = draft.columns.find((c) => c.key === key)
  if (!row) return draft
  if (row.orig) {
    return {
      ...draft,
      columns: draft.columns.map((c) => (c.key === key ? { ...c, removed: !c.removed } : c)),
    }
  }
  const name = row.ref
  return {
    ...draft,
    columns: draft.columns.filter((c) => c.key !== key),
    indexes: draft.indexes
      .map((i) => ({
        ...i,
        def: { ...i.def, parts: i.def.parts.filter((p) => p.column !== name) },
      }))
      .filter((i) => i.def.parts.length > 0),
  }
}

/** Index rows whose column list repeats the start of another index (FR-DTB-064 notice). */
export function duplicateIndexKeys(indexes: IdxRow[]): Set<string> {
  const found = new Set<string>()
  const signature = (i: IdxRow) => i.def.parts.map((p) => `${p.column}:${p.length ?? ''}`).join(',')
  indexes.forEach((a, i) => {
    indexes.forEach((b, j) => {
      if (i >= j || a.def.parts.length === 0 || b.def.parts.length === 0) return
      const sa = signature(a)
      const sb = signature(b)
      if (sa === sb || sa.startsWith(`${sb},`) || sb.startsWith(`${sa},`)) {
        found.add(a.key)
        found.add(b.key)
      }
    })
  })
  return found
}

/**
 * True when the text has a character above U+FFFF (emoji and the like). Column comments are stored as
 * 3-byte UTF-8 on MySQL and MariaDB, so such characters would be saved as `?`.
 */
export function hasFourByteChars(text: string): boolean {
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0xffff) return true
  }
  return false
}

/** Valid for a new table or column name before any request (FR-DTB-041). */
export function nameError(name: string): MessageKey | null {
  if (name === '') return 'structure.err.required'
  if (name.length > 64) return 'structure.err.tooLong'
  if (name !== name.trimEnd() || name.includes('\u0000')) return 'structure.err.invalidName'
  return null
}
