/**
 * The only place the auth screens get server data from (SPEC/26 section 5.10). Every server function named in
 * AUTH_SERVER_FUNCTIONS has one typed method on `AuthApi`. Three implementations:
 *  - real: dynamic imports of the `*.functions.ts` files (so the mock path never loads them);
 *  - mock (`mock-api.ts`): in memory, selected by `VITE_DBLOOM_AUTH_MOCK=true` or `?authMock=<scenario>` in the address;
 *  - a test fake installed with `setAuthApi`.
 * Failures are `Error`s; read them with `parseAuthError` (`errors.ts`). Functions the server does not offer yet throw
 * `AuthApiUnavailable` in the real implementation.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import { setCsrfToken } from '~/lib/csrf'
import { AuthApiUnavailable } from './errors'
import { createMockAuthApi } from './mock-api'
import type {
  AccountSessionInfo,
  ConnectionInfo,
  InviteInfo,
  LoginMode,
  MfaMethod,
  OpenConnectionInput,
  PasskeyInfo,
  PrefImportResult,
  ProfileInfo,
  Role,
  SaveProfileInput,
  SessionInfo,
  SessionState,
  SetupDraft,
  SetupEnvStatus,
  SetupSiteValues,
  StepUpMethod,
  Theme,
  UserNotice,
  UserStatus,
  UserSummary,
  VaultStatus,
} from '~/server/auth/types'

export type CreationOptions = PublicKeyCredentialCreationOptionsJSON
export type RequestOptions = PublicKeyCredentialRequestOptionsJSON
export type RegistrationResponse = RegistrationResponseJSON
export type AuthenticationResponse = AuthenticationResponseJSON

/** Result of every sign-in step: the new CSRF token and the state the session is in now. */
export type SignInOutcome = { csrf: string; state: SessionState }

export type LoginPageInfo = {
  mode: LoginMode
  siteName: string
  passwordEnabled: boolean
  passkeyEnabled: boolean
  autofocus: boolean
}

/** Account session as `getSessionInfo` returns it in account mode (vault, theme and language are part of it; the mock may omit them). */
export type AccountSessionView = Omit<AccountSessionInfo, 'vault' | 'theme' | 'language'> &
  Partial<Pick<AccountSessionInfo, 'vault' | 'theme' | 'language'>>

/** Direct session as `getSessionInfo` returns it in direct mode (`mode`, theme and language are additions; the mock may omit them). */
export type DirectSessionView = {
  mode?: 'direct'
  csrf: string
  readOnly: boolean
  target: { host: string; port: number; username: string }
  theme?: Theme
  language?: string
}

/** What the front page needs to decide between setup, login, the half-signed-in states and the app. */
export type AuthBoot =
  | { kind: 'setup_pending' }
  | { kind: 'direct'; session: DirectSessionView | null }
  | { kind: 'account'; info: LoginPageInfo; session: AccountSessionView | null }

export type SetupStateResponse =
  | { pending: true }
  | { pending: true; draft: SetupDraft; env: SetupEnvStatus; defaults: SetupSiteValues }

export type SetupSaveStepInput =
  | { step: 2; loginMode: LoginMode }
  | { step: 3; site: SetupSiteValues }
  | { step: 4; username: string; displayName: string; password: string }

export type TotpStart = { uri: string; secret: string; qrSvg: string }
export type FactorsInfo = { passkeys: PasskeyInfo[]; totp: boolean; recoveryCodes: number }

export type MfaVerifyInput =
  | { method: 'totp'; code: string }
  | { method: 'passkey'; response: AuthenticationResponse }
  | { method: 'recovery'; code: string }

export type StepUpVerifyInput =
  | { method: 'passkey'; response: AuthenticationResponse }
  | { method: 'totp'; code: string }
  | { method: 'password'; password: string }

export type NewCredential =
  | { kind: 'password'; password: string }
  | { kind: 'passkey'; response: RegistrationResponse; name: string }

