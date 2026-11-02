import { useRef, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'

export const tabId = (prefix: string, key: string) => `${prefix}-tab-${key}`
export const panelId = (prefix: string, key: string) => `${prefix}-panel-${key}`

/** Tab strip with roving focus and arrow keys; the caller renders the matching `role="tabpanel"` (see `panelId`). */
export function TabList<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idPrefix,
}: {
  label: string
  tabs: { key: T; label: string }[]
  value: T
  onChange: (key: T) => void
  idPrefix: string
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>())

  function onKeyDown(event: KeyboardEvent) {
    const index = tabs.findIndex((tab) => tab.key === value)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const key = tabs[next]!.key
    onChange(key)
    refs.current.get(key)?.focus()
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 rounded-[var(--radius-control)] bg-active p-1">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          ref={(node) => {
            if (node) refs.current.set(tab.key, node)
            else refs.current.delete(tab.key)
          }}
          id={tabId(idPrefix, tab.key)}
          role="tab"
          type="button"
          aria-selected={tab.key === value}
          aria-controls={panelId(idPrefix, tab.key)}
          tabIndex={tab.key === value ? 0 : -1}
          onClick={() => onChange(tab.key)}
          className={cn(
            'press h-8 flex-1 rounded-[var(--radius-control)] px-2 text-sm font-medium',
            tab.key === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
