/**
 * "Referencing rows" of one row (FR-ROW-014, DATA-ISS-112): one group per referencing table and column with
 * a count, a link to the filtered rows and an "Insert row" action with the foreign key preset.
 */
import { useEffect, useId, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { t } from '~/i18n'
import type { GuardValue, ReferencingGroup } from '~/server/rows/types'
import { describeRowsRefusal, formsApi } from './server-api-forms'

export type ReferencingRowsProps = {
  db: string
  table: string
  rowKey: Record<string, GuardValue>
  /** Real link to the referencing rows (new tab / ctrl-click work); built by the grid from structured fields. */
  hrefFor?: (group: ReferencingGroup) => string
  /** Plain click on a group (the grid opens the table in a tab). */
  onOpen?: (group: ReferencingGroup) => void
  /** Opens the insert form of the referencing table with the foreign key columns preset. */
  onInsert?: (group: ReferencingGroup) => void
  /** False on a read-only connection. */
  canInsert?: boolean
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; groups: ReferencingGroup[] }

const count = (g: ReferencingGroup) =>
  `${new Intl.NumberFormat('en-US').format(g.count)}${g.atLeast ? '+' : ''}`

export function ReferencingRowsPanel({
  db,
  table,
  rowKey,
  hrefFor,
  onOpen,
  onInsert,
  canInsert = true,
}: ReferencingRowsProps) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const signature = JSON.stringify(rowKey)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    formsApi()
      .referencingRows({ db, table, key: rowKey })
      .then((r) => live && setState({ status: 'ready', groups: r.groups }))
      .catch(
        (e: unknown) =>
          live && setState({ status: 'error', message: describeRowsRefusal(e).message }),
      )
    return () => {
      live = false
    }
    // `signature` stands for `rowKey`.
  }, [db, table, signature])

  if (state.status === 'loading') {
    return (
      <p className="text-sm text-muted" aria-busy="true">
        {t('rows.fk.ref.loading')}
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-negative">
        {state.message}
      </p>
    )
  }
  if (state.groups.length === 0)
    return <p className="text-sm text-muted">{t('rows.fk.ref.none')}</p>
  return (
    <ul className="flex flex-col gap-2" aria-label={t('rows.fk.ref.title')}>
      {state.groups.map((g) => {
        const name = `${g.table} (${g.columns.join(', ')})`
        const label = t('rows.fk.ref.group', { name, count: count(g) })
        return (
          <li
            key={`${g.db}.${g.table}.${g.fk}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-control)] bg-raised px-3 py-2"
          >
            {hrefFor ? (
              <a
                href={hrefFor(g)}
                className="min-w-0 flex-1 text-sm break-words underline-offset-2 hover:underline"
                onClick={(e) => {
                  if (onOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                    e.preventDefault()
                    onOpen(g)
                  }
                }}
              >
                {label}
              </a>
            ) : (
              <button
                type="button"
                className="min-w-0 flex-1 text-left text-sm break-words underline-offset-2 hover:underline"
                onClick={() => onOpen?.(g)}
              >
                {label}
              </button>
            )}
            {onInsert && (
              <Button
                disabled={!canInsert}
                aria-label={t('rows.fk.ref.insertNamed', { table: g.table })}
                onClick={() => onInsert(g)}
              >
                <Plus size={14} aria-hidden />
                {t('rows.fk.ref.insert')}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The panel in a dialog, as opened from a row's menu. */
export function ReferencingRowsDialog({
  open,
  onClose,
  ...panel
}: ReferencingRowsProps & { open: boolean; onClose: () => void }) {
  const titleId = useId()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="flex max-h-[calc(100dvh-32px)] flex-col">
        <header className="shrink-0 px-6 pt-5 pb-3">
          <h2 id={titleId} className="text-base font-semibold">
            {t('rows.fk.ref.title')}
          </h2>
          <p className="text-sm text-muted">{t('rows.fk.ref.body', { table: panel.table })}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          <ReferencingRowsPanel {...panel} />
        </div>
        <footer className="flex shrink-0 justify-end gap-2 bg-raised px-6 py-3">
          <Button onClick={onClose}>{t('rows.dialog.close')}</Button>
        </footer>
      </div>
    </Dialog>
  )
}
