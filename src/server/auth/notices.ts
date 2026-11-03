/**
 * Security notices raised by the sign-in path (SPEC/30 FR-AUS-001, 002): a burst of failed attempts for one account or
 * one address, and a completed sign-in from a network the account has not used lately. Information only: a detector
 * error never reaches the sign-in (`guard`), and nothing here throttles or refuses.
 */
import { anonymise, truncateAddress } from '../audit/anonymise'
import { notify } from './links'
import type { AccountStore } from './types'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** Entries of the burst counter kept at most; the oldest key goes first (a spray over many names cannot grow it without bound). */
export const COUNTER_CAP = 10_000
const LOG_EVERY_MS = 60_000

export type NoticeSettings = { noticeBurstFailures: number; noticeBurstMinutes: number; noticeLocationDays: number }

export type NoticeDetector = {
  /** A failed sign-in step. `userId` is set when the account exists; `address` is unknown inside a second-factor step. */
  failedAttempt(subject: { userId?: string; username?: string }, address?: string): void
  /** A fully completed sign-in (session state `full`). */
  completedSignIn(user: { id: string; username: string }, address: string | undefined): void
}

type Counter = { times: number[]; noticedAt?: number }

export function createNoticeDetector(d: {
  store: AccountStore
  settings: () => NoticeSettings
  now?: () => number
  onError?: (error: unknown) => void
}): NoticeDetector {
  const now = () => (d.now ?? Date.now)()
  const counters = new Map<string, Counter>()
  let lastLogged = 0

  const guard = (fn: () => void) => {
    try {
      fn()
    } catch (error) {
      if (d.onError) d.onError(error)
      else if (now() - lastLogged >= LOG_EVERY_MS) {
        lastLogged = now()
        process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg: 'notice.detector_failed', error: error instanceof Error ? error.name : 'error' })}\n`)
      }
    }
  }

  function prune(at: number, windowMs: number) {
    for (const [key, c] of counters) {
      c.times = c.times.filter((t) => at - t < windowMs)
      if (c.times.length === 0 && (c.noticedAt === undefined || at - c.noticedAt >= windowMs)) counters.delete(key)
    }
    while (counters.size > COUNTER_CAP) counters.delete(counters.keys().next().value as string)
  }

  /** True when this failure completes a burst that has not been announced inside its window. */
  function count(key: string, at: number, threshold: number, windowMs: number): number | undefined {
    const c = counters.get(key) ?? { times: [] }
    c.times = c.times.filter((t) => at - t < windowMs)
    c.times.push(at)
    counters.delete(key)
    counters.set(key, c) // most recently used last, so the cap drops the stalest
    if (c.times.length >= threshold && (c.noticedAt === undefined || at - c.noticedAt >= windowMs)) {
      c.noticedAt = at
      return c.times.length
    }
    return undefined
  }

  return {
    failedAttempt(subject, address) {
      guard(() => {
        const s = d.settings()
        const at = now()
        const windowMs = s.noticeBurstMinutes * MINUTE_MS
        prune(at, windowMs)
        const minutes = s.noticeBurstMinutes
        if (subject.userId) {
          const n = count(`acct:${subject.userId}`, at, s.noticeBurstFailures, windowMs)
          if (n !== undefined) notify(d.store, 'failed_burst', at, [], `account ${subject.username ?? subject.userId}: ${n} failed sign-in steps in ${minutes} min`.slice(0, 200))
        }
        if (address) {
          const prefix = truncateAddress(address)
          if (prefix !== 'unknown') {
            const n = count(`addr:${prefix}`, at, s.noticeBurstFailures, windowMs)
            if (n !== undefined) notify(d.store, 'failed_burst', at, [], `address ${anonymise(prefix) ?? prefix}: ${n} failed sign-in steps in ${minutes} min`.slice(0, 200))
          }
        }
      })
    },

    completedSignIn(user, address) {
      guard(() => {
        if (!address) return
        const prefix = truncateAddress(address)
        if (prefix === 'unknown') return
        const at = now()
        const windowMs = d.settings().noticeLocationDays * DAY_MS
        const seen = d.store.getSeenLocation(user.id, prefix)
        const first = seen === undefined && d.store.countSeenLocations(user.id) === 0
        const fresh = seen !== undefined && at - seen < windowMs
        d.store.upsertSeenLocation(user.id, prefix, at)
        if (!fresh && !first) notify(d.store, 'new_location', at, [], `account ${user.username} from ${anonymise(prefix) ?? prefix}`.slice(0, 200))
      })
    },
  }
}
