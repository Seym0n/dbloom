/** Construction of the `Secret` wrapper (types.ts line 34): package A ships `secret(value)` / `reveal(s)`. */
import type { Secret } from './types'

const brand = Symbol('secret')
const PLACEHOLDER = '[secret]'
const envelopes = new WeakSet<object>()

/**
 * Wraps a secret-bearing string. The wrapper's `toJSON` and `toString` return `[secret]`, so a slip into a
 * log, an exception or a response shows in tests (section 9). The value is only reachable through `reveal`.
 */
export function secret(value: string): Secret<string> {
  if (typeof value !== 'string') throw new TypeError('secret() holds a string')
  const envelope = Object.freeze({
    toJSON: (): '[secret]' => PLACEHOLDER as '[secret]',
    toString: (): '[secret]' => PLACEHOLDER as '[secret]',
    [brand]: value,
  })
  envelopes.add(envelope)
  return envelope as unknown as Secret<string>
}

/** Machine use only, never a log call or a string template (section 9). */
export function reveal(s: Secret<string>): string {
  if (!envelopes.has(s as unknown as object)) throw new Error('reveal() needs a Secret from secret()')
  return (s as unknown as { readonly [brand]: string })[brand]
}
