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

export const isSessionEnded = (error: unknown) =>
  error instanceof Error && error.message.includes(SESSION_ENDED)

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isSessionEnded(error)) setSessionEnded(true)
      },
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
