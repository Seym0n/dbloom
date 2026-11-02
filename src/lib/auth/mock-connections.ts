/**
 * Mock of the connection, vault, profile, Users and invite server functions (SPEC/26 5.6, 5.10). Split from `mock-api.ts`
 * so the sections of the two UI waves do not collide; `mock-api.ts` spreads `createMockConnectionApi(...)` into the API.
 * State lives in this tab's session storage (`dbloom.authMock.conn`). Behaviour the specs rely on:
 *  - typed credentials: user `root` is refused when flag `deny-root` is set, an empty password is refused (`empty_password`),
 *    host `bad.*` fails with the generic target failure, user `readonly` opens a read-only connection, 5 connections at most;
 *  - vault passphrase of at least 14 characters; recovery keys are `MOCK_VAULT_KEY_PREFIX-<n>`; flag `vault-off` disables
 *    personal profiles, flag `short-lock` auto-locks after 3 seconds;
 *  - profiles: host `bad.*` fails the test, so saving needs `saveAnyway`;
 *  - users: created ones must change the password; invite, revoke and recovery need a step-up (flag `step-up-off` skips it).
 */
import type { ConnectionInfo, InviteInfo, OpenConnectionInput, ProfileInfo, Role, UserStatus, UserSummary, VaultStatus } from '~/server/auth/types'
import type { AuthApi } from './api'

const MOCK_INVITE_TOKEN = `inv-${'a'.repeat(39)}`
const MOCK_RECOVERY_TOKEN = `rec-${'b'.repeat(39)}`

export const MOCK_VAULT_KEY_PREFIX = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345'
export const MOCK_VAULT_PASSPHRASE = 'a long vault passphrase'
export const MOCK_CONN_KEY = 'dbloom.authMock.conn'

export type MockUserLike = {
  username: string
  displayName: string
  role: Role
  password: string
  totp: boolean
  passkeys: number
  recovery: string[]
  mustChange: boolean
  enrolOnly: boolean
  disabled?: boolean
}

type StoredProfile = ProfileInfo & { user: string; password: string; clientKey: boolean }
type ConnState = {
  seq: number
  connections: ConnectionInfo[]
  vault: { exists: boolean; passphrase: string; recoveryKey: string; unlocked: boolean; lockAt: number | null }
  profiles: StoredProfile[]
  invites: InviteInfo[]
  lastSignIn: Record<string, number>
}

export type MockConnectionDeps = {
  fail: (code: string, extra?: Record<string, unknown>) => never
  wait: <T>(value: T) => Promise<T>
  flag: (name: string) => boolean
  needStepUp: () => void
  policy: (password: string, username: string) => void
  state: { users: MockUserLike[] }
  makeUser: (username: string, extra: Partial<MockUserLike>) => MockUserLike
  save: () => void
}

const empty = (): ConnState => ({
  seq: 0,
  connections: [],
  vault: { exists: false, passphrase: '', recoveryKey: '', unlocked: false, lockAt: null },
  profiles: [],
  invites: [],
  lastSignIn: {},
})

const read = (): ConnState => {
  try {
    const raw = window.sessionStorage.getItem(MOCK_CONN_KEY)
    if (raw) return { ...empty(), ...(JSON.parse(raw) as Partial<ConnState>) }
  } catch {
    /* start fresh */
  }
  return empty()
}
const write = (s: ConnState) => {
  try {
    window.sessionStorage.setItem(MOCK_CONN_KEY, JSON.stringify(s))
  } catch {
    /* in-memory only */
  }
}

/** Connections held by the current sign-in; read by the boot call of the mock. */
export const mockOpenConnections = (): ConnectionInfo[] => {
  if (typeof window === 'undefined') return []
  return read().connections
}
export const clearMockConnections = () => {
  try {
    window.sessionStorage.removeItem(MOCK_CONN_KEY)
  } catch {
    /* nothing to clear */
  }
}

const stripKey = (k: string) => k.replace(/[\s-]/g, '').toUpperCase()

