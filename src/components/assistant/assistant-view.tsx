import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, MoreHorizontal, Plus, Send, Square, X } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { ActionsMenu, type MenuItem } from '~/components/ui/menu'
import { t, tDynamic } from '~/i18n'
import { openApproval } from '~/lib/assistant/logic'
import type { AssistantState } from '~/lib/assistant/use-assistant'
import { cn } from '~/lib/utils'
import { ItemView, type ItemHandlers } from './assistant-items'

export type ViewProps = {
  state: AssistantState
  variant: 'side' | 'modal'
  titleId: string
  draft: string
  onDraft: (text: string) => void
  /** Scroll position of the log, kept by the host so moving between the side and the dialog does not lose it. */
  scrollTop: { current: number }
  onToggleSize: () => void
  onClose: () => void
  onOpenSql: (db: string, sql: string) => void
}

function ModeSwitch({ state }: { state: AssistantState }) {
  const autoOk = state.status?.autoAllowed ?? false
  const hintId = useId()
  const modes = [
    { id: 'manual' as const, label: t('asst.mode.manual') },
    { id: 'auto' as const, label: t('asst.mode.auto') },
  ]
  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label={t('asst.mode')} aria-describedby={hintId} className="grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-raised p-1">
        {modes.map((m) => {
          const disabled = !state.currentId || state.run === 'running' || (m.id === 'auto' && !autoOk)
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={state.mode === m.id}
              disabled={disabled}
              title={m.id === 'auto' && !autoOk ? t('asst.mode.autoOff') : undefined}
              onClick={() => void state.setMode(m.id)}
              className={cn(
                'press h-7 rounded-[5px] px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
                state.mode === m.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <p id={hintId} className="text-xs text-muted">
        {!autoOk && state.mode === 'manual' ? `${t('asst.mode.manualHint')} ${t('asst.mode.autoOff')}` : state.mode === 'auto' ? t('asst.mode.autoHint') : t('asst.mode.manualHint')}
      </p>
    </div>
  )
}

function Header({ p }: { p: ViewProps }) {
  const { state } = p
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const selectId = useId()
  const menu: MenuItem[] = [
    {
      key: 'rename',
      label: t('asst.rename'),
      onSelect: () => {
        setName(state.title)
        setEditing(true)
      },
      disabled: !state.currentId,
    },
    { key: 'delete', label: t('asst.delete'), danger: true, onSelect: () => setConfirmDelete(true), disabled: !state.currentId },
  ]
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 pb-3 pt-2">
      <div className="flex h-10 items-center justify-between gap-2">
        <h2 id={p.titleId} className="text-base font-semibold">
          {t('asst.modalTitle')}
        </h2>
        <div className="flex items-center gap-1">
          <Button id="asst-size-toggle" variant="ghost" size="icon" aria-label={p.variant === 'side' ? t('asst.expand') : t('asst.collapse')} onClick={p.onToggleSize}>
            {p.variant === 'side' ? <Maximize2 size={16} aria-hidden /> : <Minimize2 size={16} aria-hidden />}
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('asst.close')} onClick={p.onClose}>
            <X size={16} aria-hidden />
          </Button>
        </div>
      </div>
      {state.status?.available && (
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            {t('asst.conversation')}
          </label>
          <select
            id={selectId}
            value={state.currentId ?? ''}
            onChange={(e) => e.target.value && void state.open(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border border-control bg-surface px-2 text-sm"
          >
            {!state.currentId && <option value="">{state.list.length === 0 ? t('asst.none') : t('asst.conversation')}</option>}
            {state.list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon" aria-label={t('asst.new')} onClick={() => void state.create()}>
            <Plus size={16} aria-hidden />
          </Button>
          <ActionsMenu label={t('asst.conversation')} items={menu} trigger={<MoreHorizontal size={16} aria-hidden />} />
        </div>
      )}
      {editing && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void state.rename(name)
            setEditing(false)
          }}
        >
          <label className="sr-only" htmlFor="asst-rename">
            {t('asst.renameLabel')}
          </label>
          <input id="asst-rename" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border border-control bg-surface px-2 text-sm" />
          <Button type="submit" variant="primary" disabled={name.trim() === ''}>
            {t('asst.renameSave')}
          </Button>
        </form>
      )}
      {confirmDelete && (
        <div role="alertdialog" aria-label={t('asst.deleteConfirm')} className="flex items-center gap-2 text-sm">
          <span className="flex-1">{t('asst.deleteConfirm')}</span>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmDelete(false)
              void state.remove()
            }}
          >
            {t('asst.deleteYes')}
          </Button>
          <Button onClick={() => setConfirmDelete(false)}>{t('asst.decline')}</Button>
        </div>
      )}
    </div>
  )
}

