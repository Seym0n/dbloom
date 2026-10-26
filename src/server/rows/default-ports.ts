import { NotFoundError } from '../db/schema'
import {
  buildCellChunk,
  buildCellRead,
  buildCellSize,
  buildCount,
  buildDelete,
  buildInsert,
  buildLookup,
  buildPage,
  buildRowByIdentity,
  buildUpdate,
  decodeRow,
  encodeSet,
  type ProjectionLayout,
} from './builder'
import { classifyChange } from './classes'
import { guardCondition, type SqlFragment } from './codecs'
import type { ReadStatement, RowsPorts } from './execute'
import { combineAnd, compileFilter, compileSearch } from './filter'
import { applyPrivileges, identityFor, loadRowTable, readPrivileges } from './model'
import type { BuiltStatement, GuardValue, Identity, RowTable, TypeKind } from './types'

/**
 * Binds the ports of `execute.ts` to package A (`model.ts`, `builder.ts`, `filter.ts`, `classes.ts`). Every
 * statement text comes from `builder.ts` (FR-ROW-001).
 */

const coarse = (kind: TypeKind): 'number' | 'temporal' | 'text' => {
  switch (kind) {
    case 'int':
    case 'decimal':
    case 'float':
    case 'bit':
    case 'year':
      return 'number'
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return 'temporal'
    default:
      return 'text'
  }
}

function readStatement(statement: BuiltStatement, layout: ProjectionLayout): ReadStatement {
  return {
    ...statement,
    columns: layout.columns.map((c) => c.name),
    kinds: layout.columns.map((c) => coarse(c.kind)),
    decode: (rows) => {
      const decoded = rows.map((r) => decodeRow(layout, r))
      return { rows: decoded.map((d) => d.cells), digests: decoded.map((d) => d.digests) }
    },
  }
}

/** Identity conditions for a key (local helper of the two byte statements). */
function whereOf(
  table: RowTable,
  identity: Identity,
  key: Record<string, GuardValue>,
): SqlFragment {
  if (identity.kind === 'none') throw new Error('no identity')
  const parts = identity.columns.map((name) => {
    const col = table.columns.find((c) => c.name === name)
    const g = key[name]
    if (!col || !g) throw new Error('bad key')
    return guardCondition(col, g, identity.kind === 'all-columns' ? 'old' : 'key')
  })
  return {
    sql: parts.map((p) => p.sql).join(' AND '),
    params: parts.flatMap((p) => p.params),
  }
}

const whereFor = (
  table: RowTable,
  filter: Parameters<typeof compileFilter>[1] | undefined,
  search: Parameters<typeof compileSearch>[1] | undefined,
) =>
  combineAnd(
    filter ? compileFilter(table, filter) : null,
    search ? compileSearch(table, search) : null,
  )

export const defaultPorts: RowsPorts = {
  async loadRowTable(pool, db, table) {
    try {
      return await loadRowTable(pool, db, table)
    } catch (error) {
      if (error instanceof NotFoundError) return undefined
      throw error
    }
  },
  async readPrivileges(pool, table) {
    const p = await readPrivileges(pool, table)
    return { table: applyPrivileges(table, p), delete: p ? p.delete : true }
  },
  identityFor: (table) => identityFor(table),
  buildPage(table, identity, input) {
    const built = buildPage(table, identity, {
      page: input.page,
      pageSize: input.pageSize,
      sort: input.sort,
      where: whereFor(table, input.filter, input.search),
      read: { cellBytes: input.cellBytes },
    })
    return readStatement(built.statement, built.layout)
  },
  buildCount: (table, input) =>
    buildCount(table, whereFor(table, input.filter, input.search), input.cap),
  buildRow(table, identity, key, input) {
    const built = buildRowByIdentity(table, identity, {
      key,
      read: { cellBytes: input.cellBytes },
      digests: true,
      ...(input.includeInvisible ? { includeInvisible: true } : {}),
    })
    return readStatement(built.statement, built.layout)
  },
  buildCellRead(table, identity, key, column, maxBytes) {
    const built = buildCellRead(table, identity, key, column, maxBytes)
    return {
      statement: built.statement,
      decode: (rows) => (rows[0] ? built.projection.decode(rows[0]) : undefined),
    }
  },
  buildCellSize: (table, identity, key, column) => ({
    statement: buildCellSize(table, identity, key, column),
    decode: (rows) => (rows[0] ? (rows[0][0] === null ? null : Number(rows[0][0])) : undefined),
  }),
  buildCellChunk: (table, identity, key, column, offset, length) =>
    buildCellChunk(table, identity, key, column, offset, length),
  buildLookup(ref, input) {
    const built = buildLookup(ref, input)
    return { statement: built.statement, decode: built.decode }
  },
  buildInsert: (table, row, ignore, bytes) =>
    buildInsert(table, encodeSet(table, row, { resolveUpload: bytes }), ignore),
  buildUpdate: (table, identity, target, set, bytes) =>
    buildUpdate(table, identity, target, encodeSet(table, set, { resolveUpload: bytes })),
  buildDelete: (table, identity, target) => buildDelete(table, identity, target),
  buildMatchCount(table, identity, target) {
    return buildCount(table, whereOf(table, identity, target.key))
  },
  classify(table, change, identity) {
    const c = classifyChange(table, identity, change)
    return {
      maxClass: c.class,
      reasons: c.reasons,
      warnings: c.warnings,
      cascadeTables: c.cascadeTables,
    }
  },
}
