/**
 * Setup (FR-AUT-001 to 003, DEP-TGT-100, DEP-TGT-123, ST-031, ST-050, ST-051): the one-time token, the wizard's
 * in-memory state machine and the single completion transaction. Nothing reaches the store before `complete`.
 */
import { BlockList, isIP } from 'node:net'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertDirectTargets, loadConfig } from '../config'
import { audit } from '../audit'
import { StartRefusal, evaluateStart, parseLoginMode, parsePublicOrigin } from './start-gate'
import {
  AAD,
  AUTH_ENV,
  AuthError,
  MAX_PASSKEYS,
  SETUP_COOKIE_BYTES,
  SETUP_TOKEN_ENV_MIN_CHARS,
  SETUP_TOKEN_FILE,
  type AccountStore,
  type AuthSettingsResolver,
  type FactorKind,
  type LoginMode,
  type PasskeyRecord,
  type PasswordService,
  type RecoveryCodeService,
  type ResolvedAuthSettings,
  type SecretKeyRing,
  type SetupDraft,
  type SetupEnvStatus,
  type SetupService,
  type SetupSiteValues,
  type StartupState,
  type Throttle,
  type TokenService,
  type TotpService,
  type User,
  type WebAuthnService,
  AUTH_SETTINGS,
  setupCompleteInput,
  type SetupStep,
} from './types'

/** `gone` answers 404 (also for an address outside `DBLOOM_SETUP_NETWORKS`); the others carry one fixed message. */
export type SetupErrorCode = 'gone' | 'invalid_token' | 'session' | 'step' | 'env' | 'passkey_unavailable' | 'totp_invalid' | 'admin_network'
export class SetupError extends Error {
  constructor(public readonly code: SetupErrorCode) {
    super(`setup_${code}`)
    this.name = 'SetupError'
  }
}

