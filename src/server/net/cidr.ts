/** CIDR lists on top of `node:net` BlockList (SPEC/27 Q3: no extra dependency). IPv4-mapped IPv6 is normalised to IPv4. */
import { BlockList, isIP } from 'node:net'

export type Family = 'ipv4' | 'ipv6'

/** Lower case, no brackets, no zone id, no surrounding space. Returns null for anything that is not an IP literal. */
export function normaliseAddress(input: string | undefined | null): { address: string; family: Family } | null {
  if (typeof input !== 'string') return null
  let text = input.trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const family = isIP(text)
  if (family === 4) return { address: text, family: 'ipv4' }
  if (family !== 6) return null
  const mapped = mappedV4(text)
  return mapped ? { address: mapped, family: 'ipv4' } : { address: text, family: 'ipv6' }
}

/** `::ffff:1.2.3.4` and `::ffff:0102:0304` (and the longer all-zero spellings) become `1.2.3.4`. */
function mappedV4(v6: string): string | null {
  const groups = expandV6(v6)
  if (!groups) return null
  if (groups.slice(0, 5).some((g) => g !== 0) || groups[5] !== 0xffff) return null
  const hi = groups[6]!
  const lo = groups[7]!
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

function expandV6(v6: string): number[] | null {
  let text = v6
  const dot = text.lastIndexOf('.')
  if (dot !== -1) {
    const colon = text.lastIndexOf(':')
    const parts = text.slice(colon + 1).split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
    text = `${text.slice(0, colon + 1)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16))
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null
}

/** `10.0.0.0/8`, `::1/128` or a bare address (host route). A v4-mapped IPv6 network is read as IPv4. Null when invalid. */
export function parseCidrEntry(text: string): { address: string; family: Family; prefix: number } | null {
  const [addrText, prefixText, extra] = text.trim().split('/')
  if (extra !== undefined || !addrText) return null
  const addr = normaliseAddress(addrText)
  if (!addr) return null
  const bare = addrText.replace(/^\[|\]$/g, '').split('%')[0]!
  const mappedInput = addr.family === 'ipv4' && isIP(bare) === 6
  const max = addr.family === 'ipv4' ? 32 : 128
  if (prefixText === undefined) return { ...addr, prefix: max }
  if (!/^\d{1,3}$/.test(prefixText)) return null
  let prefix = Number(prefixText)
  if (mappedInput) {
    // ::ffff:a.b.c.d/N: the first 96 bits are the mapping.
    if (prefix < 96 || prefix > 128) return null
    prefix -= 96
  }
  return prefix > max ? null : { ...addr, prefix }
}

export class CidrList {
  readonly #list = new BlockList()
  readonly size: number

  constructor(entries: readonly string[]) {
    let n = 0
    for (const entry of entries) {
      const p = parseCidrEntry(entry)
      if (!p) throw new Error(`Invalid CIDR entry: ${entry}`)
      this.#list.addSubnet(p.address, p.prefix, p.family)
      n++
    }
    this.size = n
  }

  /** True when the address is inside any entry. Invalid input is never contained. */
  contains(address: string | undefined | null): boolean {
    const a = normaliseAddress(address)
    return a !== null && this.#list.check(a.address, a.family)
  }
}

/** Non-throwing parse for operator input. */
export function parseCidrList(entries: readonly string[]): CidrList | null {
  try {
    return new CidrList(entries)
  } catch {
    return null
  }
}

/** Loopback, RFC 1918, link-local and unique-local: what the legacy `DBLOOM_TRUST_PROXY=true` stands for (Q4). */
export const PRIVATE_RANGES = new CidrList([
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
])
