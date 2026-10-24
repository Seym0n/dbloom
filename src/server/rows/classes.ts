/**
 * Soft/hard class table of FR-ROW-020 (spec 5.6). Pure: the class is computed on the server from the model
 * and the change, the client never sends one.
 *
 *   none: insert (any number of rows up to the cap); update of one row by primary or unique key
 *   soft: delete of one row by key; update of two or more rows; `INSERT IGNORE` on a non-transactional engine
 *   hard: delete of two or more rows; any write whose identity is `all-columns` (G1); a delete or an update
 *         that cascades to referencing tables (`ON DELETE CASCADE`, `ON UPDATE CASCADE` when the update
 *         touches the referenced columns)
 *
 * Interpretation recorded for the owner: the cascade rule of FR-ROW-020 says "any write"; an insert cannot
 * cascade and an update that leaves the referenced columns alone cannot either, so only deletes and updates of
 * referenced columns are lifted (otherwise SCN-038, an inline edit of a referenced table, would not be class none).
 * Thresholds are Q2 of the spec; changing them needs the owner.
 */
import { RowValueError } from './codecs'
import type {
  Identity,
  PlanWarning,
  RowChange,
  RowClassReason,
  RowTable,
  StatementClass,
} from './types'

export type RowClassification = {
  /** The highest class of the plan; every statement of one change carries it. */
  class: StatementClass
  reasons: RowClassReason[]
  warnings: PlanWarning[]
  /** Referencing tables with CASCADE rules, from the catalog (listed in the confirmation). */
  cascadeTables: { db: string; table: string; fk: string }[]
  statements: number
}

const ORDER: Record<StatementClass, number> = { none: 0, soft: 1, hard: 2 }

export function maxClass(a: StatementClass, b: StatementClass): StatementClass {
  return ORDER[a] >= ORDER[b] ? a : b
}

export function classifyChange(
  table: RowTable,
  identity: Identity,
  change: RowChange,
): RowClassification {
  if (table.kind === 'view') {
    throw new RowValueError('view-read-only', 'Views are read-only')
  }
  const reasons: RowClassReason[] = []
  const warnings: PlanWarning[] = []
  let cls: StatementClass = 'none'
  const raise = (c: StatementClass, reason: RowClassReason) => {
    cls = maxClass(cls, c)
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  const statements = change.op === 'insert' ? change.rows.length : change.targets.length
  let cascadeTables: RowClassification['cascadeTables'] = []

  if (change.op === 'insert') {
    if (change.ignore && !table.transactional) raise('soft', 'engine-nontransactional')
  } else {
    if (identity.kind === 'none') {
      throw new RowValueError('no-identity', 'This row cannot be identified')
    }
    if (change.op === 'delete') {
      raise('soft', 'delete')
      if (statements > 1) raise('hard', 'bulk')
    } else if (statements > 1) {
      raise('soft', 'bulk')
    }
    if (identity.kind === 'all-columns') {
      raise('hard', 'no-key')
      warnings.push({
        code: 'no-key',
        message:
          'This table has no usable primary or unique key. The row is matched on all columns and only one match is changed; add a primary key to avoid this.',
      })
    }
    const touched = change.op === 'update' ? new Set(Object.keys(change.set)) : undefined
    cascadeTables = table.incoming
      .filter((fk) =>
        change.op === 'delete'
          ? fk.onDelete.toUpperCase() === 'CASCADE'
          : fk.onUpdate.toUpperCase() === 'CASCADE' && fk.refColumns.some((c) => touched!.has(c)),
      )
      .map((fk) => ({ db: fk.refDb, table: fk.refTable, fk: fk.name }))
    if (cascadeTables.length > 0) {
      raise('hard', 'cascade')
      warnings.push({
        code: 'cascade',
        message: `This change cascades to ${cascadeTables.map((t) => `${t.db}.${t.table}`).join(', ')}.`,
      })
    }
  }

  if (!table.transactional && statements > 1) {
    reasons.push('no-rollback')
    warnings.push({
      code: 'no-rollback',
      message: `Engine ${table.engine ?? 'unknown'} has no transactions: if a statement fails, the earlier ones stay applied.`,
    })
  }
  return { class: cls, reasons, warnings, cascadeTables, statements }
}
