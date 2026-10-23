import { describe, expect, test } from 'vitest'
import { normaliseTarget, InvalidTargetError } from '~/server/target'

const n = (host: string, port?: number | string, user = 'root') => normaliseTarget(host, port, user)

describe('normaliseTarget (DATA-TGT-095)', () => {
  test('trailing dot, case and default port give one key', () => {
    expect(n('DB.Example.com.:3306')).toEqual(n('db.example.com'))
    expect(n('db.example.com')).toEqual({ host: 'db.example.com', port: 3306, username: 'root' })
  })
  test('bracketed IPv6 with port', () => {
    expect(n('[2001:DB8::1]:3307')).toMatchObject({ host: '2001:db8::1', port: 3307 })
  })
  test('IPv6 is shortened per RFC 5952', () => {
    expect(n('2001:DB8:0:0:0:0:0:1').host).toBe('2001:db8::1')
  })
  test('IPv4-mapped IPv6 becomes IPv4', () => {
    expect(n('::ffff:192.0.2.1').host).toBe('192.0.2.1')
  })
  test('zone is kept as a lower-case suffix', () => {
    expect(n('fe80::1%ETH0')).toMatchObject({ host: 'fe80::1', zone: '%eth0' })
  })
  test('explicit port argument', () => {
    expect(n('db', '03307').port).toBe(3307)
    expect(n('db', 3307).port).toBe(3307)
  })
  test('non-ASCII host becomes punycode', () => {
    expect(n('Bücher.example').host).toBe('xn--bcher-kva.example')
  })
  test('user name is case-sensitive, NFC, not trimmed', () => {
    expect(n('db', undefined, 'Root')).not.toEqual(n('db', undefined, 'root'))
    expect(n('db', undefined, 'é').username).toBe('é')
    expect(n('db', undefined, ' a ').username).toBe(' a ')
  })
  test('localhost and 127.0.0.1 are different keys', () => {
    expect(n('localhost')).not.toEqual(n('127.0.0.1'))
  })
  test.each([
    '127.1',
    '0x7f.0.0.1',
    '2130706433',
    '017.0.0.1',
    '01.2.3.4',
    '256.1.1.1',
    'db:0',
    'db:65536',
    'db:3306x',
    'a b',
    '',
    '  ',
    'a/b',
    'a\b',
    'u@h',
    'h?x',
    'h#x',
    'h%41',
    'a'.repeat(254),
    'ho\tst',
    '[::1',
    'db:',
  ])('rejects %j', (host) => {
    expect(() => n(host)).toThrow(InvalidTargetError)
  })
  test('rejects empty user name', () => {
    expect(() => n('db', undefined, '')).toThrow(InvalidTargetError)
  })
  test('error text is identical for every cause', () => {
    const msgs = new Set(
      ['127.1', 'db:0', ''].map((h) => {
        try {
          n(h)
        } catch (e) {
          return (e as Error).message
        }
      }),
    )
    expect(msgs.size).toBe(1)
  })
})