export type GetPrefsResult = { values: Record<string, unknown>; updatedAt: number | null; stateless: boolean }

export interface AuthApi {
  // ---- setup (FR-AUT-003); `ok:false` of verifyToken is the wrong-token page -----------------------------
  setupGetState(): Promise<SetupStateResponse>
  setupVerifyToken(token: string): Promise<{ ok: true; csrf: string } | { ok: false }>
  setupSaveStep(input: SetupSaveStepInput): Promise<SetupDraft>
  setupPasskeyOptions(): Promise<CreationOptions>
  setupPasskeyVerify(response: RegistrationResponse, name: string): Promise<{ ok: true; recoveryCodes?: string[] }>
  setupTotpStart(): Promise<TotpStart>
  setupTotpVerify(code: string): Promise<{ recoveryCodes: string[] }>
  setupComplete(input: { codesSaved?: true; acknowledgeAdminNetwork?: boolean }): Promise<{ ok: true }>

  // ---- sign-in (FR-AUT-006, 011, 013) --------------------------------------------------------------------
  /** Decides setup, direct login, account login or the app; never throws for a missing session. */
  getAuthBoot(): Promise<AuthBoot>
  getLoginPageInfo(): Promise<LoginPageInfo>
  passwordSignIn(input: { username: string; password: string }): Promise<SignInOutcome>
  mfaOptions(method: MfaMethod): Promise<RequestOptions | { method: 'totp' | 'recovery' }>
  mfaVerify(input: MfaVerifyInput): Promise<SignInOutcome>
  passkeyBegin(): Promise<{ options: RequestOptions }>
  passkeyFinish(response: AuthenticationResponse): Promise<SignInOutcome>
  signOut(): Promise<{ ok: true }>
  stepUpOptions(method: StepUpMethod): Promise<RequestOptions | { method: 'totp' | 'password' }>
  stepUpVerify(input: StepUpVerifyInput): Promise<{ stepUpUntil: number }>

