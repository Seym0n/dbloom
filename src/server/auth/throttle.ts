import type { Throttle, ThrottleKey } from './types'
type Entry = { failures: number; last: number; blockedUntil: number }
const MAX_ENTRIES = 10_000
export class BackoffThrottle implements Throttle {
  private entries = new Map<ThrottleKey, Entry>()
  constructor(private maxFailures = 5, private windowMs = 15 * 60_000, private capMs = 15 * 60_000, private now = Date.now) {}
  delayMs(key: ThrottleKey) { const e=this.entries.get(key); if(!e)return 0; const n=this.now(); if(n-e.last>this.windowMs){this.entries.delete(key);return 0} return Math.max(0,e.blockedUntil-n) }
  fail(key: ThrottleKey) { const n=this.now(); if(this.entries.size>=MAX_ENTRIES)this.prune(n); let e=this.entries.get(key); if(!e || n-e.last>this.windowMs)e={failures:0,last:n,blockedUntil:0}; e.failures++; e.last=n; if(e.failures>=this.maxFailures)e.blockedUntil=n+Math.min(this.capMs,1000*2**(e.failures-this.maxFailures)); this.entries.set(key,e) }
  reset(key: ThrottleKey) { this.entries.delete(key) }
  size() { return this.entries.size }
  /** Drops entries past their window; if the map is still full of live keys, drops the oldest ones (keys are attacker-chosen, so the map must stay bounded). */
  private prune(n: number) {
    for (const [k,e] of this.entries) if (n-e.last>this.windowMs) this.entries.delete(k)
    for (const k of this.entries.keys()) { if (this.entries.size<MAX_ENTRIES) break; this.entries.delete(k) }
  }
}
export const createThrottle = (options?: ConstructorParameters<typeof BackoffThrottle>) => new BackoffThrottle(...(options ?? []))
