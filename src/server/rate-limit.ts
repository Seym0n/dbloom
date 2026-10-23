/** Counts failures per key; a key with `max` failures inside `windowMs` is blocked until they age out. */
export class FailureLimiter {
  private failures = new Map<string, number[]>()

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length) this.failures.set(key, list)
    else this.failures.delete(key)
    return list
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.max
  }

  fail(key: string): void {
    const list = this.recent(key)
    list.push(this.now())
    this.failures.set(key, list)
  }

  reset(key: string): void {
    this.failures.delete(key)
  }
}
