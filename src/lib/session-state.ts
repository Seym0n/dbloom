import { useSyncExternalStore } from 'react'
import { QueryCache, QueryClient } from '@tanstack/react-query'
import { SESSION_ENDED } from './csrf'

let ended = false
const listeners = new Set<() => void>()

export function setSessionEnded(value: boolean) {
  if (ended === value) return
  ended = value
  listeners.forEach((l) => l())
}

export function useSessionEnded(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => ended,
    () => false,
  )
}

let lost = false
const lostListeners = new Set<() => void>()

/** The server cannot be reached (network error, not a 401): the session stays, the shell offers Retry. */
export function setConnectionLost(value: boolean) {
  if (lost === value) return
  lost = value
  lostListeners.forEach((l) => l())
}

export function useConnectionLost(): boolean {
  return useSyncExternalStore(
    (l) => {
      lostListeners.add(l)
      return () => lostListeners.delete(l)
    },
    () => lost,
    () => false,
  )
}

/** Fetch rejects with a `TypeError` when the server cannot be reached; an HTTP status, even 5xx, is not one. */
export const isNetworkError = (error: unknown) =>
  error instanceof TypeError && /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(error.message)

export const isSessionEnded = (error: unknown) =>
  error instanceof Error && error.message.includes(SESSION_ENDED)

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isSessionEnded(error)) setSessionEnded(true)
        else if (isNetworkError(error)) setConnectionLost(true)
      },
      // Any answer from the server means it is reachable again.
      onSuccess: () => setConnectionLost(false),
    }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: (count, error) => !isSessionEnded(error) && count < 1,
      },
    },
  })
}
