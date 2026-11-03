import { describe, expect, it } from 'vitest'
import { clientAddress, isTrustedPeer, type NetConfig } from '~/server/net/client-address'

const cfg = (over: Partial<NetConfig> = {}): NetConfig => ({ trustedProxies: ['10.0.0.0/8'], trustProxyLegacy: false, proxyHops: 0, ...over })
const h = (...xff: string[]) => {
  const headers = new Headers()
  for (const v of xff) headers.append('x-forwarded-for', v)
  return headers
}

describe('clientAddress', () => {
  it('untrusted peer: header ignored, peer returned', () => {
    expect(clientAddress('203.0.113.9', h('1.2.3.4'), cfg())).toBe('203.0.113.9')
    expect(clientAddress('138.1.2.3', h('10.0.0.5, 1.1.1.1'), cfg())).toBe('138.1.2.3')
  })

  it('no trusted proxies configured: never trusts the header', () => {
    expect(clientAddress('10.0.0.1', h('1.2.3.4'), cfg({ trustedProxies: [] }))).toBe('10.0.0.1')
  })

  it('trusted peer without header gives the peer', () => {
    expect(clientAddress('10.0.0.1', h(), cfg())).toBe('10.0.0.1')
  })

  it('trusted peer: rightmost untrusted entry, not the spoofed leftmost', () => {
    expect(clientAddress('10.0.0.1', h('6.6.6.6, 203.0.113.9'), cfg())).toBe('203.0.113.9')
    expect(clientAddress('10.0.0.1', h('203.0.113.9'), cfg())).toBe('203.0.113.9')
  })

  it('chained proxies: trusted entries on the right are skipped', () => {
    expect(clientAddress('10.0.0.1', h('6.6.6.6, 203.0.113.9, 10.0.0.2, 10.0.0.3'), cfg())).toBe('203.0.113.9')
  })

  it('multiple header lines are combined in order', () => {
    expect(clientAddress('10.0.0.1', h('6.6.6.6', '203.0.113.9, 10.0.0.2'), cfg())).toBe('203.0.113.9')
    // a client-sent first line must not win over the proxy-appended last line
    expect(clientAddress('10.0.0.1', h('1.1.1.1', '2.2.2.2'), cfg())).toBe('2.2.2.2')
  })

  it('v4-mapped peer and entries', () => {
    expect(clientAddress('::ffff:10.0.0.1', h('203.0.113.9'), cfg())).toBe('203.0.113.9')
    expect(clientAddress('::ffff:203.0.113.9', h('1.2.3.4'), cfg())).toBe('203.0.113.9')
    expect(clientAddress('10.0.0.1', h('::ffff:203.0.113.9'), cfg())).toBe('203.0.113.9')
    expect(clientAddress('10.0.0.1', h('::ffff:10.0.0.9, 203.0.113.9'), cfg())).toBe('203.0.113.9')
  })

  it('IPv6 clients and proxies', () => {
    const c = cfg({ trustedProxies: ['fd00::/8'] })
    expect(clientAddress('fd00::1', h('2001:DB8::5'), c)).toBe('2001:db8::5')
    expect(clientAddress('fd00::1', h('[2001:db8::5]'), c)).toBe('2001:db8::5')
  })

  it.each(['garbage', '1.2.3.4, nope', '1.2.3.4:5678', ',', '1.2.3.4,,5.6.7.8', 'unknown'])('malformed %j gives unknown', (v) => {
    expect(clientAddress('10.0.0.1', h(v), cfg())).toBe('unknown')
  })

  it('missing or invalid peer gives unknown', () => {
    expect(clientAddress(undefined, h('1.2.3.4'), cfg())).toBe('unknown')
    expect(clientAddress('', h(), cfg())).toBe('unknown')
    expect(clientAddress('not-an-ip', h(), cfg())).toBe('unknown')
  })

  it('all entries trusted: the peer, never the leftmost', () => {
    expect(clientAddress('10.0.0.1', h('10.9.9.9, 10.0.0.2'), cfg())).toBe('10.0.0.1')
  })

  describe('hop count', () => {
    it('takes the entry that many positions from the right', () => {
      const c = cfg({ proxyHops: 1 })
      expect(clientAddress('10.0.0.1', h('6.6.6.6, 203.0.113.9'), c)).toBe('203.0.113.9')
      const c2 = cfg({ proxyHops: 2 })
      expect(clientAddress('10.0.0.1', h('6.6.6.6, 203.0.113.9, 10.0.0.2'), c2)).toBe('203.0.113.9')
    })
    it('too few entries gives unknown; untrusted peer unaffected', () => {
      expect(clientAddress('10.0.0.1', h('203.0.113.9'), cfg({ proxyHops: 2 }))).toBe('unknown')
      expect(clientAddress('203.0.113.9', h('1.2.3.4'), cfg({ proxyHops: 1 }))).toBe('203.0.113.9')
    })
  })

  describe('legacy DBLOOM_TRUST_PROXY=true', () => {
    const legacy = cfg({ trustedProxies: [], trustProxyLegacy: true })
    it('trusts any private or loopback peer', () => {
      for (const p of ['127.0.0.1', '10.1.1.1', '172.20.0.2', '192.168.5.5', '::1', 'fd12::1']) {
        expect(clientAddress(p, h('203.0.113.9'), legacy)).toBe('203.0.113.9')
      }
    })
    it('does not trust a public peer', () => {
      expect(clientAddress('138.1.2.3', h('203.0.113.9'), legacy)).toBe('138.1.2.3')
    })
    it('private entries are skipped, public one wins from the right', () => {
      expect(clientAddress('10.0.0.1', h('6.6.6.6, 203.0.113.9, 192.168.1.1'), legacy)).toBe('203.0.113.9')
    })
    it('isTrustedPeer', () => {
      expect(isTrustedPeer('10.0.0.1', legacy)).toBe(true)
      expect(isTrustedPeer('8.8.8.8', legacy)).toBe(false)
      expect(isTrustedPeer('10.0.0.1', cfg({ trustedProxies: [], trustProxyLegacy: false }))).toBe(false)
    })
  })
})
