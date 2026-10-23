import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { Config } from './config'
import type { TargetKey } from './target'

const always = new BlockList()
for (const [net, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const)
  always.addSubnet(net, prefix, family)

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

const priv = new BlockList()
for (const [net, prefix, family] of [
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
] as const)
  priv.addSubnet(net, prefix, family)

export class TargetDeniedError extends Error {
  constructor() {
    super('Could not connect to the server')
    this.name = 'TargetDeniedError'
  }
}

function unmap(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)
  return m ? m[1]! : addr
}

export function isAddressAllowed(
  addr: string,
  policy: Pick<Config, 'allowLoopback' | 'allowPrivate'>,
): boolean {
  const a = unmap(addr)
  const kind = isIP(a)
  if (kind === 0) return false
  const family = kind === 6 ? 'ipv6' : 'ipv4'
  if (always.check(a, family)) return false
  if (loopback.check(a, family)) return policy.allowLoopback
  if (priv.check(a, family)) return policy.allowPrivate
  return true
}

export function isTargetListed(target: TargetKey, config: Pick<Config, 'allowedTargets'>): boolean {
  if (config.allowedTargets.length === 0) return true
  return config.allowedTargets.some((entry) => {
    const i = entry.lastIndexOf(':')
    const host = i > 0 ? entry.slice(0, i) : entry
    const port = i > 0 ? Number(entry.slice(i + 1)) : 3306
    return host === target.host && port === target.port
  })
}

/** Resolves once and validates every returned address (SEC-TGT-031). Returns the address to connect to. */
export async function resolveAllowedAddress(
  target: TargetKey,
  config: Config,
  resolver: (host: string) => Promise<string[]> = async (h) =>
    (await lookup(h, { all: true })).map((r) => r.address),
): Promise<string> {
  if (!isTargetListed(target, config)) throw new TargetDeniedError()
  let addresses: string[]
  try {
    addresses = isIP(target.host) ? [target.host] : await resolver(target.host)
  } catch {
    throw new TargetDeniedError()
  }
  if (addresses.length === 0) throw new TargetDeniedError()
  for (const a of addresses) if (!isAddressAllowed(a, config)) throw new TargetDeniedError()
  return unmap(addresses[0]!)
}
