import { isIPv6 } from 'node:net'
import { domainToASCII } from 'node:url'

export type TargetKey = { host: string; port: number; zone?: string; username: string }

/** One message for every cause, so the rules cannot be used to probe the network (SEC-TGT-018). */
export class InvalidTargetError extends Error {
  constructor() {
    super('Could not connect to the server')
    this.name = 'InvalidTargetError'
  }
}

const bad = () => new InvalidTargetError()
const FORBIDDEN = /[\s\u0000-\u001f\u007f/\@?#%]/
const DEFAULT_PORT = 3306

function parsePort(text: string): number {
  if (!/^[0-9]+$/.test(text)) throw bad()
  const port = Number(text)
  if (port < 1 || port > 65535) throw bad()
  return port
}

/** Splits `host`, `host:port`, `[v6]`, `[v6]:port` and bare IPv6; the port is `undefined` when absent. */
function splitHostPort(typed: string): { host: string; port?: string } {
  if (typed.startsWith('[')) {
    const end = typed.indexOf(']')
    if (end < 0) throw bad()
    const rest = typed.slice(end + 1)
    if (rest === '') return { host: typed.slice(1, end) }
    if (!rest.startsWith(':')) throw bad()
    return { host: typed.slice(1, end), port: rest.slice(1) }
  }
  const colons = typed.split(':').length - 1
  if (colons === 0) return { host: typed }
  if (colons === 1) {
    const i = typed.indexOf(':')
    return { host: typed.slice(0, i), port: typed.slice(i + 1) }
  }
  return { host: typed }
}

function normaliseIPv6(raw: string): { host: string; zone?: string } {
  const pct = raw.indexOf('%')
  const zoneRaw = pct >= 0 ? raw.slice(pct + 1) : undefined
  const addr = pct >= 0 ? raw.slice(0, pct) : raw
  if (zoneRaw !== undefined && !/^[A-Za-z0-9._~-]+$/.test(zoneRaw)) throw bad()
  if (!isIPv6(addr)) throw bad()
  let host: string
  try {
    host = new URL(`http://[${addr}]/`).hostname.slice(1, -1)
  } catch {
    throw bad()
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16)
    const lo = parseInt(mapped[2]!, 16)
    return { host: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}` }
  }
  return zoneRaw !== undefined ? { host, zone: `%${zoneRaw.toLowerCase()}` } : { host }
}

function normaliseHostName(raw: string): string {
  let host = raw.trim()
  if (host === '' || host.length > 253 || FORBIDDEN.test(host)) throw bad()
  host = host.toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host === '') throw bad()
  const labels = host.split('.')
  const last = labels[labels.length - 1]!
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(last)) {
    // Looks like an address: only four plain decimal parts without leading zeros are accepted.
    const strict =
      labels.length === 4 &&
      labels.every((l) => /^(0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255)
    if (!strict) throw bad()
    return host
  }
  const ascii = domainToASCII(host)
  if (ascii === '') throw bad()
  return ascii
}

/** The only function that builds a target key (DATA-TGT-095). `host` may carry the port. */
export function normaliseTarget(
  host: string,
  port: number | string | undefined,
  username: string,
): TargetKey {
  if (username === '') throw bad()
  const typed = host.trim()
  if (typed === '') throw bad()
  const split = splitHostPort(typed)
  const portText = port !== undefined && String(port) !== '' ? String(port) : split.port
  if (split.port !== undefined && port !== undefined && String(port) !== '') throw bad()
  if (portText === '') throw bad()
  const resolvedPort = portText === undefined ? DEFAULT_PORT : parsePort(portText)

  const user = username.normalize('NFC')
  if (split.host.includes(':')) {
    const v6 = normaliseIPv6(split.host)
    return { ...v6, port: resolvedPort, username: user }
  }
  return { host: normaliseHostName(split.host), port: resolvedPort, username: user }
}
