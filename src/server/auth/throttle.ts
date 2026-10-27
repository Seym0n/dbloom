import type { Throttle, ThrottleKey } from './types'
type Entry = { failures: number; last: number; blockedUntil: number }
export class BackoffThrottle implements Throttle {
  private entries = new Map<ThrottleKey, Entry>()
  constructor(private maxFailures = 5, private windowMs = 15 * 60_000, private capMs = 15 * 60_000, private now = Date.now) {}
  delayMs(key: ThrottleKey) { const e=this.entries.get(key); if(!e)return 0; const n=this.now(); if(n-e.last>this.windowMs){this.entries.delete(key);return 0} return Math.max(0,e.blockedUntil-n) }
  fail(key: ThrottleKey) { const n=this.now(); let e=this.entries.get(key); if(!e || n-e.last>this.windowMs)e={failures:0,last:n,blockedUntil:0}; e.failures++; e.last=n; if(e.failures>=this.maxFailures)e.blockedUntil=n+Math.min(this.capMs,1000*2**(e.failures-this.maxFailures)); this.entries.set(key,e) }
  reset(key: ThrottleKey) { this.entries.delete(key) }
}
export const createThrottle = (options?: ConstructorParameters<typeof BackoffThrottle>) => new BackoffThrottle(...(options ?? []))
