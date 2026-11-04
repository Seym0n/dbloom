import { describe, expect, it } from 'vitest'
import {
  tlsAtLeast,
  tlsDefaultFrom,
  tlsModesFrom,
  EMPTY_PROFILE,
  EMPTY_TYPED,
  allowedUserActions,
  formatLockIn,
  generateTempPassword,
  normaliseRecoveryKey,
  pickActive,
  profileToForm,
  sortUsers,
  splitHostPort,
  toOpenInput,
  toSaveInput,
  validateProfile,
  validateTyped,
  vaultView,
} from '~/lib/auth/connections-logic'
import type { ProfileInfo, UserSummary } from '~/server/auth/types'

const typed = (over: Partial<typeof EMPTY_TYPED>) => ({ ...EMPTY_TYPED, host: 'db', username: 'app', ...over })

describe('typed credentials', () => {
  it('needs host and user, bounds the port', () => {
    expect(validateTyped(EMPTY_TYPED)).toEqual({ host: 'required', username: 'required' })
    expect(validateTyped(typed({ port: '0' }))).toEqual({ port: 'invalid' })
    expect(validateTyped(typed({ port: '65536' }))).toEqual({ port: 'invalid' })
    expect(validateTyped(typed({ port: '3306.5' }))).toEqual({ port: 'invalid' })
    expect(validateTyped(typed({ port: '' }))).toEqual({})
  })
  it('checks the collation name', () => {
    expect(validateTyped(typed({ collation: 'utf8mb4_bin' }))).toEqual({})
    expect(validateTyped(typed({ collation: 'utf8; drop' }))).toEqual({ collation: 'invalid' })
  })
  it('leaves empty optional fields out of the request', () => {
    expect(toOpenInput(typed({ port: '' }))).toEqual({ source: 'typed', host: 'db', username: 'app', password: '', tls: 'verify' })
    expect(toOpenInput(typed({ port: '3307', database: ' shop ', collation: 'utf8mb4_bin', password: 'x', tls: 'off' }))).toEqual({
      source: 'typed',
      host: 'db',
      port: 3307,
      username: 'app',
      password: 'x',
      tls: 'off',
      database: 'shop',
      collation: 'utf8mb4_bin',
    })
  })
  it('splits host:port and keeps IPv6 whole', () => {
    expect(splitHostPort('db.example.org:3307')).toEqual({ host: 'db.example.org', port: '3307' })
    expect(splitHostPort('db.example.org')).toEqual({ host: 'db.example.org' })
    expect(splitHostPort('[::1]:3306')).toEqual({ host: '::1', port: '3306' })
    expect(splitHostPort('fe80::1')).toEqual({ host: 'fe80::1' })
  })
})

describe('active connection', () => {
  const list = [{ connectionId: 'a' }, { connectionId: 'b' }]
  it('keeps the stored one while open, else the first', () => {
    expect(pickActive(list, 'b')?.connectionId).toBe('b')
    expect(pickActive(list, 'gone')?.connectionId).toBe('a')
    expect(pickActive(list, null)?.connectionId).toBe('a')
    expect(pickActive([], 'a')).toBeUndefined()
  })
})

describe('profile form', () => {
  const profile: ProfileInfo = {
    id: 'p1',
    name: 'Prod',
    host: 'db',
    port: 3306,
    tls: 'verify',
    options: { compress: false, database: 'shop', collation: null, activateRoles: false, caPem: null, clientCertPem: 'CERT' },
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    targetUser: 'app',
    hasClientKey: true,
  }
  it('an edit keeps the password and client key unless replaced', () => {
    const f = profileToForm(profile)
    expect(f.keepPassword && f.keepClientKey).toBe(true)
    const input = toSaveInput(f, true)
    expect(input.credentials).toEqual({ user: 'app' })
    expect(input.saveAnyway).toBe(false)
    expect(toSaveInput({ ...f, password: 'new', clientKeyPem: 'KEY' }, true, true).credentials).toEqual({ user: 'app', password: 'new', clientKeyPem: 'KEY' })
  })
  it('a locked vault sends no credentials', () => {
    expect(toSaveInput(profileToForm(profile), false).credentials).toBeUndefined()
    expect(validateProfile(profileToForm({ ...profile, targetUser: undefined as never }), false)).toEqual({})
  })
  it('requires name, host, port and, when unlocked, the user', () => {
    expect(validateProfile(EMPTY_PROFILE, true)).toEqual({ name: 'required', host: 'required', username: 'required' })
    expect(validateProfile({ ...EMPTY_PROFILE, name: 'x', host: 'h', port: 'abc' }, false)).toEqual({ port: 'invalid' })
  })
  it('client certificate and key come as a pair', () => {
    const base = { ...EMPTY_PROFILE, name: 'x', host: 'h', username: 'u' }
    expect(validateProfile({ ...base, clientCertPem: 'C' }, true)).toEqual({ clientPair: 'invalid' })
    expect(validateProfile({ ...base, clientKeyPem: 'K' }, true)).toEqual({ clientPair: 'invalid' })
    expect(validateProfile({ ...base, clientCertPem: 'C', clientKeyPem: 'K' }, true)).toEqual({})
  })
})

