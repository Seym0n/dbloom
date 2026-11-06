import { useEffect, useState } from 'react'
import { Check, Database, Hourglass, Pencil, TriangleAlert, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { t, tDynamic } from '~/i18n'
import { approvalLeft, cellView, settledBy, type Item, type ResultEvent } from '~/lib/assistant/logic'
import { cn } from '~/lib/utils'
import type { ScreenEvent } from '~/server/assistant/service'
import { RichText } from './rich-text'

type Ev<T extends ScreenEvent['type']> = Extract<ScreenEvent, { type: T }>

const card = 'rounded-[var(--radius-card)] border border-border bg-surface p-3 text-sm'

function SqlBlock({ sql }: { sql: string }) {
  return (
    <pre className="max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-raised p-2 font-mono text-xs" tabIndex={0}>
      {sql}
    </pre>
  )
}

/** One result as an inline table (real values, capped by the server); the caption names it for screen readers. */
export function ResultTable({ result }: { result: ResultEvent['result'] }) {
  if (result.columns.length === 0) return null
  return (
    <div role="region" aria-label={t('asst.result.table')} tabIndex={0} className="max-h-56 overflow-auto overscroll-contain rounded-[var(--radius-control)] border border-border">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-raised">
          <tr>
            {result.columns.map((c, i) => (
              <th key={i} scope="col" className="whitespace-nowrap border-b border-border px-2 py-1 font-medium">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r} className="odd:bg-surface even:bg-raised/40">
              {row.map((cell, c) => {
                const v = cellView(cell)
                return (
                  <td key={c} className={cn('max-w-[16rem] truncate whitespace-nowrap px-2 py-1 font-mono', v.kind === 'null' && 'italic text-faint')} title={v.text}>
                    {v.text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ResultCard({ e, onOpenSql }: { e: Ev<'result'>; onOpenSql: (db: string, sql: string) => void }) {
  if (!e.ok) {
    return (
      <div className={cn(card, 'border-[var(--pill-negative-ink)]')} role="group" aria-label={t('asst.result.title')}>
        <p className="flex items-center gap-2 font-medium text-[var(--pill-negative-ink)]">
          <TriangleAlert size={14} aria-hidden /> {t('asst.result.failed')}
        </p>
        {e.sql && <div className="mt-2"><SqlBlock sql={e.sql} /></div>}
        <p className="mt-2 break-words text-xs text-muted">{e.message}</p>
      </div>
    )
  }
  const affected = e.result.affectedRows
  const count = affected ?? e.result.rowCount
  return (
    <div className={cn(card, 'flex flex-col gap-2')} role="group" aria-label={t('asst.result.title')}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <Database size={14} aria-hidden /> {t('asst.result.title')}
        </p>
        <p className="text-xs text-muted">{affected !== undefined ? (count === 1 ? t('asst.result.affectedOne') : t('asst.result.affected', { count })) : count === 1 ? t('asst.result.row') : t('asst.result.rows', { count })}</p>
      </div>
      <SqlBlock sql={e.sql} />
      {affected === undefined && <ResultTable result={e.result} />}
      {e.result.truncated && <p className="text-xs text-muted">{t('asst.result.truncated')}</p>}
      {e.anonymizedColumns.length > 0 && <p className="text-xs text-muted">{t('asst.result.hidden', { columns: e.anonymizedColumns.join(', ') })}</p>}
      {e.modelSaw === 'metadata' && <p className="text-xs text-muted">{t('asst.result.metadata')}</p>}
      <div>
        <Button size="default" onClick={() => onOpenSql(e.db ?? '', e.sql)}>
          {t('asst.openSql')}
        </Button>
      </div>
    </div>
  )
}

/** The question before a call runs. Settled approvals stay in the log as a quiet line with their SQL. */
export function ApprovalCard({
  e,
  open,
  settled,
  onApprove,
  onDecline,
  onOpenSql,
}: {
  e: Ev<'approval'>
  open: boolean
  settled?: 'result' | 'refused' | 'denied'
  onApprove: () => void
  onDecline: () => void
  onOpenSql: (db: string, sql: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])
  const left = approvalLeft(e.expiresAt, now)
  const write = e.access === 'write'
  return (
    <div className={cn(card, 'flex flex-col gap-2', open && 'border-[var(--pill-warning-ink)] bg-[var(--pill-warning-bg)]')} role="group" aria-label={write ? t('asst.approval.write') : t('asst.approval.read')}>
      <p className="flex items-center gap-2 font-medium">
        {write ? <Pencil size={14} aria-hidden /> : <Hourglass size={14} aria-hidden />}
        {write ? t('asst.approval.write') : t('asst.approval.read')}
        {!open && settled && (
          <span className="ml-auto text-xs font-normal text-muted">{settled === 'denied' ? t('asst.settled.declined') : settled === 'result' ? t('asst.settled.approved') : t('asst.refused.title')}</span>
        )}
      </p>
      {e.purpose && <p className="text-xs text-muted">{t('asst.approval.purpose', { purpose: e.purpose })}</p>}
      <p className="text-xs text-muted">{e.db ? t('asst.approval.where', { db: e.db }) : t('asst.approval.noDb')}</p>
      <SqlBlock sql={e.sql} />
      {e.metadataOnly && <p className="text-xs">{t('asst.approval.metadata')}</p>}
      {write && open && <p className="text-xs text-muted">{t('asst.approval.write.note')}</p>}
      {open && (
        <>
          <p className="text-xs text-muted">{left ? t('asst.approval.left', { time: left }) : t('asst.approval.expired')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onApprove}>
              <Check size={14} aria-hidden />
              {t('asst.approve')}
            </Button>
            <Button onClick={onDecline}>
              <X size={14} aria-hidden />
              {t('asst.decline')}
            </Button>
            <Button variant="ghost" onClick={() => onOpenSql(e.db ?? '', e.sql)}>
              {t('asst.openSql')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function RefusedCard({ e, onOpenSql }: { e: Ev<'refused'>; onOpenSql: (db: string, sql: string) => void }) {
  return (
    <div className={cn(card, 'flex flex-col gap-2 border-dashed')} role="group" aria-label={t('asst.refused.title')}>
      <p className="flex items-center gap-2">
        <TriangleAlert size={14} aria-hidden className="flex-none" />
        {tDynamic(`asst.refused.${e.code}`, 'asst.refused.limit')}
      </p>
      {e.sql && <SqlBlock sql={e.sql} />}
      {e.sql && (
        <div>
          <Button onClick={() => onOpenSql(e.db ?? '', e.sql ?? '')}>{t('asst.openSql')}</Button>
        </div>
      )}
    </div>
  )
}

export type ItemHandlers = {
  items: Item[]
  openCallId: string | undefined
  onApprove: (callId: string) => void
  onDecline: (callId: string) => void
  onOpenSql: (db: string, sql: string) => void
}

/** One entry of the log. User text stays plain; the assistant's text goes through the safe Markdown. */
export function ItemView({ item, index, h }: { item: Item; index: number; h: ItemHandlers }) {
  switch (item.type) {
    case 'user':
      return (
        <li className="flex justify-end">
          <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[var(--radius-card)] bg-active px-3 py-2 text-sm">
            <span className="sr-only">{t('asst.you')}: </span>
            {item.text}
          </div>
        </li>
      )
    case 'assistant':
      if (!item.text) return null
      return (
        <li>
          <span className="sr-only">{t('asst.assistant')}: </span>
          <RichText text={item.text} />
        </li>
      )
    case 'step':
      return <li className="text-xs text-muted">{t('asst.step', { tables: item.tables.join(', '), db: item.db })}</li>
    case 'approval':
      return (
        <li>
          <ApprovalCard e={item} open={h.openCallId === item.callId} settled={settledBy(h.items, index)} onApprove={() => h.onApprove(item.callId)} onDecline={() => h.onDecline(item.callId)} onOpenSql={h.onOpenSql} />
        </li>
      )
    case 'result':
      return (
        <li>
          <ResultCard e={item} onOpenSql={h.onOpenSql} />
        </li>
      )
    case 'refused':
      return (
        <li>
          <RefusedCard e={item} onOpenSql={h.onOpenSql} />
        </li>
      )
    case 'denied':
      return <li className="text-xs text-muted">{t(`asst.denied.${item.reason}`)}</li>
    case 'error':
      return (
        <li role="alert" className="rounded-[var(--radius-card)] bg-[var(--pill-negative-bg)] px-3 py-2 text-sm text-[var(--pill-negative-ink)]">
          {tDynamic(`asst.error.${item.code}`, 'asst.api.unexpected')}
        </li>
      )
    case 'tool':
      return (
        <li className="rounded-[var(--radius-card)] border border-dashed border-border px-3 py-2 text-xs text-muted">
          {item.sql ? <code className="break-words font-mono">{item.sql}</code> : item.label}
          {item.outcome && <span> · {item.outcome}</span>}
          {item.rowCount !== null && item.rowCount !== undefined && <span> · {item.rowCount === 1 ? t('asst.result.row') : t('asst.result.rows', { count: item.rowCount })}</span>}
        </li>
      )
    default:
      return null
  }
}