export const SETUP_ENV_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SETUP_TOKEN_ENV_MIN_CHARS},}$`)
/** Default administration networks (SEC-TGT-147): loopback; `DBLOOM_ADMIN_NETWORKS` (CIDR list) overrides. */
export const ADMIN_NETWORKS_ENV = 'DBLOOM_ADMIN_NETWORKS'
export const DEFAULT_ADMIN_NETWORKS = ['127.0.0.0/8', '::1/128']
const TOTP_TRIES = 5
const MAX_SETUP_SESSIONS = 20

export type SetupDeps = {
  accounts: AccountStore
  dataDir: string
  env: NodeJS.ProcessEnv
  stateless: boolean
  resolver: AuthSettingsResolver
  tokens: TokenService
  passwords: PasswordService
  totp: TotpService
  recoveryCodes?: RecoveryCodeService
  ring?: SecretKeyRing
  /** Task 6 supplies it; without it the passkey step answers `passkey_unavailable`. */
  webauthn?: () => WebAuthnService | undefined
  throttle: Throttle
  now?: () => number
  /** Banner output; defaults to `console.log`. */
  log?: (line: string) => void
}

type Session = {
  hash: string
  csrf: string
  address: string
  tokenHash: string
  expiresAt: number
  draft: SetupDraft
  /** Server-side admin values, never part of the draft that crosses the boundary. */
  admin?: { userId: string; webauthnUserId: string; username: string; displayName: string; phc: string }
  passkeys: PasskeyRecord[]
  pendingTotp?: { secret: Buffer; tries: number }
  totp?: { secret: Buffer; step: number }
  codes?: { plain: string[]; macs: string[] }
}

/** `SetupService` with the richer `verifyToken` and `state` the routes need. */
export type SetupApi = Omit<SetupService, 'verifyToken' | 'state'> & {
  /** Adds the per-session CSRF token that every later call must present. */
  verifyToken(token: string, address: string): { cookie: string; csrf: string }
  state(cookie: string, browser?: { origin?: string }): { draft: SetupDraft; env: SetupEnvStatus; defaults: SetupSiteValues } | undefined
  csrfOk(cookie: string, presented: string | undefined): boolean
  /** Whether a request from `address` may see the setup routes at all (completion, `DBLOOM_SETUP_NETWORKS`). */
  reachable(address: string): boolean
  /** Expiry (epoch ms) of the pending token; used by the CLI and the banner. */
  tokenExpiresAt(): number | undefined
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function blockList(cidrs: string[]): BlockList {
  const list = new BlockList()
  for (const c of cidrs) {
    const [addr, prefix] = c.split('/')
    const type = isIP(addr ?? '') === 6 ? 'ipv6' : 'ipv4'
    if (!addr || !isIP(addr)) continue
    list.addSubnet(addr, prefix === undefined ? (type === 'ipv6' ? 128 : 32) : Number(prefix), type)
  }
  return list
}

/** True when `address` lies in one of `cidrs`; IPv4-mapped IPv6 is compared as IPv4; unknown addresses never match. */
export function addressInNetworks(address: string, cidrs: string[]): boolean {
  const plain = address.replace(/^::ffff:/i, '')
  const family = isIP(plain)
  if (!family) return false
  return blockList(cidrs).check(plain, family === 6 ? 'ipv6' : 'ipv4')
}

export function adminNetworksOf(env: NodeJS.ProcessEnv): string[] {
  const list = (env[ADMIN_NETWORKS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : DEFAULT_ADMIN_NETWORKS
}

export function createSetupService(deps: SetupDeps): SetupApi {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const tokenPath = join(deps.dataDir, SETUP_TOKEN_FILE)
  const sessions = new Map<string, Session>()
  let complete = false
  let pendingToken: { hash: string; generated: boolean; expiresAt: number } | undefined

  const isComplete = () => {
    if (!complete) complete = deps.accounts.getSite().setupCompletedAt !== undefined
    return complete
  }
  const settings = () => deps.resolver.resolve()
  const sweep = () => {
    const t = now()
    for (const [k, s] of sessions) if (t > s.expiresAt) sessions.delete(k)
  }
  const removeTokenFile = () => rmSync(tokenPath, { force: true })

  const defaultsOf = (s: ResolvedAuthSettings): SetupSiteValues => ({
    siteName: 'DBLoom',
    mfaScope: s.mfaScope,
    mfaRoles: s.mfaRoles,
    mfaGraceMs: s.mfaGraceMs,
    mfaFactors: s.mfaFactors,
    primaryCredentials: s.primaryCredentials,
    passwordMinLength: s.passwordMinLength,
    breachedCheck: s.breachedCheck,
    tempPasswordMs: s.tempPasswordMs,
    sessionsPerUser: s.sessionsPerUser,
    sessionsAtLimit: s.sessionsAtLimit,
    inviteLifetimeMs: s.inviteLifetimeMs,
    recoveryLinkLifetimeMs: s.recoveryLinkLifetimeMs,
    vaultPassphraseMin: s.vaultPassphraseMin,
    vaultAutoLockMs: s.vaultAutoLockMs,
    personalProfiles: s.personalProfiles,
    allowEmptyTargetPassword: s.allowEmptyTargetPassword,
    denyRootTarget: s.denyRootTarget,
    loginAutofocus: s.loginAutofocus,
  })

  const get = (cookie: string | undefined): Session => {
    if (isComplete()) throw new SetupError('gone')
    if (!cookie) throw new SetupError('session')
    const s = sessions.get(sha(cookie))
    if (!s || now() > s.expiresAt || !pendingToken || s.tokenHash !== pendingToken.hash) throw new SetupError('session')
    return s
  }

  const recompute = (s: Session) => {
    const d = s.draft
    const admin = d.admin
    let step: SetupStep = 2
    if (d.loginMode) step = 3
    if (d.loginMode && d.site) step = d.loginMode === 'direct' ? 5 : 4
    if (d.loginMode === 'account' && d.site && admin?.passwordSet && admin.factor) step = 5
    d.step = step
  }

  const startupState = (): StartupState => {
    const decision = evaluateStart({ env: deps.env, stateless: deps.stateless, site: deps.accounts.getSite() })
    return decision.state
  }

  const needWebauthn = () => {
    const w = deps.webauthn?.()
    if (!w) throw new SetupError('passkey_unavailable')
    return w
  }
  const requireAdminStep = (s: Session) => {
    if (s.draft.loginMode !== 'account' || !s.draft.site || !s.admin) throw new SetupError('step')
    return s.admin
  }

  return {
    startupState,
    isComplete,

    prepareToken(at) {
      if (deps.stateless || isComplete()) {
        removeTokenFile()
        pendingToken = undefined
        return
      }
      const decision = evaluateStart({ env: deps.env, stateless: deps.stateless, site: deps.accounts.getSite() })
      if (decision.autoSetup) {
        removeTokenFile()
        return
      }
      const fromEnv = deps.env[AUTH_ENV.setupToken]?.trim()
      if (fromEnv && !SETUP_ENV_TOKEN_PATTERN.test(fromEnv)) {
        throw new StartRefusal(`${AUTH_ENV.setupToken} must have at least ${SETUP_TOKEN_ENV_MIN_CHARS} base64url characters (A-Z a-z 0-9 - _)`)
      }
      const generated = !fromEnv
      const token = fromEnv || deps.tokens.newSetupToken()
      const expiresAt = at + settings().setupTokenValidityMs
      pendingToken = { hash: deps.tokens.hashToken(generated ? deps.tokens.normaliseSetupToken(token) : token), generated, expiresAt }
      mkdirSync(deps.dataDir, { recursive: true })
      writeFileSync(tokenPath, `${token}\nexpires=${expiresAt}\n`, { mode: 0o600 })
      chmodSync(tokenPath, 0o600)
      log('==================== DBLoom first-run setup ====================')
      log(generated ? `Setup token: ${token}` : `Setup token: taken from ${AUTH_ENV.setupToken}`)
      log(`Valid until ${new Date(expiresAt).toISOString()}. Open /setup in the browser; the token is also in ${tokenPath}.`)
      log('=================================================================')
      audit('setup.token', { actor: 'setup', actorKind: 'setup', outcome: 'ok' })
    },

    tokenExpiresAt: () => pendingToken?.expiresAt,

    reachable(address) {
      if (deps.stateless || isComplete()) return false
      const nets = settings().setupNetworks
      return nets.length === 0 || addressInNetworks(address, nets)
    },

    verifyToken(token, address) {
      if (!this.reachable(address)) throw new SetupError('gone')
      const key = `ip:setup:${address}` as const
      const wait = deps.throttle.delayMs(key)
      if (wait > 0) {
        audit('setup.token_failed', { actor: 'setup', actorKind: 'setup', outcome: 'throttled', keyKind: 'ip' })
        throw new AuthError('auth_throttled', { retryAfterSeconds: Math.ceil(wait / 1000) })
      }
      // Hash even without a pending token so the timing does not tell.
      const candidate = deps.tokens.hashToken(pendingToken?.generated === false ? token.trim() : deps.tokens.normaliseSetupToken(token))
      const ok = !!pendingToken && now() <= pendingToken.expiresAt && deps.tokens.equalHashes(candidate, pendingToken.hash)
      if (!ok || !pendingToken) {
        deps.throttle.fail(key)
        audit('setup.token_failed', { actor: 'setup', actorKind: 'setup', outcome: 'failed', keyKind: 'ip' })
        throw new SetupError('invalid_token')
      }
      deps.throttle.reset(key)
      sweep()
      if (sessions.size >= MAX_SETUP_SESSIONS) sessions.delete(sessions.keys().next().value as string)
      const cookie = randomBytes(SETUP_COOKIE_BYTES).toString('base64url')
      const csrf = randomBytes(SETUP_COOKIE_BYTES).toString('base64url')
      const session: Session = {
        hash: sha(cookie),
        csrf,
        address,
        tokenHash: pendingToken.hash,
        expiresAt: pendingToken.expiresAt,
        draft: { step: 2, adminNetworkAcknowledged: false },
        passkeys: [],
      }
      sessions.set(session.hash, session)
      return { cookie, csrf }
    },

    csrfOk(cookie, presented) {
      try {
        const s = get(cookie)
        if (!presented) return false
        const a = Buffer.from(sha(s.csrf))
        const b = Buffer.from(sha(presented))
        return a.length === b.length && a.equals(b)
      } catch {
        return false
      }
    },

    state(cookie, browser) {
      let s: Session
      try {
        s = get(cookie)
      } catch {
        return undefined
      }
      const origin = parsePublicOrigin(deps.env[AUTH_ENV.publicOrigin])
      const nets = adminNetworksOf(deps.env)
      let matches: boolean | null = null
      if (origin.ok && browser?.origin) {
        try {
          matches = new URL(browser.origin).origin === origin.origin.origin
        } catch {
          matches = false
        }
      }
      const env: SetupEnvStatus = {
        storeMode: 'stateful',
        publicOrigin: origin.ok ? origin.origin.origin : null,
        publicOriginMatchesBrowser: matches,
        secretKeyPresent: !!deps.ring,
        adminNetworks: nets,
        browserAddress: s.address,
        browserInAdminNetworks: addressInNetworks(s.address, nets),
        importDir: deps.env.DBLOOM_IMPORT_DIR?.trim() || null,
        uploadDir: deps.env.DBLOOM_UPLOAD_DIR?.trim() || null,
        tls: (deps.env.DBLOOM_TARGET_TLS as SetupEnvStatus['tls'] | undefined) ?? 'verify',
      }
      return { draft: structuredClone(s.draft), env, defaults: defaultsOf(settings()) }
    },

    async saveStep(cookie, input) {
      const s = get(cookie)
      const d = s.draft
      if (input.step === 2) {
        d.loginMode = input.loginMode
        if (input.loginMode === 'direct') {
          delete d.admin
          delete s.admin
          s.passkeys = []
          delete s.totp
          delete s.pendingTotp
          delete s.codes
        }
      } else if (input.step === 3) {
        if (!d.loginMode) throw new SetupError('step')
        d.site = input.site
      } else {
        if (d.loginMode !== 'account' || !d.site) throw new SetupError('step')
        const cfg = settings()
        const check = await deps.passwords.check(input.password, {
          username: input.username,
          minLength: d.site.passwordMinLength,
          breachedCheck: d.site.breachedCheck,
          failClosed: true,
        })
        if (check.reason) throw new AuthError('password_rejected', { reason: check.reason })
        const phc = await deps.passwords.hash(input.password, cfg.argon2Login)
        get(cookie) // the session may have ended while hashing
        s.admin = {
          userId: s.admin?.userId ?? randomUUID(),
          webauthnUserId: s.admin?.webauthnUserId ?? randomBytes(32).toString('base64url'),
          username: input.username,
          displayName: input.displayName,
          phc,
        }
        d.admin = { username: input.username, displayName: input.displayName, passwordSet: true, factor: d.admin?.factor, codesSaved: false }
      }
      recompute(s)
      return structuredClone(d)
    },

    async passkeyOptions(cookie) {
      const s = get(cookie)
      const a = requireAdminStep(s)
      const w = needWebauthn()
      if (s.passkeys.length >= MAX_PASSKEYS) throw new SetupError('step')
      const user: User = {
        id: a.userId,
        username: a.username,
        usernameKey: a.username.normalize('NFKC').toLocaleLowerCase('en-US'),
        displayName: a.displayName,
        role: 'admin',
        status: 'active',
        securityVersion: 0,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        webauthnUserId: a.webauthnUserId,
        createdAt: now(),
        updatedAt: now(),
        createdBy: 'setup',
        lastSignInAt: null,
      }
      return w.registrationOptions(user, s.passkeys, 'setup_passkey', s.hash)
    },

    async passkeyVerify(cookie, response, name) {
      const s = get(cookie)
      const a = requireAdminStep(s)
      const w = needWebauthn()
      // A passkey enrolled here must report user verification (FR-AUT-003).
      const verified = await w.verifyRegistration(s.hash, 'setup_passkey', response, { requireUserVerification: true })
      get(cookie)
      s.passkeys.push({ ...verified, userId: a.userId, name, createdAt: now(), lastUsedAt: null })
      s.draft.admin!.factor = 'passkey' satisfies FactorKind
      recompute(s)
    },

    totpStart(cookie) {
      const s = get(cookie)
      const a = requireAdminStep(s)
      if (!deps.ring || !deps.recoveryCodes) throw new SetupError('env')
      const secret = deps.totp.newSecret()
      s.pendingTotp = { secret, tries: 0 }
      const uri = deps.totp.otpauthUri(secret, s.draft.site?.siteName || 'DBLoom', a.username)
      return { uri, secret: deps.totp.base32(secret), qrSvg: deps.totp.qrSvg(uri) }
    },

    totpVerify(cookie, code) {
      const s = get(cookie)
      requireAdminStep(s)
      if (!s.pendingTotp || !deps.recoveryCodes) throw new SetupError('step')
      const p = s.pendingTotp
      p.tries += 1
      const res = deps.totp.verify(p.secret, code, 0, settings().totpWindow, now())
      if (!res.ok) {
        if (p.tries >= TOTP_TRIES) delete s.pendingTotp
        throw new SetupError('totp_invalid')
      }
      s.totp = { secret: p.secret, step: res.step }
      delete s.pendingTotp
      const a = s.admin!
      const plain = deps.recoveryCodes.generate()
      s.codes = { plain, macs: plain.map((c) => deps.recoveryCodes!.mac(a.userId, deps.recoveryCodes!.normalise(c) ?? c)) }
      s.draft.admin!.factor = 'totp' satisfies FactorKind
      recompute(s)
      return { recoveryCodes: plain }
    },

    complete(cookie, rawInput) {
      const input = setupCompleteInput.parse(rawInput)
      const s = get(cookie)
      const d = s.draft
      const mode: LoginMode | undefined = d.loginMode
      if (!mode || !d.site) throw new SetupError('step')
        let admin: Session['admin']
      if (mode === 'account') {
        admin = s.admin
        if (!admin || !d.admin?.passwordSet || (!s.passkeys.length && !s.totp)) throw new SetupError('step')
        if (s.codes && input.codesSaved !== true) throw new SetupError('step')
        // Account mode needs the public origin and the server key before anyone can sign in (FR-AUT-001).
        if (!deps.ring || !parsePublicOrigin(deps.env[AUTH_ENV.publicOrigin]).ok) throw new SetupError('env')
        if (!addressInNetworks(s.address, adminNetworksOf(deps.env)) && !input.acknowledgeAdminNetwork) throw new SetupError('admin_network')
      }
      if (mode === 'direct') {
        // Direct mode chosen in the wizard needs the allow-list or the free-form acknowledgement (SEC-TGT-018).
        try {
          assertDirectTargets(loadConfig(deps.env))
        } catch {
          throw new SetupError('env')
        }
      }
      const at = now()
      deps.accounts.transaction(() => {
        // A second completion or a race loses here (BEGIN IMMEDIATE serialises the two).
        if (deps.accounts.getSite().setupCompletedAt !== undefined) throw new SetupError('gone')
        deps.accounts.setSite({ loginMode: mode, setupCompletedAt: at, siteName: d.site!.siteName })
        const values: Record<string, unknown> = {}
        for (const key of Object.keys(d.site!) as (keyof SetupSiteValues)[]) {
          if (key !== 'siteName' && key in AUTH_SETTINGS) values[key] = d.site![key]
        }
        deps.resolver.write(values as Parameters<AuthSettingsResolver['write']>[0], 'setup')
        if (mode === 'account' && admin) {
          const user: User = {
            id: admin.userId,
            username: admin.username,
            usernameKey: admin.username.normalize('NFKC').toLocaleLowerCase('en-US'),
            displayName: admin.displayName,
            role: 'admin',
            status: 'active',
            securityVersion: 0,
            mustChangePassword: false,
            tempPasswordExpiresAt: null,
            webauthnUserId: admin.webauthnUserId,
            createdAt: at,
            updatedAt: at,
            createdBy: 'setup',
            lastSignInAt: null,
          }
          deps.accounts.createUser(user)
          deps.accounts.setPassword({ userId: user.id, phc: admin.phc, changedAt: at })
          for (const p of s.passkeys) deps.accounts.addPasskey(p)
          if (s.totp && deps.ring) {
            deps.accounts.setTotp({ userId: user.id, sealed: deps.ring.seal('totp', AAD.totp(user.id), s.totp.secret), lastStep: s.totp.step, createdAt: at })
          }
          // Store transactions are re-entrant (savepoints): the codes commit or roll back with the account.
          if (s.codes) deps.accounts.replaceRecoveryCodes(user.id, s.codes.macs, at)
        }
      })
      complete = true
      pendingToken = undefined
      sessions.clear()
      removeTokenFile()
      audit('setup.complete', { actor: 'setup', actorKind: 'setup', outcome: 'ok', reason: mode })
      log('setup token consumed')
    },

    autoSetupDirect(at) {
      if (isComplete()) return
      deps.accounts.transaction(() => {
        if (deps.accounts.getSite().setupCompletedAt !== undefined) return
        deps.accounts.setSite({ loginMode: 'direct', setupCompletedAt: at, siteName: 'DBLoom' })
      })
      complete = true
      removeTokenFile()
      audit('setup.auto', { actor: 'setup', actorKind: 'setup', outcome: 'ok', reason: 'direct' })
    },
  }
}

export { parseLoginMode }
