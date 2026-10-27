import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Select } from '~/components/ui/select'
import { ioApi } from '~/lib/io/api'
import { t } from '~/i18n'
import type { ParseProblem } from '~/server/io/types'
import {
  REVIEW_TYPES,
  toTableDefinition,
  validateMapping,
  validateReview,
  type MapRow,
  type ReviewColumn,
  type TargetColumn,
} from './import-model'

/** A wrong delimiter shows as one wide column whose name still holds the delimiter (DATA-ISS-006). */
export function looksMerged(columns: string[], sample: (string | null)[][] = []): boolean {
  if (columns.length !== 1) return false
  // With a header row the names show it; without one the first data row does (commas are common in text).
  return /[;,\t|]/.test(columns[0] ?? '') || /[;\t|]/.test(sample[0]?.[0] ?? '')
}

/** First rows of the file as read with the current options; cells are text nodes only. */
export function SamplePreview({
  columns,
  sample,
  warnings,
  rowCount,
}: {
  columns: string[]
  sample: (string | null)[][]
  warnings: ParseProblem[]
  rowCount: number | null
}) {
  return (
    <section aria-label={t('io.preview.title')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-sm font-semibold">{t('io.preview.title')}</h3>
        {rowCount !== null && (
          <p className="text-xs text-muted">
            {t('io.preview.rows', { n: rowCount.toLocaleString('en') })}
          </p>
        )}
      </div>
      {looksMerged(columns, sample) && (
        <p role="alert" className="text-sm text-[var(--pill-warning-ink)]">
          {t('io.preview.merged')}
        </p>
      )}
      <div className="max-h-64 overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-max text-left text-sm">
          <caption className="sr-only">{t('io.preview.title')}</caption>
          <thead className="sticky top-0 bg-raised">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={`${c}-${i}`}
                  scope="col"
                  className="max-w-56 truncate px-3 py-1.5 font-medium"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((row, r) => (
              <tr key={r} className="border-t border-border">
                {columns.map((_, i) => {
                  const cell = row[i] ?? null
                  return (
                    <td key={i} className="max-w-56 truncate px-3 py-1.5">
                      {cell === null ? <span className="text-faint">NULL</span> : cell}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-[var(--pill-warning-ink)]">
          {warnings.slice(0, 20).map((w, i) => (
            <li key={i}>
              {t('io.result.row', { row: w.row })}
              {w.column ? `, ${w.column}` : ''}: {w.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Mapping step for an existing table: each file column to a table column, or skipped (FR-IO-018). */
export function MappingStep({
  rows,
  targets,
  sample,
  onChange,
}: {
  rows: MapRow[]
  targets: TargetColumn[]
  sample: (string | null)[][]
  onChange: (rows: MapRow[]) => void
}) {
  const base = useId()
  const check = validateMapping(rows)
  const usable = targets.filter((c) => !c.generated)
  return (
    <section aria-label={t('io.mapping.title')} className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{t('io.mapping.title')}</h3>
        <p className="text-sm text-muted">{t('io.mapping.lead')}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const id = `${base}-${i}`
          const dup = row.target !== null && check.duplicates.includes(row.target)
          const example = sample[0]?.[i]
          return (
            <li
              key={i}
              className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
            >
              <div className="min-w-0">
                <Label htmlFor={id} className="block truncate">
                  {row.label}
                </Label>
                {example !== undefined && example !== null && (
                  <p className="truncate text-xs text-muted">
                    {t('io.mapping.example', { value: example })}
                  </p>
                )}
              </div>
              <Select
                id={id}
                value={row.target ?? ''}
                aria-invalid={dup}
                onChange={(e) =>
                  onChange(
                    rows.map((r, j) => (j === i ? { ...r, target: e.target.value || null } : r)),
                  )
                }
              >
                <option value="">{t('io.mapping.skip')}</option>
                {usable.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </option>
                ))}
              </Select>
            </li>
          )
        })}
      </ul>
      {check.problem === 'none' && (
        <p role="alert" className="text-sm text-negative">
          {t('io.mapping.none')}
        </p>
      )}
      {check.problem === 'duplicate' && (
        <p role="alert" className="text-sm text-negative">
          {t('io.mapping.duplicate', { names: check.duplicates.join(', ') })}
        </p>
      )}
    </section>
  )
}

const NUM = (v: string): number | undefined => (v === '' ? undefined : Number(v))

/** Columns proposed for a new table, editable, with the structure builder's CREATE TABLE shown (FR-IO-019). */
export function NewTableReview({
  db,
  tableName,
  onTableName,
  columns,
  onChange,
}: {
  db: string
  tableName: string
  onTableName: (name: string) => void
  columns: ReviewColumn[]
  onChange: (columns: ReviewColumn[]) => void
}) {
  const base = useId()
  const problems = validateReview(tableName, columns)
  const valid = problems.length === 0
  const def = valid ? toTableDefinition(db, tableName, columns) : null
  const sql = useQuery({
    queryKey: ['io', 'new-table-sql', def],
    enabled: def !== null,
    queryFn: () => ioApi().previewNewTable(def as NonNullable<typeof def>),
    staleTime: 0,
    retry: false,
  })
  const patch = (i: number, p: Partial<ReviewColumn>) =>
    onChange(columns.map((c, j) => (j === i ? { ...c, ...p } : c)))
  const errFor = (field: string) => {
    const p = problems.find((x) => x.field === field)
    return p ? t(p.key) : undefined
  }
  return (
    <section aria-label={t('io.newTable.title')} className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{t('io.newTable.title')}</h3>
        <p className="text-sm text-muted">{t('io.newTable.lead')}</p>
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <Label htmlFor={`${base}-name`}>{t('io.newTable.name')}</Label>
        <Input
          id={`${base}-name`}
          value={tableName}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(errFor('table'))}
          onChange={(e) => onTableName(e.target.value)}
        />
        {errFor('table') && <p className="text-xs text-negative">{errFor('table')}</p>}
      </div>
      <ul className="flex flex-col gap-3">
        {columns.map((c, i) => {
          const id = `${base}-c${i}`
          const err = errFor(`col.${i}`)
          return (
            <li
              key={i}
              className="grid gap-2 rounded-lg bg-raised p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)]"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${id}-n`}>{t('io.newTable.column')}</Label>
                <Input
                  id={`${id}-n`}
                  value={c.name}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(err)}
                  aria-describedby={err ? `${id}-e` : undefined}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                {err && (
                  <p id={`${id}-e`} className="text-xs text-negative">
                    {err}
                  </p>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${id}-t`}>{t('io.newTable.type')}</Label>
                <Select
                  id={`${id}-t`}
                  value={c.type}
                  onChange={(e) => {
                    const type = e.target.value as ReviewColumn['type']
                    const next: ReviewColumn = { source: c.source, name: c.name, type }
                    if (type === 'varchar') next.length = c.length ?? 255
                    if (type === 'decimal') {
                      next.precision = c.precision ?? 10
                      next.scale = c.scale ?? 2
                    }
                    onChange(columns.map((x, j) => (j === i ? next : x)))
                  }}
                >
                  {REVIEW_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {ty.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex min-w-0 gap-2">
                {c.type === 'varchar' && (
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Label htmlFor={`${id}-l`}>{t('io.newTable.length')}</Label>
                    <Input
                      id={`${id}-l`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65535}
                      value={c.length ?? ''}
                      onChange={(e) => {
                        const length = NUM(e.target.value)
                        const { length: _drop, ...rest } = c
                        void _drop
                        onChange(
                          columns.map((x, j) =>
                            j === i ? { ...rest, ...(length !== undefined ? { length } : {}) } : x,
                          ),
                        )
                      }}
                    />
                  </div>
                )}
                {c.type === 'decimal' && (
                  <>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Label htmlFor={`${id}-p`}>{t('io.newTable.precision')}</Label>
                      <Input
                        id={`${id}-p`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={65}
                        value={c.precision ?? ''}
                        onChange={(e) => patch(i, { precision: NUM(e.target.value) ?? 10 })}
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Label htmlFor={`${id}-s`}>{t('io.newTable.scale')}</Label>
                      <Input
                        id={`${id}-s`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={30}
                        value={c.scale ?? ''}
                        onChange={(e) => patch(i, { scale: NUM(e.target.value) ?? 0 })}
                      />
                    </div>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-col gap-1.5">
        <h4 className="text-sm font-medium">{t('io.newTable.sql')}</h4>
        {sql.data ? (
          <pre className="max-h-48 overflow-auto rounded-lg bg-raised p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {sql.data.statements.join('\n\n')}
          </pre>
        ) : sql.isError ? (
          <p role="alert" className="text-sm text-negative">
            {t('io.newTable.sqlFailed')}
          </p>
        ) : (
          <p className="text-sm text-muted">{valid ? t('io.loading') : t('io.newTable.fix')}</p>
        )}
      </div>
    </section>
  )
}
