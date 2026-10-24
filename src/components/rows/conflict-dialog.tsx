/**
 * Conflict UI (FR-ROW-005, G2, SCN-044): "This row was changed by someone else". Shows, per changed column,
 * what the user saw, what is stored now and what the user wants to write, and offers "Reload row" or
 * "Overwrite" (a second explicit click that resends with the current values as the old ones).
 */
import { useEffect, useId } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { t } from '~/i18n'
import type {
  Cell,
  ChangeRowsResponse,
  GuardValue,
  RowChange,
  RowColumn,
  RowTable,
  WireValue,
} from '~/server/rows/types'
import { tryGuard } from './form-core'

export type ConflictResponse = Extract<ChangeRowsResponse, { kind: 'conflict' }>

/** The current stored value of a column from the conflict answer, as a guard value (null = not comparable). */
export function currentGuard(
  model: RowTable,
  conflict: ConflictResponse,
  column: string,
): GuardValue | null {
  const index = conflict.columns.indexOf(column)
  const def = model.columns.find((c) => c.name === column)
  const cell = index >= 0 ? conflict.current[index] : undefined
  if (!def || cell === undefined) return null
  return tryGuard(def, cell, conflict.digests[column])
}

/**
 * The change to resend on "Overwrite": the same set, with the current values as the old values of the row
 * that conflicted. Other targets keep theirs. Pure; the caller also sets `overwrite: true`.
 */
export function overwriteChange(
  change: RowChange,
  conflict: ConflictResponse,
  model: RowTable,
): RowChange {
  if (change.op === 'insert') return change
  const targets = change.targets.map((target, i) => {
    if (i !== conflict.index) return target
    const old: Record<string, GuardValue> = {}
    for (const column of Object.keys(target.old)) {
      const guard = currentGuard(model, conflict, column)
      if (guard) old[column] = guard
    }
    return { ...target, old }
  })
  return { ...change, targets }
}

const cellText = (cell: Cell | undefined): string | null => {
  if (cell === undefined || cell === null) return null
  if (typeof cell === 'string') return cell
  if ('cut' in cell) return cell.cut
  return `0x${cell.binary}`
}

function Value({ text, digest }: { text: string | null; digest?: boolean }) {
  if (digest) return <span className="text-muted">{t('rows.dialog.conflict.digest')}</span>
  if (text === null) return <span className="text-faint">NULL</span>
  return (
    <span className="break-words whitespace-pre-wrap">
      {text === '' ? t('rows.dialog.conflict.empty') : text}
    </span>
  )
}

const guardText = (g: GuardValue | undefined) =>
  g === undefined ? undefined : g.t === 'null' ? null : g.v

const wantText = (w: WireValue | undefined): { text: string | null } | undefined => {
  if (!w) return undefined
  if (w.t === 'null') return { text: null }
  if (w.t === 'v') return { text: w.v }
  if (w.t === 'default') return { text: t('rows.dialog.conflict.wantDefault') }
  if (w.t === 'fn') return { text: t('rows.dialog.conflict.wantFunction') }
  return { text: t('rows.dialog.conflict.wantFile') }
}

