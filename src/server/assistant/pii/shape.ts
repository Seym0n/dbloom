/**
 * What goes to the model from a result (SPEC/34 FR-AST-007, FR-AST-008): rows with PII cells replaced by tokens, or the
 * metadata only when the origin of any output column is unknown. Pure.
 */
import type { Cell } from '~/server/db/rows'
import type { SqlColumnMeta } from '~/server/sql/types'
import type { OutputColumn } from './taint'
import { labelOf, type TokenMap } from './tokens'

export type ModelResult =
  | {
      mode: 'rows'
      columns: { name: string; type: string; anonymized: boolean }[]
      rows: (string | null)[][]
      rowCount: number
      truncated: boolean
    }
  | {
      mode: 'metadata'
      reason: 'unknown-origin' | 'column-mismatch' | 'unanalysed'
      columns: { name: string; type: string }[]
      rowCount: number
    }

/** A clean cell as plain text for the model; long and binary values are described, not sent whole. */
function plain(cell: Cell): string | null {
  if (cell === null) return null
  if (typeof cell === 'string') return cell
  if ('cut' in cell) return `${cell.cut}… (${cell.length} characters)`
  return `[binary, ${cell.size} bytes]`
}

export function shapeForModel(
  taints: OutputColumn[] | undefined,
  columns: SqlColumnMeta[],
  rows: Cell[][],
  map: TokenMap,
  opts: { maxRows: number; truncated?: boolean },
): ModelResult {
  const meta = columns.map((c) => ({ name: c.name, type: c.type }))
  if (!taints) return { mode: 'metadata', reason: 'unanalysed', columns: meta, rowCount: rows.length }
  if (taints.length !== columns.length) return { mode: 'metadata', reason: 'column-mismatch', columns: meta, rowCount: rows.length }
  if (taints.some((t) => t.taint === 'unknown')) return { mode: 'metadata', reason: 'unknown-origin', columns: meta, rowCount: rows.length }
  const kept = rows.slice(0, opts.maxRows)
  const labels = columns.map((c) => labelOf(c.name))
  return {
    mode: 'rows',
    columns: columns.map((c, i) => ({ name: c.name, type: c.type, anonymized: taints[i]!.taint === 'pii' })),
    rows: kept.map((row) =>
      row.map((cell, i) => {
        if (taints[i]!.taint !== 'pii') return plain(cell)
        return cell === null ? null : map.tokenFor(labels[i]!, cell)
      }),
    ),
    rowCount: rows.length,
    truncated: rows.length > kept.length || opts.truncated === true,
  }
}