  // ---- account security (FR-AUT-005, 008 to 010, 017); not on the server yet ------------------------------
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ csrf?: string; state?: SessionState } | void>
  listFactors(): Promise<FactorsInfo>
  passkeyRegisterOptions(): Promise<CreationOptions>
  passkeyRegisterVerify(response: RegistrationResponse, name: string): Promise<{ recoveryCodes?: string[] }>
  passkeyRename(id: string, name: string): Promise<{ ok: true }>
  passkeyRemove(id: string): Promise<{ ok: true }>
  totpStart(): Promise<TotpStart>
  totpConfirm(code: string): Promise<{ recoveryCodes?: string[] }>
  totpRemove(): Promise<{ ok: true }>
  recoveryCodesRegenerate(): Promise<{ recoveryCodes: string[] }>
  disableMfa(): Promise<{ ok: true }>
  listSessions(): Promise<SessionInfo[]>
  revokeSession(ref: string): Promise<{ ok: true }>
  listNotices(): Promise<UserNotice[]>

  // ---- users (admin module, FR-AUT-014, 028); not on the server yet --------------------------------------
  listUsers(): Promise<UserSummary[]>
  createUser(input: { username: string; displayName: string; role: Role; password: string }): Promise<UserSummary>
  setUserStatus(userId: string, status: UserStatus): Promise<{ ok: true }>
  setUserRole(userId: string, role: Role): Promise<{ ok: true }>
  deleteUser(userId: string): Promise<{ ok: true }>
  revokeUserSessions(userId: string): Promise<{ revoked: number }>

  // ---- invites and recovery (FR-AUT-015, 016) ------------------------------------------------------------
  issueInvite(input: { role: Role; lifetimeMs?: number }): Promise<{ link: string; expiresAt: number }>
  listInvites(): Promise<InviteInfo[]>
  revokeInvite(id: string): Promise<{ ok: true }>
  invitePasskeyOptions(input: { token: string; username: string }): Promise<CreationOptions>
  redeemInvite(input: { token: string; username: string; displayName?: string; credential: NewCredential }): Promise<{ userId: string }>
  issueRecovery(userId: string): Promise<{ link: string; expiresAt: number }>
  recoveryPasskeyOptions(token: string): Promise<CreationOptions>
  redeemRecovery(input: { token: string; credential: NewCredential }): Promise<{ userId: string }>

  // ---- connections, vault, profiles (FR-AUT-018 to 022) --------------------------------------------------
  listConnections(): Promise<ConnectionInfo[]>
  openConnection(input: OpenConnectionInput): Promise<ConnectionInfo>
  closeConnection(connectionId: string): Promise<unknown>
  vaultStatus(): Promise<VaultStatus>
  vaultCreate(passphrase: string): Promise<{ recoveryKey: string }>
  vaultUnlock(passphrase: string): Promise<unknown>
  vaultLock(): Promise<unknown>
  vaultChangePassphrase(currentPassphrase: string, newPassphrase: string): Promise<unknown>
  vaultUseRecoveryKey(recoveryKey: string, newPassphrase: string): Promise<{ recoveryKey: string }>
  vaultRegenerateRecoveryKey(): Promise<{ recoveryKey: string }>
  vaultRotateKey(passphrase: string): Promise<{ recoveryKey: string }>
  listProfiles(): Promise<ProfileInfo[]>
  saveProfile(input: Partial<SaveProfileInput> & Pick<SaveProfileInput, 'name' | 'host'>): Promise<{ profile: ProfileInfo; test: 'ok' | 'failed' | 'skipped' }>
  testProfile(input: Partial<SaveProfileInput> & Pick<SaveProfileInput, 'name' | 'host'>): Promise<{ ok: true } | { ok: false; error: { code: string; targetMessage?: string } }>
  deleteProfile(id: string): Promise<unknown>

  // ---- preferences (FR-AUT-024, 025) ---------------------------------------------------------------------
  getPrefs(targetKey?: string): Promise<GetPrefsResult>
  setPref(key: string, value: unknown, targetKey?: string): Promise<{ ok: true; updatedAt: number | null }>
  exportPrefs(): Promise<{ fileName: string; json: string }>
  importPrefs(input: { json: string; mode?: 'merge' | 'replace'; validOnly?: boolean }): Promise<PrefImportResult>
  resetPrefs(): Promise<{ ok: true }>
}

// ---- Real implementation ---------------------------------------------------------------------------------

type Call = (arg?: { data?: unknown }) => Promise<unknown>
type Mod = Record<string, unknown>

/** Dynamic import of a functions file, one function out of it, called with `{data}`. */
async function call<T>(load: () => Promise<Mod>, name: string, data?: unknown): Promise<T> {
  const fn = (await load())[name] as Call | undefined
  if (typeof fn !== 'function') throw new AuthApiUnavailable(name)
  return (data === undefined ? fn() : fn({ data })) as Promise<T>
}

const setupMod = () => import('~/server/auth/setup.functions') as Promise<Mod>
const authMod = () => import('~/server/auth.functions') as Promise<Mod>
const inviteMod = () => import('~/server/auth/invites.functions') as Promise<Mod>
const recoveryMod = () => import('~/server/auth/recovery.functions') as Promise<Mod>
const accountMod = () => import('~/server/account.functions') as Promise<Mod>
const prefsMod = () => import('~/server/prefs.functions') as Promise<Mod>
const sessionMod = () => import('~/server/session.functions') as Promise<Mod>

/** Functions of package C that are not in a `*.functions.ts` yet are looked up in `auth.functions` first (so they light up once added). */
const tryAuth = <T>(name: string, data?: unknown) => call<T>(authMod, name, data)

