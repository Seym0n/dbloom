import { useCallback, useRef, useState } from 'react'
import { describeError, type ShownError } from '~/lib/auth/messages'

/** Runs one async action at a time and keeps `busy` and the last error for the form that started it. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)
  const running = useRef(false)

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error?: ShownError }> => {
    if (running.current) return { ok: false }
    running.current = true
    setBusy(true)
    setError(null)
    try {
      return { ok: true, value: await action() }
    } catch (e) {
      const shown = describeError(e)
      setError(shown)
      return { ok: false, error: shown }
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])

  return { run, busy, error, setError, clear: () => setError(null) }
}