export function ConflictDialog({
  conflict,
  change,
  model,
  total,
  busy,
  error,
  onReload,
  onOverwrite,
  onClose,
}: {
  conflict: ConflictResponse | null
  change: RowChange | null
  model: RowTable | null
  /** Rows in the whole change, to name the row of a bulk change. */
  total: number
  busy: boolean
  error?: string | null
  onReload: (conflict: ConflictResponse) => void
  onOverwrite: (conflict: ConflictResponse) => void
  onClose: () => void
}) {
  const titleId = useId()
  return (
    <Dialog
      open={conflict !== null}
      onClose={() => !busy && onClose()}
      labelledBy={titleId}
      className="w-[min(680px,calc(100vw-32px))]"
    >
      {conflict && (
        <Body
          conflict={conflict}
          change={change}
          model={model}
          total={total}
          busy={busy}
          error={error}
          titleId={titleId}
          onReload={onReload}
          onOverwrite={onOverwrite}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

function Body({
  conflict,
  change,
  model,
  total,
  busy,
  error,
  titleId,
  onReload,
  onOverwrite,
  onClose,
}: {
  conflict: ConflictResponse
  change: RowChange | null
  model: RowTable | null
  total: number
  busy: boolean
  error?: string | null
  titleId: string
  onReload: (conflict: ConflictResponse) => void
  onOverwrite: (conflict: ConflictResponse) => void
  onClose: () => void
}) {
  const reloadId = useId()
  useEffect(() => {
    // The safe choice has the focus; the dialog is already open one frame later.
    const frame = requestAnimationFrame(() => document.getElementById(reloadId)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const target = change && change.op !== 'insert' ? change.targets[conflict.index] : undefined
  const set = change && change.op === 'update' ? change.set : undefined
  const columns: RowColumn[] = (model?.columns ?? []).filter((c) =>
    conflict.changed.includes(c.name),
  )
  const names = columns.length > 0 ? columns.map((c) => c.name) : conflict.changed
  const rolledBack = conflict.outcomes.filter((o) => o.status === 'rolled-back').length
  const applied = conflict.outcomes.filter((o) => o.status === 'applied').length

  return (
    <div className="flex max-h-[calc(100dvh-32px)] flex-col">
      <header className="shrink-0 px-6 pt-5 pb-3">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
          <TriangleAlert size={16} className="text-[var(--pill-warning-ink)]" aria-hidden />
          {t('rows.dialog.conflict.title')}
        </h2>
        <p className="text-sm text-muted">
          {total > 1
            ? t('rows.dialog.conflict.bodyBulk', { n: conflict.index + 1, total })
            : t('rows.dialog.conflict.body')}
        </p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{t('rows.dialog.conflict.caption')}</caption>
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="w-1/5 pr-3 pb-1.5 font-medium">
                {t('rows.dialog.conflict.column')}
              </th>
              <th scope="col" className="pr-3 pb-1.5 font-medium">
                {t('rows.dialog.conflict.saw')}
              </th>
              <th scope="col" className="pr-3 pb-1.5 font-medium">
                {t('rows.dialog.conflict.now')}
              </th>
              {set && (
                <th scope="col" className="pb-1.5 font-medium">
                  {t('rows.dialog.conflict.want')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const index = conflict.columns.indexOf(name)
              const saw = target?.old[name]
              const want = wantText(set?.[name])
              return (
                <tr key={name} className="align-top">
                  <th scope="row" className="py-2 pr-3 text-left font-medium break-words">
                    {name}
                  </th>
                  <td className="py-2 pr-3">
                    <Value text={guardText(saw) ?? null} digest={saw?.t === 'digest'} />
                  </td>
                  <td className="py-2 pr-3">
                    <Value text={cellText(conflict.current[index])} />
                  </td>
                  {set && <td className="py-2">{want ? <Value text={want.text} /> : null}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {(rolledBack > 0 || applied > 0) && (
          <p className="text-sm text-muted">
            {rolledBack > 0
              ? t('rows.dialog.conflict.rolledBack', { count: rolledBack })
              : t('rows.dialog.conflict.applied', { count: applied })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-raised px-6 py-3">
        <Button disabled={busy} onClick={onClose}>
          {t('rows.dialog.cancel')}
        </Button>
        <Button
          variant="outline"
          className="border-negative text-negative hover:bg-[var(--pill-negative-bg)]"
          disabled={busy || !change || change.op === 'insert'}
          onClick={() => onOverwrite(conflict)}
        >
          {busy ? t('rows.dialog.working') : t('rows.dialog.conflict.overwrite')}
        </Button>
        <Button id={reloadId} variant="primary" disabled={busy} onClick={() => onReload(conflict)}>
          {t('rows.dialog.conflict.reload')}
        </Button>
      </footer>
    </div>
  )
}

/** "This row no longer exists" (FR-ROW-005, SCN-044 step 4). */
export function GoneDialog({
  open,
  index,
  total,
  onClose,
}: {
  open: boolean
  index: number
  total: number
  onClose: () => void
}) {
  const titleId = useId()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className="w-[min(480px,calc(100vw-32px))]"
    >
      <div className="flex flex-col">
        <header className="px-6 pt-5 pb-3">
          <h2 id={titleId} className="text-base font-semibold">
            {t('rows.dialog.gone.title')}
          </h2>
          <p className="text-sm text-muted">
            {total > 1
              ? t('rows.dialog.gone.bodyBulk', { n: index + 1, total })
              : t('rows.dialog.gone.body')}
          </p>
        </header>
        <footer className="flex justify-end gap-2 bg-raised px-6 py-3">
          <Button variant="primary" onClick={onClose}>
            {t('rows.dialog.close')}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}