export function createMockConnectionApi(deps: MockConnectionDeps) {
  const { fail, wait, flag, needStepUp, policy, state, makeUser, save } = deps
  const generic = (): never => {
    throw new Error('target_failed')
  }
  const lockMs = () => (flag('short-lock') ? 3000 : 15 * 60_000)

  /** Reads the state and applies the auto-lock. */
  const load = () => {
    const s = read()
    if (s.vault.unlocked && s.vault.lockAt !== null && s.vault.lockAt <= Date.now()) {
      s.vault.unlocked = false
      s.vault.lockAt = null
      write(s)
    }
    return s
  }
  const touch = (s: ConnState) => {
    s.vault.lockAt = Date.now() + lockMs()
  }
  const status = (s: ConnState): VaultStatus => ({ exists: s.vault.exists, unlocked: s.vault.unlocked, autoLockAt: s.vault.unlocked ? s.vault.lockAt : null, enabled: !flag('vault-off') })
  const newKey = (s: ConnState) => {
    s.seq += 1
    s.vault.recoveryKey = `${MOCK_VAULT_KEY_PREFIX}-${String(1000 + s.seq)}`
    return s.vault.recoveryKey
  }
  const needVault = (s: ConnState, unlocked: boolean) => {
    if (flag('vault-off')) fail('vault_absent')
    if (!s.vault.exists) fail('vault_absent')
    if (unlocked && !s.vault.unlocked) fail('vault_locked')
  }
  const passphrase = (value: string) => {
    if ([...value].length < 14) fail('password_rejected', { reason: 'too_short' })
  }
  const info = (p: StoredProfile, unlocked: boolean): ProfileInfo => {
    const { user, password: _password, clientKey, ...rest } = p
    void _password
    return { ...rest, ...(unlocked ? { targetUser: user } : {}), ...(clientKey ? { hasClientKey: true } : {}) }
  }

  const summary = (u: MockUserLike, s: ConnState): UserSummary => ({
    id: `mock-${u.username}`,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    status: (u.disabled ? 'disabled' : 'active') as UserStatus,
    lastSignInAt: s.lastSignIn[u.username] ?? (u.username === 'alice' ? Date.now() - 2 * 3_600_000 : u.username === 'bob' ? Date.now() - 26 * 3_600_000 : null),
    createdAt: 0,
    factors: { passkeys: u.passkeys, totp: u.totp, recoveryCodes: u.recovery.length },
    hasPassword: true,
  })
  const findUser = (id: string) => state.users.find((u) => `mock-${u.username}` === id) ?? fail('connection_unknown')

  const methods: Pick<
    AuthApi,
    | 'listConnections' | 'openConnection' | 'closeConnection'
    | 'vaultStatus' | 'vaultCreate' | 'vaultUnlock' | 'vaultLock' | 'vaultChangePassphrase' | 'vaultUseRecoveryKey' | 'vaultRegenerateRecoveryKey' | 'vaultRotateKey'
    | 'listProfiles' | 'saveProfile' | 'testProfile' | 'deleteProfile'
    | 'listUsers' | 'createUser' | 'setUserStatus' | 'setUserRole' | 'deleteUser' | 'revokeUserSessions'
    | 'issueInvite' | 'listInvites' | 'revokeInvite' | 'issueRecovery'
  > = {
    // ---- connections
    listConnections: async () => wait(load().connections),
    openConnection: async (input: OpenConnectionInput) => {
      const s = load()
      if (s.connections.length >= 5) fail('connection_limit')
      let conn: ConnectionInfo
      s.seq += 1
      if (input.source === 'typed') {
        if (flag('deny-root') && input.username.toLowerCase() === 'root') fail('target_policy', { reason: 'root_denied' })
        if (input.password === '') fail('target_policy', { reason: 'empty_password' })
        if (/^bad\./.test(input.host)) generic()
        conn = { connectionId: `mock-conn-${s.seq}`, host: input.host, port: input.port ?? 3306, targetUser: input.username, source: 'typed', readOnly: input.username === 'readonly', openedAt: Date.now() }
      } else {
        needVault(s, true)
        const p = s.profiles.find((x) => x.id === input.profileId) ?? fail('connection_unknown')
        if (/^bad\./.test(p.host)) generic()
        touch(s)
        conn = { connectionId: `mock-conn-${s.seq}`, host: p.host, port: p.port, targetUser: p.user, source: 'profile', profileId: p.id, label: p.name, readOnly: false, openedAt: Date.now() }
      }
      s.connections.push(conn)
      write(s)
      return wait(conn)
    },
    closeConnection: async (connectionId) => {
      const s = load()
      if (!s.connections.some((c) => c.connectionId === connectionId)) fail('connection_unknown')
      s.connections = s.connections.filter((c) => c.connectionId !== connectionId)
      write(s)
      return wait({ ok: true })
    },

    // ---- vault
    vaultStatus: async () => wait(status(load())),
    vaultCreate: async (value) => {
      const s = load()
      if (flag('vault-off')) fail('vault_absent')
      passphrase(value)
      s.vault = { exists: true, passphrase: value, recoveryKey: '', unlocked: true, lockAt: Date.now() + lockMs() }
      const recoveryKey = newKey(s)
      write(s)
      return wait({ recoveryKey })
    },
    vaultUnlock: async (value) => {
      const s = load()
      needVault(s, false)
      if (value !== s.vault.passphrase) fail('auth_failed')
      s.vault.unlocked = true
      touch(s)
      write(s)
      return wait(status(s))
    },
    vaultLock: async () => {
      const s = load()
      s.vault.unlocked = false
      s.vault.lockAt = null
      write(s)
      return wait(status(s))
    },
    vaultChangePassphrase: async (current, next) => {
      const s = load()
      needVault(s, true)
      if (current !== s.vault.passphrase) fail('auth_failed')
      passphrase(next)
      s.vault.passphrase = next
      write(s)
      return wait({ ok: true })
    },
    vaultUseRecoveryKey: async (key, next) => {
      const s = load()
      needVault(s, false)
      if (stripKey(key) !== stripKey(s.vault.recoveryKey)) fail('auth_failed')
      passphrase(next)
      s.vault.passphrase = next
      s.vault.unlocked = true
      touch(s)
      const recoveryKey = newKey(s)
      write(s)
      return wait({ recoveryKey })
    },
    vaultRegenerateRecoveryKey: async () => {
      needStepUp()
      const s = load()
      needVault(s, true)
      const recoveryKey = newKey(s)
      write(s)
      return wait({ recoveryKey })
    },
    vaultRotateKey: async (value) => {
      needStepUp()
      const s = load()
      needVault(s, true)
      if (value !== s.vault.passphrase) fail('auth_failed')
      const recoveryKey = newKey(s)
      write(s)
      return wait({ recoveryKey })
    },

    // ---- profiles
    listProfiles: async () => {
      const s = load()
      if (flag('vault-off')) fail('vault_absent')
      return wait(s.profiles.map((p) => info(p, s.vault.unlocked)))
    },
    saveProfile: async (input) => {
      const s = load()
      needVault(s, false)
      const existing = input.id ? (s.profiles.find((p) => p.id === input.id) ?? fail('connection_unknown')) : undefined
      if (!existing && !s.vault.unlocked) fail('vault_locked')
      if (input.credentials && !s.vault.unlocked) fail('vault_locked')
      if (s.profiles.some((p) => p.name.toLowerCase() === input.name.toLowerCase() && p.id !== input.id)) fail('profile_name_taken')
      const failed = /^bad\./.test(input.host)
      if (failed && !input.saveAnyway) fail('profile_test_failed', { targetMessage: 'Could not connect to the server.' })
      s.seq += 1
      const options = { compress: false, database: null, collation: null, activateRoles: false, caPem: null, clientCertPem: null, ...(input.options ?? {}) }
      const next: StoredProfile = {
        id: existing?.id ?? `mock-profile-${s.seq}`,
        name: input.name,
        host: input.host,
        port: input.port ?? 3306,
        tls: input.tls ?? 'verify',
        options,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        lastUsedAt: existing?.lastUsedAt ?? null,
        user: input.credentials?.user ?? existing?.user ?? '',
        password: input.credentials?.password ?? existing?.password ?? '',
        clientKey: input.credentials?.clientKeyPem ? true : (existing?.clientKey ?? false),
      }
      s.profiles = existing ? s.profiles.map((p) => (p.id === next.id ? next : p)) : [...s.profiles, next]
      touch(s)
      write(s)
      return wait({ profile: info(next, s.vault.unlocked), test: failed ? ('failed' as const) : ('ok' as const) })
    },
    testProfile: async (input) => {
      const s = load()
      needVault(s, false)
      if (/^bad\./.test(input.host)) return wait({ ok: false as const, error: { code: 'profile_test_failed', targetMessage: 'Could not connect to the server.' } })
      return wait({ ok: true as const })
    },
    deleteProfile: async (id) => {
      const s = load()
      if (!s.profiles.some((p) => p.id === id)) fail('connection_unknown')
      s.profiles = s.profiles.filter((p) => p.id !== id)
      write(s)
      return wait({ ok: true })
    },

    // ---- users
    listUsers: async () => {
      const s = load()
      return wait(state.users.map((u) => summary(u, s)))
    },
    createUser: async (input) => {
      policy(input.password, input.username)
      if (state.users.some((u) => u.username.toLowerCase() === input.username.toLowerCase())) throw new Error('username_taken')
      state.users.push(makeUser(input.username, { displayName: input.displayName, role: input.role, password: input.password, mustChange: true }))
      save()
      return wait(summary(state.users[state.users.length - 1]!, load()))
    },
    setUserStatus: async (userId, status) => {
      findUser(userId).disabled = status === 'disabled'
      save()
      return wait({ ok: true as const })
    },
    setUserRole: async (userId, role) => {
      findUser(userId).role = role
      save()
      return wait({ ok: true as const })
    },
    deleteUser: async (userId) => {
      const u = findUser(userId)
      state.users.splice(state.users.indexOf(u), 1)
      save()
      return wait({ ok: true as const })
    },
    revokeUserSessions: async (userId) => {
      findUser(userId)
      return wait({ revoked: 2 })
    },

    // ---- invites and recovery links
    issueInvite: async ({ role, lifetimeMs }) => {
      needStepUp()
      const s = load()
      s.seq += 1
      const expiresAt = Date.now() + (lifetimeMs ?? 72 * 3_600_000)
      s.invites.push({ id: `mock-invite-${s.seq}`, role, createdBy: 'mock-alice', createdAt: Date.now(), expiresAt })
      write(s)
      return wait({ link: `https://dbloom.example.org/invite#${MOCK_INVITE_TOKEN}`, expiresAt })
    },
    listInvites: async () => wait(load().invites.filter((i) => i.expiresAt > Date.now())),
    revokeInvite: async (id) => {
      needStepUp()
      const s = load()
      s.invites = s.invites.filter((i) => i.id !== id)
      write(s)
      return wait({ ok: true as const })
    },
    issueRecovery: async (userId) => {
      needStepUp()
      findUser(userId)
      return wait({ link: `https://dbloom.example.org/recover#${MOCK_RECOVERY_TOKEN}`, expiresAt: Date.now() + 24 * 3_600_000 })
    },
  }
  return methods
}