export function AssistantView(p: ViewProps) {
  const { state } = p
  const list = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const approval = openApproval(state.items, state.run)

  // back to where the log was when the panel moves between the side and the dialog
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = p.scrollTop.current
  }, [])
  // follow new entries unless the user scrolled up
  useEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [state.items.length, state.run])

  const handlers: ItemHandlers = {
    items: state.items,
    openCallId: approval?.callId,
    onApprove: (id) => void state.resolve(id, 'approve'),
    onDecline: (id) => void state.resolve(id, 'deny'),
    onOpenSql: p.onOpenSql,
  }

  const unavailable = state.status && !state.status.available
  const canSend = p.draft.trim() !== '' && state.run !== 'running'

  const submit = () => {
    if (!canSend) return
    const text = p.draft
    p.onDraft('')
    stick.current = true
    void state.send(text).then((ok) => {
      if (!ok) p.onDraft(text)
    })
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Header p={p} />
      {!state.status && !state.loadFailed && <p className="px-4 py-3 text-sm text-muted">{t('asst.loading')}</p>}
      {state.loadFailed && <p role="alert" className="px-4 py-3 text-sm text-[var(--pill-negative-ink)]">{t('asst.api.unexpected')}</p>}
      {unavailable && <p className="px-4 py-3 text-sm text-muted">{tDynamic(`asst.unavailable.${state.status!.reason}`, 'asst.unavailable.no-endpoint')}</p>}
      {state.status?.available && (
        <>
          <div className="flex flex-col gap-3 px-4 pt-3">
            {state.status.piiUnconfigured && <p className="rounded-[var(--radius-card)] bg-[var(--pill-warning-bg)] px-3 py-2 text-xs text-[var(--pill-warning-ink)]">{t('asst.unconfigured')}</p>}
            <ModeSwitch state={state} />
          </div>
          <div role="status" className="sr-only">
            {approval ? t('asst.approval.live') : ''}
          </div>
          <div
            ref={list}
            role="log"
            aria-label={state.title}
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget
              p.scrollTop.current = el.scrollTop
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
            className="mt-3 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
          >
            <ol className="flex min-w-0 flex-col gap-3 [&>li]:min-w-0">
            {state.items.length === 0 && <li className="text-sm text-muted">{t('asst.empty')}</li>}
            {state.items.map((item, i) => (
              <ItemView key={i} item={item} index={i} h={handlers} />
            ))}
            {state.run === 'running' && <li className="text-xs text-muted">{t('asst.working')}</li>}
            </ol>
          </div>
          {state.error && (
            <div role="alert" className="mx-4 mb-2 flex items-start justify-between gap-2 rounded-[var(--radius-card)] bg-[var(--pill-negative-bg)] px-3 py-2 text-sm text-[var(--pill-negative-ink)]">
              <span>{state.error}</span>
              <button type="button" aria-label={t('asst.close')} onClick={state.dismissError} className="flex-none">
                <X size={14} aria-hidden />
              </button>
            </div>
          )}
          <form
            className="flex items-stretch gap-2 border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <label htmlFor={`${p.titleId}-input`} className="sr-only">
              {t('asst.inputLabel')}
            </label>
            <textarea
              id={`${p.titleId}-input`}
              value={p.draft}
              rows={2}
              maxLength={8000}
              placeholder={t('asst.inputPlaceholder')}
              onChange={(e) => p.onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              className="min-h-10 flex-1 resize-none rounded-[var(--radius-control)] border border-control bg-surface px-3 py-2 text-sm placeholder:text-faint"
            />
            {state.run === 'running' ? (
              <Button type="button" className="h-auto self-stretch" onClick={() => void state.stop()}>
                <Square size={14} aria-hidden />
                {t('asst.stop')}
              </Button>
            ) : (
              <Button type="submit" variant="primary" className="h-auto self-stretch" disabled={!canSend}>
                <Send size={14} aria-hidden />
                {t('asst.send')}
              </Button>
            )}
          </form>
        </>
      )}
    </div>
  )
}
