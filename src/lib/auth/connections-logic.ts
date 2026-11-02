/** Pure logic of the connection, vault, profile and Users screens (SPEC/26 5.10); no React, no network. */
import {
  CONNECTION_HEADER,
  PROFILE_DEFAULT_PORT,
  type ConnectionInfo,
  type OpenConnectionInput,
  type ProfileInfo,
  type Role,
  type SaveProfileInput,
  TLS_MODES,
  type UserSummary,
} from '~/server/auth/types'

export type TlsMode = (typeof TLS_MODES)[number]

// ---- Active connection (sessionStorage, header `x-dbloom-connection`) ------------------------------------------

export function getStoredConnectionId(): string | null {
  try {
    return window.sessionStorage.getItem(CONNECTION_HEADER) || null
  } catch {
    return null
  }
}

/** The shell's server calls read this at call time (`csrfClientMiddleware`). `null` clears it (direct mode sends ''). */
export function setStoredConnectionId(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(CONNECTION_HEADER, id)
    else window.sessionStorage.removeItem(CONNECTION_HEADER)
  } catch {
    /* no storage: the server falls back to the first connection */
  }
}

/** The connection the shell works on: the stored one while it is still open, else the first open one. */
export function pickActive<T extends Pick<ConnectionInfo, 'connectionId'>>(connections: readonly T[], stored: string | null): T | undefined {
  return connections.find((c) => c.connectionId === stored) ?? connections[0]
}

export const connectionLabel = (c: Pick<ConnectionInfo, 'host' | 'port' | 'label'>) => c.label || `${c.host}:${c.port}`

// ---- Typed credentials ------------------------------------------------------------------------------------------

export type TypedForm = {
  host: string
  port: string
  username: string
  password: string
  tls: TlsMode
  database: string
  collation: string
}
export const EMPTY_TYPED: TypedForm = { host: '', port: String(PROFILE_DEFAULT_PORT), username: '', password: '', tls: 'verify', database: '', collation: '' }

export type TypedErrors = Partial<Record<'host' | 'port' | 'username' | 'database' | 'collation', 'required' | 'invalid'>>

const COLLATION = /^[A-Za-z0-9_]{1,64}$/

/** Accepts `host` and `host:port`; a bare IPv6 address (several colons, no brackets) is left alone. */
export function splitHostPort(value: string): { host: string; port?: string } {
  const v = value.trim()
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(v)
  if (m) return { host: m[1]!, ...(m[2] ? { port: m[2] } : {}) }
  const i = v.lastIndexOf(':')
  if (i > 0 && v.indexOf(':') === i && /^\d+$/.test(v.slice(i + 1))) return { host: v.slice(0, i), port: v.slice(i + 1) }
  return { host: v }
}

export function validateTyped(f: TypedForm): TypedErrors {
  const e: TypedErrors = {}
  if (f.host.trim() === '') e.host = 'required'
  else if (f.host.trim().length > 300) e.host = 'invalid'
  const port = Number(f.port)
  if (f.port.trim() !== '' && !(Number.isInteger(port) && port >= 1 && port <= 65535)) e.port = 'invalid'
  if (f.username.trim() === '') e.username = 'required'
  if (f.database.length > 64) e.database = 'invalid'
  if (f.collation !== '' && !COLLATION.test(f.collation)) e.collation = 'invalid'
  return e
}

/** Empty optional fields are left out so the server applies its defaults. */
export function toOpenInput(f: TypedForm): OpenConnectionInput {
  const port = f.port.trim() === '' ? undefined : Number(f.port)
  return {
    source: 'typed',
    host: f.host.trim(),
    ...(port ? { port } : {}),
    username: f.username,
    password: f.password,
    tls: f.tls,
    ...(f.database.trim() ? { database: f.database.trim() } : {}),
    ...(f.collation ? { collation: f.collation } : {}),
  }
}

// ---- Profiles ---------------------------------------------------------------------------------------------------

export type ProfileForm = {
  id?: string
  name: string
  host: string
  port: string
  tls: TlsMode
  username: string
  password: string
  /** Edit: leave the stored password as it is. */
  keepPassword: boolean
  database: string
  collation: string
  compress: boolean
  activateRoles: boolean
  caPem: string
  clientCertPem: string
  clientKeyPem: string
  /** Edit: leave the stored client key as it is. */
  keepClientKey: boolean
}
export const EMPTY_PROFILE: ProfileForm = {
  name: '',
  host: '',
  port: String(PROFILE_DEFAULT_PORT),
  tls: 'verify',
  username: '',
  password: '',
  keepPassword: false,
  database: '',
  collation: '',
  compress: false,
  activateRoles: false,
  caPem: '',
  clientCertPem: '',
  clientKeyPem: '',
  keepClientKey: false,
}

