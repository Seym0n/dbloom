import { useEffect, useState } from 'react'

/** Seconds left until `until` (epoch ms); 0 when there is no wait. Pure, for tests. */
export function secondsLeft(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000))
}

/** Ticks while a wait is running (throttle message, FR-AUT-007). */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [until])
  return secondsLeft(until, now)
}