describe('vault helpers', () => {
  it('maps the status to a view', () => {
    expect(vaultView({ exists: false, unlocked: false, enabled: true })).toBe('absent')
    expect(vaultView({ exists: true, unlocked: false, enabled: true })).toBe('locked')
    expect(vaultView({ exists: true, unlocked: true, enabled: true })).toBe('unlocked')
    expect(vaultView({ exists: true, unlocked: true, enabled: false })).toBe('disabled')
  })
  it('formats the time to auto-lock', () => {
    expect(formatLockIn(null, 0)).toBeNull()
    expect(formatLockIn(65_000, 0)).toBe('1:05')
    expect(formatLockIn(1000, 5000)).toBe('0:00')
  })
  it('normalises a typed recovery key', () => {
    expect(normaliseRecoveryKey(' abcd-efgh \n jkmn ')).toBe('ABCD-EFGHJKMN')
  })
})

describe('users', () => {
  const u = (id: string, role: UserSummary['role'], username: string, status: UserSummary['status'] = 'active'): UserSummary => ({
    id,
    username,
    displayName: username,
    role,
    status,
    lastSignInAt: null,
    createdAt: 0,
    factors: { passkeys: 0, totp: false, recoveryCodes: 0 },
    hasPassword: true,
  })
  it('never offers actions on the own account', () => {
    expect(allowedUserActions(u('1', 'admin', 'a'), '1')).toEqual([])
  })
  it('offers enable for a disabled user, disable for an active one', () => {
    expect(allowedUserActions(u('2', 'user', 'b'), '1')).toContain('disable')
    expect(allowedUserActions(u('2', 'user', 'b', 'disabled'), '1')).toContain('enable')
    expect(allowedUserActions(u('2', 'user', 'b', 'disabled'), '1')).not.toContain('disable')
  })
  it('sorts administrators first, then by name', () => {
    expect(sortUsers([u('1', 'user', 'zed'), u('2', 'admin', 'zoe'), u('3', 'user', 'amy'), u('4', 'admin', 'ann')]).map((x) => x.username)).toEqual(['ann', 'zoe', 'amy', 'zed'])
  })
  it('generates a 20 character password from the safe alphabet', () => {
    const p = generateTempPassword()
    expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/)
    expect(generateTempPassword()).not.toBe(p)
  })
})


describe('connection security floor (finding f)', () => {
  it('offers the modes at least as strict as the operator setting, strictest first', () => {
    expect(tlsModesFrom('verify')).toEqual(['verify'])
    expect(tlsModesFrom('skip-verify')).toEqual(['verify', 'skip-verify'])
    expect(tlsModesFrom('off')).toEqual(['verify', 'skip-verify', 'off'])
  })
  it('starts on the operator setting; a weaker stored value is shown as the floor', () => {
    expect(tlsDefaultFrom('off')).toBe('off')
    expect(tlsDefaultFrom('verify')).toBe('verify')
    expect(tlsAtLeast('off', 'verify')).toBe('verify')
    expect(tlsAtLeast('skip-verify', 'off')).toBe('skip-verify')
    expect(tlsAtLeast('verify', 'skip-verify')).toBe('verify')
  })
})