export function profileToForm(p: ProfileInfo): ProfileForm {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: String(p.port),
    tls: p.tls,
    username: p.targetUser ?? '',
    password: '',
    keepPassword: true,
    database: p.options.database ?? '',
    collation: p.options.collation ?? '',
    compress: p.options.compress,
    activateRoles: p.options.activateRoles,
    caPem: p.options.caPem ?? '',
    clientCertPem: p.options.clientCertPem ?? '',
    clientKeyPem: '',
    keepClientKey: Boolean(p.hasClientKey),
  }
}

export type ProfileErrors = Partial<Record<'name' | 'host' | 'port' | 'username' | 'collation' | 'clientPair', 'required' | 'invalid'>>

export function validateProfile(f: ProfileForm, vaultUnlocked: boolean): ProfileErrors {
  const e: ProfileErrors = {}
  if (f.name.trim() === '') e.name = 'required'
  else if ([...f.name.trim()].length > 64) e.name = 'invalid'
  if (f.host.trim() === '') e.host = 'required'
  const port = Number(f.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = 'invalid'
  // The user name is only known while the vault is open; a locked edit leaves the secrets alone.
  if (vaultUnlocked && f.username.trim() === '') e.username = 'required'
  if (f.collation !== '' && !COLLATION.test(f.collation)) e.collation = 'invalid'
  const hasCert = f.clientCertPem.trim() !== ''
  const hasKey = f.clientKeyPem.trim() !== '' || f.keepClientKey
  if (hasCert !== hasKey) e.clientPair = 'invalid'
  return e
}

export function toSaveInput(f: ProfileForm, vaultUnlocked: boolean, saveAnyway = false): Partial<SaveProfileInput> & Pick<SaveProfileInput, 'name' | 'host'> {
  return {
    ...(f.id ? { id: f.id } : {}),
    name: f.name.trim(),
    host: f.host.trim(),
    port: Number(f.port),
    tls: f.tls,
    options: {
      compress: f.compress,
      database: f.database.trim() || null,
      collation: f.collation || null,
      activateRoles: f.activateRoles,
      caPem: f.caPem.trim() || null,
      clientCertPem: f.clientCertPem.trim() || null,
    },
    ...(vaultUnlocked
      ? {
          credentials: {
            user: f.username,
            ...(f.id && f.keepPassword && f.password === '' ? {} : { password: f.password }),
            ...(f.clientKeyPem.trim() ? { clientKeyPem: f.clientKeyPem.trim() } : {}),
          },
        }
      : {}),
    saveAnyway,
  }
}

// ---- Vault ------------------------------------------------------------------------------------------------------

export type VaultView = 'absent' | 'locked' | 'unlocked' | 'disabled'
export function vaultView(s: { exists: boolean; unlocked: boolean; enabled: boolean }): VaultView {
  if (!s.enabled) return 'disabled'
  if (!s.exists) return 'absent'
  return s.unlocked ? 'unlocked' : 'locked'
}

/** `m:ss` until the vault locks by itself. */
export function formatLockIn(autoLockAt: number | null, now: number): string | null {
  if (autoLockAt === null) return null
  const s = Math.max(0, Math.ceil((autoLockAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Recovery keys are typed from a printed copy: drop spaces, any case. */
export const normaliseRecoveryKey = (v: string) => v.replace(/\s+/g, '').toUpperCase()

// ---- Users page -------------------------------------------------------------------------------------------------

export type UserAction = 'revokeSessions' | 'disable' | 'enable' | 'recovery' | 'delete' | 'role'

/** What an administrator may do with a row; never the account they are signed in with (a lock-out guard). */
export function allowedUserActions(user: Pick<UserSummary, 'id' | 'status'>, meId: string | undefined): UserAction[] {
  if (user.id === meId) return []
  return ['role', 'revokeSessions', user.status === 'active' ? 'disable' : 'enable', 'recovery', 'delete']
}

export const otherRole = (r: Role): Role => (r === 'admin' ? 'user' : 'admin')

/** A random temporary password from an unambiguous alphabet (no 0/O, 1/l/I); 20 characters. */
export function generateTempPassword(random: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(random(20), (n) => alphabet[n % alphabet.length]).join('')
}

/** Administrators first, then by user name. */
export const sortUsers = (users: readonly UserSummary[]): UserSummary[] =>
  [...users].sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : 1))
