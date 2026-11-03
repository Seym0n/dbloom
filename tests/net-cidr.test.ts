import { describe, expect, it } from 'vitest'
import { CidrList, normaliseAddress, parseCidrEntry, parseCidrList, PRIVATE_RANGES } from '~/server/net/cidr'

describe('CidrList', () => {
  it('10.0.0.0/8 matches 10.x and not 138.1.2.3', () => {
    const l = new CidrList(['10.0.0.0/8'])
    expect(l.contains('10.1.2.3')).toBe(true)
    expect(l.contains('10.255.255.255')).toBe(true)
    expect(l.contains('138.1.2.3')).toBe(false)
    expect(l.contains('11.0.0.1')).toBe(false)
  })

  it.each([
    ['0.0.0.0/0', '8.8.8.8', true],
    ['0.0.0.0/0', '::1', false],
    ['128.0.0.0/1', '200.1.1.1', true],
    ['128.0.0.0/1', '100.1.1.1', false],
    ['192.168.1.0/24', '192.168.1.200', true],
    ['192.168.1.0/24', '192.168.2.1', false],
    ['192.168.1.4/31', '192.168.1.5', true],
    ['192.168.1.4/31', '192.168.1.6', false],
    ['192.168.1.4/32', '192.168.1.4', true],
    ['192.168.1.4/32', '192.168.1.5', false],
    ['::/0', '2001:db8::1', true],
    ['2001:db8:1:2::/64', '2001:db8:1:2:ffff::1', true],
    ['2001:db8:1:2::/64', '2001:db8:1:3::1', false],
    ['::1/128', '::1', true],
    ['::1/128', '::2', false],
  ])('%s contains %s = %s', (cidr, addr, expected) => {
    expect(new CidrList([cidr]).contains(addr)).toBe(expected)
  })

  it('bare address is a host route', () => {
    expect(new CidrList(['10.0.0.7']).contains('10.0.0.7')).toBe(true)
    expect(new CidrList(['10.0.0.7']).contains('10.0.0.8')).toBe(false)
  })

  it('normalises v4-mapped IPv6 on both sides', () => {
    const l = new CidrList(['10.0.0.0/8'])
    expect(l.contains('::ffff:10.1.2.3')).toBe(true)
    expect(l.contains('::ffff:0a01:0203')).toBe(true)
    expect(l.contains('::ffff:138.1.2.3')).toBe(false)
    expect(new CidrList(['::ffff:10.0.0.0/104']).contains('10.9.9.9')).toBe(true)
    expect(normaliseAddress('::FFFF:1.2.3.4')).toEqual({ address: '1.2.3.4', family: 'ipv4' })
    expect(normaliseAddress('[::1]')).toEqual({ address: '::1', family: 'ipv6' })
    expect(normaliseAddress('fe80::1%eth0')).toEqual({ address: 'fe80::1', family: 'ipv6' })
  })

  it.each(['', 'abc', '1.2.3', '1.2.3.4/33', '::/129', '1.2.3.4/-1', '1.2.3.4/8/8', '1.2.3.4/x', '::ffff:1.2.3.4/64'])(
    'rejects %j',
    (text) => {
      expect(parseCidrEntry(text)).toBeNull()
      expect(parseCidrList([text])).toBeNull()
    },
  )

  it('invalid address is never contained', () => {
    const l = new CidrList(['0.0.0.0/0', '::/0'])
    for (const a of ['unknown', '', '1.2.3', undefined, null, '1.2.3.4:80']) expect(l.contains(a)).toBe(false)
  })

  it('private ranges', () => {
    for (const a of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.9', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(PRIVATE_RANGES.contains(a)).toBe(true)
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '138.1.2.3', '2001:db8::1']) expect(PRIVATE_RANGES.contains(a)).toBe(false)
  })
})
