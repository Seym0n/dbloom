import { describe, expect, test } from 'vitest'
import { isAddressAllowed, resolveAllowedAddress, TargetDeniedError } from '~/server/host-policy'
import type { Config } from '~/server/config'

const base: Config = {
  dataDir: '',
  allowedTargets: [],
  freeFormAck: true,
  allowLoopback: false,
  allowPrivate: false,
  tls: 'verify',
  trustProxy: false,
  sessionIdleMs: 1,
  sessionAbsoluteMs: 1,
  connectTimeoutMs: 1,
  readOnly: false,
  statementTimeoutMs: 30_000,
}
const deny = { allowLoopback: false, allowPrivate: false }
const t = (host: string, port = 3306) => ({ host, port, username: 'u' })

describe('isAddressAllowed', () => {
  test.each([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::',
    'fe80::1',
    '224.0.0.1',
    '255.255.255.255',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    'fd00::1',
    '::ffff:10.0.0.1',
  ])('denies %s by default', (a) => expect(isAddressAllowed(a, deny)).toBe(false))

  test.each(['8.8.8.8', '2001:db8::1', '93.184.216.34'])('allows public %s', (a) =>
    expect(isAddressAllowed(a, deny)).toBe(true),
  )

  test('loopback and private open only through their flags', () => {
    expect(isAddressAllowed('127.0.0.1', { allowLoopback: true, allowPrivate: false })).toBe(true)
    expect(isAddressAllowed('10.0.0.1', { allowLoopback: true, allowPrivate: false })).toBe(false)
    expect(isAddressAllowed('10.0.0.1', { allowLoopback: false, allowPrivate: true })).toBe(true)
  })

  test('metadata address stays blocked even with every flag', () => {
    const all = { allowLoopback: true, allowPrivate: true }
    expect(isAddressAllowed('169.254.169.254', all)).toBe(false)
  })
})

describe('resolveAllowedAddress', () => {
  test('every returned address must pass (rebinding)', async () => {
    const resolver = async () => ['8.8.8.8', '127.0.0.1']
    await expect(resolveAllowedAddress(t('evil.example'), base, resolver)).rejects.toBeInstanceOf(
      TargetDeniedError,
    )
  })

  test('returns the validated address', async () => {
    expect(await resolveAllowedAddress(t('db.example'), base, async () => ['8.8.4.4'])).toBe(
      '8.8.4.4',
    )
  })

  test('literal loopback is refused without the flag', async () => {
    await expect(resolveAllowedAddress(t('127.0.0.1'), base)).rejects.toBeInstanceOf(
      TargetDeniedError,
    )
    expect(await resolveAllowedAddress(t('127.0.0.1'), { ...base, allowLoopback: true })).toBe(
      '127.0.0.1',
    )
  })

  test('allow-list names hosts and ports', async () => {
    const cfg = { ...base, freeFormAck: false, allowedTargets: ['db.example:3307'] }
    const resolver = async () => ['8.8.8.8']
    await expect(
      resolveAllowedAddress(t('db.example', 3306), cfg, resolver),
    ).rejects.toBeInstanceOf(TargetDeniedError)
    expect(await resolveAllowedAddress(t('db.example', 3307), cfg, resolver)).toBe('8.8.8.8')
  })

  test('resolver failure is a denial', async () => {
    const resolver = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND')
    }
    await expect(resolveAllowedAddress(t('nx.example'), base, resolver)).rejects.toBeInstanceOf(
      TargetDeniedError,
    )
  })
})
