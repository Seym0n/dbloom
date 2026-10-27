/** Polling of a job (FR-IO-001): progress is read, never pushed. */
import { useQuery } from '@tanstack/react-query'
import type { IoJob, JobState } from '~/server/io/types'
import { ioApi } from './api'

const TERMINAL: readonly JobState[] = [
  'done',
  'done_with_skips',
  'done_with_rejects',
  'failed',
  'cancelled',
]

export const isTerminal = (state: JobState | undefined): boolean =>
  state !== undefined && TERMINAL.includes(state)

/** True while the job still changes by itself; a paused job waits for the user and is not polled. */
export const isActive = (state: JobState | undefined): boolean =>
  state === undefined || state === 'queued' || state === 'running'

/** Quick at the start, calmer for long jobs (400 ms up to 2 s). */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 400
  if (elapsedMs < 30_000) return 1_000
  return 2_000
}

export function useJob(jobId: string | undefined) {
  return useQuery<IoJob>({
    queryKey: ['io', 'job', jobId],
    enabled: Boolean(jobId),
    queryFn: () => ioApi().getJob(jobId as string),
    refetchInterval: (query) => {
      const job = query.state.data
      if (!isActive(job?.state)) return false
      return pollDelay(Date.now() - (job?.startedAt ?? Date.now()))
    },
    // A just-finished job never changes again; keep it for the result view.
    staleTime: (query) => (isTerminal(query.state.data?.state) ? Infinity : 0),
    retry: 2,
  })
}
