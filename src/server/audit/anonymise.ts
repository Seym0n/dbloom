import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

export type AnonymiseMode = 'off' | 'truncate' | 'hash'

/** IPv6 text to its eight 16-bit groups (handles `::` and a trailing dotted IPv4). */
function groupsOf(address: string): number[] | undefined {
  let a = address
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (v4) {
    const p = v4[1]!.split('.').map(Number)
    a = `${a.slice(0, -v4[1]!.length)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`
  }
  const [head = '', tail, extra] = a.split('::')
  if (extra !== undefined) return undefined
  const h = head === '' ? [] : head.split(':')
  const t = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? 0 : 8 - h.length - t.length
  if (fill < 0 || (tail === undefined && h.length !== 8)) return undefined
  const all = [...h, ...Array<string>(fill).fill('0'), ...t].map((x) => Number.parseInt(x, 16))
  return all.length === 8 && all.every((n) => Number.isInteger(n)) ? all : undefined
}

/** IPv4 to /24, IPv6 to /48 (SPEC/29 FR-AAU-009). Anything that is not an address becomes `unknown`. */
export function truncateAddress(address: string): string {
  const kind = isIP(address)
  if (kind === 4) return `${address.split('.').slice(0, 3).join('.')}.0`
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return truncateAddress(mapped[1]!)
    const g = groupsOf(address)
    if (g) return `${g[0]!.toString(16)}:${g[1]!.toString(16)}:${g[2]!.toString(16)}::`
  }
  return 'unknown'
}

let mode: AnonymiseMode = 'off'
let hashKey: Buffer | undefined

/** Server start: the mode and, for `hash`, the key (the `audit-ip` subkey of the server key; random per process without one). */
export function configureAnonymiser(next: AnonymiseMode, key?: Buffer): void {
  mode = next
  hashKey = key
}

export function anonymiseMode(): AnonymiseMode {
  return mode
}

/** The stored, exported and file-sink form of an address. The stdout line is never passed through here. */
export function anonymise(address: string | null | undefined): string | null {
  if (address === null || address === undefined || address === '') return null
  if (mode === 'off') return address
  if (mode === 'truncate') return truncateAddress(address)
  return `h:${createHmac('sha256', (hashKey ??= randomBytes(32))).update(address).digest('hex').slice(0, 16)}`
}
