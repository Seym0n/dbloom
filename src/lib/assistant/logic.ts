/**
 * Pure helpers of the assistant sidebar (SPEC/34 task 5): which approval is open, how a cell and a result look, how a
 * conversation log grows and how fast to poll. No React, no browser APIs.
 */
import type { Cell } from '~/server/db/rows'
import type { DisplayItem, RunStatus, ScreenEvent } from '~/server/assistant/service'

export type Item = DisplayItem
export type ApprovalEvent = Extract<ScreenEvent, { type: 'approval' }>
export type ResultEvent = Extract<ScreenEvent, { type: 'result'; ok: true }>

export const ITEMS_MAX = 600

export function appendItems(items: Item[], events: Item[]): Item[] {
  if (events.length === 0) return items
  const all = [...items, ...events]
  return all.length > ITEMS_MAX ? all.slice(all.length - ITEMS_MAX) : all
}

/** The approval the user can answer now: the last one, while the conversation waits and nothing settled it. */
export function openApproval(items: Item[], status: RunStatus): ApprovalEvent | undefined {
  if (status !== 'awaiting_approval') return undefined
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]!
    if (e.type === 'approval') return e
    if ((e.type === 'result' || e.type === 'refused' || e.type === 'denied') && 'callId' in e) {
      // a later settlement of an earlier call does not close this one: look for an approval of the same call below
      continue
    }
  }
  return undefined
}

/** Whether an approval card is settled (a result, a refusal or a denial with its call id came after it). */
export function settledBy(items: Item[], index: number): 'result' | 'refused' | 'denied' | undefined {
  const a = items[index]
  if (!a || a.type !== 'approval') return undefined
  for (let i = index + 1; i < items.length; i++) {
    const e = items[i]!
    if ((e.type === 'result' || e.type === 'refused' || e.type === 'denied') && e.callId === a.callId) return e.type
  }
  return undefined
}

export type CellView = { kind: 'null' | 'text' | 'cut' | 'binary'; text: string }

export function cellView(cell: Cell): CellView {
  if (cell === null) return { kind: 'null', text: 'NULL' }
  if (typeof cell === 'string') return { kind: 'text', text: cell }
  if ('cut' in cell) return { kind: 'cut', text: `${cell.cut}…` }
  return { kind: 'binary', text: `[binary ${cell.size} B]` }
}

/** Seconds a client waits before the next poll: quick while the assistant works, none while it waits for the user. */
export function pollDelayMs(status: RunStatus, quietPolls: number): number | null {
  if (status !== 'running') return null
  if (quietPolls < 5) return 600
  if (quietPolls < 20) return 1200
  return 2500
}

/** Time left on an approval as `m:ss`, or null once it ran out. */
export function approvalLeft(expiresAt: number, now: number): string | null {
  const s = Math.floor((expiresAt - now) / 1000)
  if (s <= 0) return null
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const TITLE_FALLBACK = 'New conversation'
