import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Dialog } from '~/components/ui/dialog'
import { TypedNameConfirm } from '~/components/structure/confirm-dialog'
import { ClassBadge } from '~/components/structure/class-badge'
import { t } from '~/i18n'
import { formatBytes } from './job-model'
import { kindsLine, totalOf } from './import-model'
import type { ImportAnalysis } from '~/server/io/types'

/**
 * Explicit confirmation before the first statement (FR-ISS-113, FR-IO-016): names server, database and file.
 * When the analysis says confirmRequired, the user also types the database (or server) name; the token that the
 * server issued travels with the start request.
 */
export function ImportConfirmDialog({
  open,
  analysis,
  server,
  db,
  table,
  typedName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean
  analysis: ImportAnalysis
  server: string
  db: string | undefined
  table: string | undefined
  typedName: string
  busy: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const hard = analysis.statements ? totalOf(analysis.statements.hardKinds) : 0
  const needsTyped = analysis.confirmRequired
  const tokenMissing = needsTyped && !analysis.confirmToken
  const ready = (!needsTyped || typed === typedName) && !tokenMissing && !busy
  const cancel = () => {
    setTyped('')
    onCancel()
  }
  const byClass = analysis.statements?.byClass
  const top = (byClass?.hard ?? 0) > 0 ? 'hard' : (byClass?.soft ?? 0) > 0 ? 'soft' : 'none'
  return (
    <Dialog open={open} onClose={() => !busy && cancel()} labelledBy="io-confirm-title">
      <form
        className="flex max-h-[calc(100dvh-32px)] flex-col gap-4 overflow-y-auto p-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) onConfirm()
        }}
      >
        <h2 id="io-confirm-title" className="text-base font-semibold">
          {t('io.confirm.title')}
        </h2>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">{t('io.confirm.server')}</dt>
          <dd className="truncate font-medium">{server}</dd>
          <dt className="text-muted">{t('io.confirm.database')}</dt>
          <dd className="truncate font-medium">{db ?? t('io.confirm.noDatabase')}</dd>
          {table && (
            <>
              <dt className="text-muted">{t('io.confirm.table')}</dt>
              <dd className="truncate font-medium">{table}</dd>
            </>
          )}
          <dt className="text-muted">{t('io.confirm.file')}</dt>
          <dd className="truncate font-medium" title={analysis.fileName}>
            {analysis.fileName} ({formatBytes(analysis.bytes)})
          </dd>
        </dl>
        {hard > 0 && analysis.statements && (
          <div className="flex flex-col gap-2 rounded-lg bg-[var(--pill-negative-bg)] p-3 text-[var(--pill-negative-ink)]">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert size={14} aria-hidden />
              {t('io.confirm.hard', { n: hard })}
            </p>
            <p className="text-sm">{kindsLine(analysis.statements.hardKinds)}</p>
            <p className="text-xs">{t('io.confirm.dataLoss')}</p>
          </div>
        )}
        {needsTyped && (
          <TypedNameConfirm name={typedName} value={typed} onChange={setTyped} disabled={busy} />
        )}
        {tokenMissing && (
          <p role="alert" className="text-sm text-negative">
            {t('io.confirm.noToken')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {analysis.statements && analysis.statements.total > 0 && (
            <span className="mr-auto flex items-center gap-2 text-xs text-muted">
              <ClassBadge value={top} />
              {t('io.confirm.statements', { n: analysis.statements.total.toLocaleString('en') })}
            </span>
          )}
          <Button type="button" disabled={busy} onClick={cancel}>
            {t('io.confirm.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {busy ? t('io.confirm.starting') : t('io.confirm.start')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