export function createServerAuthApi(): AuthApi {
  const empty = {}
  return {
    setupGetState: () => call(setupMod, 'setupGetState', empty),
    setupVerifyToken: (token) => call(setupMod, 'setupVerifyToken', { token }),
    setupSaveStep: (input) => call(setupMod, 'setupSaveStep', input),
    setupPasskeyOptions: () => call(setupMod, 'setupPasskeyOptions', empty),
    setupPasskeyVerify: (response, name) => call(setupMod, 'setupPasskeyVerify', { response, name }),
    setupTotpStart: () => call(setupMod, 'setupTotpStart', empty),
    setupTotpVerify: (code) => call(setupMod, 'setupTotpVerify', { code }),
    setupComplete: (input) => call(setupMod, 'setupComplete', input),

    async getAuthBoot() {
      // Asked first and never failing: a server function that throws during the server render would set the page status.
      const boot = await call<{ setupPending: boolean }>(authMod, 'getBootState').catch(() => null)
      if (boot?.setupPending) return { kind: 'setup_pending' }
      let info: LoginPageInfo | undefined
      try {
        info = await call<LoginPageInfo>(authMod, 'getLoginPageInfo')
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        // Setup pending: every server function but the setup ones answers `setup_pending` (FR-AUT-001).
        if (message.includes('setup_pending')) {
          return { kind: 'setup_pending' }
        }
        // Not conclusive (stateless or direct installs have no account store): ask the setup function, else stay direct.
        const pending = await call<{ pending?: boolean }>(setupMod, 'setupGetState', {}).catch(() => null)
        if (pending?.pending) return { kind: 'setup_pending' }
      }
      // One function for both modes: `mode` of the answer says which view it is (null without a session).
      const raw = await call<DirectSessionView | AccountSessionView | null>(sessionMod, 'getSessionInfo')
      if (info && info.mode === 'account') {
        const session = raw && 'state' in raw ? (raw as AccountSessionView) : null
        if (session) setCsrfToken(session.csrf)
        return { kind: 'account', info, session }
      }
      return { kind: 'direct', session: raw && !('state' in raw) ? (raw as DirectSessionView) : null }
    },
    getLoginPageInfo: () => call(authMod, 'getLoginPageInfo'),
    passwordSignIn: (input) => call(authMod, 'passwordSignIn', input),
    mfaOptions: (method) => call(authMod, 'mfaOptions', { method }),
    mfaVerify: (input) => call(authMod, 'mfaVerify', input),
    passkeyBegin: () => call(authMod, 'passkeyBegin', empty),
    passkeyFinish: (response) => call(authMod, 'passkeyFinish', { response }),
    signOut: () => call(authMod, 'signOut', empty),
    stepUpOptions: (method) => call(authMod, 'stepUpOptions', { method }),
    stepUpVerify: (input) => call(authMod, 'stepUpVerify', input),

    changePassword: (input) => tryAuth('changePassword', input),
    listFactors: () => tryAuth('listFactors', empty),
    passkeyRegisterOptions: () => tryAuth('passkeyRegisterOptions', empty),
    passkeyRegisterVerify: (response, name) => tryAuth('passkeyRegisterVerify', { response, name }),
    passkeyRename: (id, name) => tryAuth('passkeyRename', { id, name }),
    passkeyRemove: (id) => tryAuth('passkeyRemove', { id }),
    totpStart: () => tryAuth('totpStart', empty),
    totpConfirm: (code) => tryAuth('totpConfirm', { code }),
    totpRemove: () => tryAuth('totpRemove', empty),
    recoveryCodesRegenerate: () => tryAuth('recoveryCodesRegenerate', empty),
    disableMfa: () => tryAuth('disableMfa', { confirm: true }),
    listSessions: () => tryAuth('listSessions', empty),
    revokeSession: (ref) => tryAuth('revokeSession', { ref }),
    listNotices: () => tryAuth('listNotices', empty),

    listUsers: () => tryAuth('listUsers', empty),
    createUser: (input) => tryAuth('createUser', input),
    setUserStatus: (userId, status) => tryAuth('setUserStatus', { userId, status }),
    setUserRole: (userId, role) => tryAuth('setUserRole', { userId, role }),
    deleteUser: (userId) => tryAuth('deleteUser', { userId }),
    revokeUserSessions: (userId) => tryAuth('revokeUserSessions', { userId }),

    issueInvite: (input) => call(inviteMod, 'issueInvite', input),
    listInvites: () => call(inviteMod, 'listInvites', empty),
    revokeInvite: (id) => call(inviteMod, 'revokeInvite', { id }),
    invitePasskeyOptions: (input) => call(inviteMod, 'invitePasskeyOptions', input),
    redeemInvite: (input) => call(inviteMod, 'redeemInvite', input),
    issueRecovery: (userId) => call(recoveryMod, 'issueRecovery', { userId }),
    recoveryPasskeyOptions: (token) => call(recoveryMod, 'recoveryPasskeyOptions', { token }),
    redeemRecovery: (input) => call(recoveryMod, 'redeemRecovery', input),

    listConnections: () => call(accountMod, 'listConnections'),
    openConnection: (input) => call(accountMod, 'openConnection', input),
    closeConnection: (connectionId) => call(accountMod, 'closeConnection', { connectionId }),
    vaultStatus: () => call(accountMod, 'vaultStatus'),
    vaultCreate: (passphrase) => call(accountMod, 'vaultCreate', { passphrase }),
    vaultUnlock: (passphrase) => call(accountMod, 'vaultUnlock', { passphrase }),
    vaultLock: () => call(accountMod, 'vaultLock', empty),
    vaultChangePassphrase: (currentPassphrase, newPassphrase) => call(accountMod, 'vaultChangePassphrase', { currentPassphrase, newPassphrase }),
    vaultUseRecoveryKey: (recoveryKey, newPassphrase) => call(accountMod, 'vaultUseRecoveryKey', { recoveryKey, newPassphrase }),
    vaultRegenerateRecoveryKey: () => call(accountMod, 'vaultRegenerateRecoveryKey', empty),
    vaultRotateKey: (passphrase) => call(accountMod, 'vaultRotateKey', { passphrase }),
    listProfiles: () => call(accountMod, 'listProfiles'),
    saveProfile: (input) => call(accountMod, 'saveProfile', input),
    testProfile: (input) => call(accountMod, 'testProfile', input),
    deleteProfile: (id) => call(accountMod, 'deleteProfile', { id }),

    getPrefs: (targetKey) => call(prefsMod, 'getPrefs', targetKey ? { targetKey } : {}),
    setPref: (key, value, targetKey) => call(prefsMod, 'setPref', { key, value, ...(targetKey ? { targetKey } : {}) }),
    exportPrefs: () => call(prefsMod, 'exportPrefs', empty),
    importPrefs: (input) => call(prefsMod, 'importPrefs', input),
    resetPrefs: () => call(prefsMod, 'resetPrefs', { confirm: true }),
  }
}

// ---- Selection ---------------------------------------------------------------------------------------------

export const MOCK_STORAGE_KEY = 'dbloom.authMock'

/** Mock layer on: build flag `VITE_DBLOOM_AUTH_MOCK=true`, or a scenario kept in this tab's session storage. */
export function isAuthMock(): boolean {
  if (import.meta.env.VITE_DBLOOM_AUTH_MOCK === 'true') return true
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('authMock') || window.sessionStorage.getItem(MOCK_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

let override: AuthApi | undefined
let real: AuthApi | undefined
let mock: AuthApi | undefined

/** Tests install a fake; `undefined` goes back to the selection by flag. */
export function setAuthApi(api: AuthApi | undefined): void {
  override = api
}

/** Read at call time, so a test can swap the implementation between renders. */
export function authApi(): AuthApi {
  if (override) return override
  if (isAuthMock()) return (mock ??= createMockAuthApi())
  return (real ??= createServerAuthApi())
}
