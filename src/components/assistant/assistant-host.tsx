import { useEffect, useRef, useState } from 'react'
import { Dialog } from '~/components/ui/dialog'
import { useAssistant } from '~/lib/assistant/use-assistant'
import { AssistantView } from './assistant-view'

/**
 * The assistant (UI-TGT-001): a panel on the right that can grow into a large dialog and come back with the same
 * conversation, scroll position and draft. All state lives here and in `useAssistant`; the view is rebuilt in the other
 * place. The dialog is the native one: focus moves in, Escape closes it, the page behind is inert; focus goes back to the
 * size button when it closes.
 */
export function AssistantHost({ onClose, onOpenSql }: { onClose: () => void; onOpenSql: (db: string, sql: string) => void }) {
  const state = useAssistant()
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const scrollTop = useRef(0)
  const moved = useRef(false)

  // after the panel moved, the size button of the new place takes the focus
  useEffect(() => {
    if (!moved.current) return
    document.getElementById('asst-size-toggle')?.focus()
  }, [expanded])

  const toggle = () => {
    moved.current = true
    setExpanded((v) => !v)
  }
  const open = (db: string, sql: string) => {
    // a statement opened from the large dialog is looked at in the main area: the dialog goes back to the side first
    setExpanded(false)
    onOpenSql(db, sql)
  }
  const view = (variant: 'side' | 'modal', titleId: string) => (
    <AssistantView state={state} variant={variant} titleId={titleId} draft={draft} onDraft={setDraft} scrollTop={scrollTop} onToggleSize={toggle} onClose={onClose} onOpenSql={open} />
  )

  if (expanded) {
    return (
      <Dialog open onClose={() => toggle()} labelledBy="asst-modal-title" className="h-[min(780px,calc(100dvh-32px))] w-[min(960px,calc(100vw-32px))]">
        <div className="h-full">{view('modal', 'asst-modal-title')}</div>
      </Dialog>
    )
  }
  return (
    <aside aria-labelledby="asst-side-title" className="fixed inset-0 z-30 flex min-h-0 flex-col overflow-hidden bg-surface md:static md:z-auto md:w-[var(--assistant-width)] md:min-w-0 md:max-w-full md:shrink-0 md:overflow-hidden md:border-l md:border-border">
      {view('side', 'asst-side-title')}
    </aside>
  )
}
