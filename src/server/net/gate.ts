/**
 * Global request gate (FR-SVR-006): the decision logic, pure and testable with fake requests. The Nitro middleware
 * (`gate-middleware.ts`) runs it first for EVERY route class (pages, assets, server functions, server routes).
 * Order: Host (003), OPTIONS (008), scheme (004), allow/deny slot (hardening), origin (006). The client address
 * (005) is computed once and returned.
 */
import { BODY_REFUSAL, checkBodyLimit, type Limits } from '../http/limits'
import { CidrList } from './cidr'
import { clientAddress, UNKNOWN_ADDRESS } from './client-address'
import { effectiveScheme, isHostAllowed, parsePublicOrigin, type OriginConfig } from './origin'

export type GateConfig = OriginConfig & {
  probeHosts: readonly string[]
  probeAllow: readonly string[]
  /** Body caps (FR-SVR-009); absent in tests that do not exercise them. */
  limits?: Pick<Limits, 'functionBodyKiB' | 'otherBodyKiB'>
}

export type RouteClass = 'function' | 'route' | 'asset' | 'page'

export type GateRequest = {
  method: string
  pathname: string
  headers: Headers
  /** TCP peer (never a header). */
  peer: string | undefined
  /** Scheme of the request URL as the listener saw it; used only when no public origin is configured. */
  urlScheme: 'http' | 'https'
}

export type DenyReason = 'host' | 'method' | 'scheme' | 'origin' | 'rule' | 'body' | 'probe'
export type GateOk = { ok: true; clientAddress: string; scheme: 'http' | 'https'; routeClass: RouteClass }
export type GateDeny = { ok: false; status: number; body: string; reason: DenyReason }
export type GateResult = GateOk | GateDeny

/** Server functions are served under this prefix (TanStack Start `serverFns.base`). */
export const SERVER_FN_BASE = '/_serverFn/'
/** Liveness and readiness probes: reachable under a probe host, from probe peers only (FR-SVR-010). */
export const PROBE_PATHS: readonly string[] = ['/api/health', '/api/ready']

/**
 * Server functions that carry a credential (password, one-time code, passkey assertion, recovery key, vault
 * passphrase, setup token, target password). Refused while the effective scheme and the origin disagree
 * (FR-SVR-004). The ONE list; `tests/gate-credential-functions.test.ts` checks it against the source. Every
 * function starting with a `CREDENTIAL_PREFIXES` entry is covered as well.
 */
export const CREDENTIAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'login',
  'passwordSignIn',
  'mfaOptions',
  'mfaVerify',
  'passkeyBegin',
  'passkeyFinish',
  'stepUpOptions',
  'stepUpVerify',
  'changePassword',
  'passkeyRegisterVerify',
  'totpConfirm',
  'totpRemove',
  'disableMfa',
  'recoveryCodesRegenerate',
  'createUser',
  'vaultCreate',
  'vaultUnlock',
  'vaultChangePassphrase',
  'vaultUseRecoveryKey',
  'vaultRegenerateRecoveryKey',
  'vaultRotateKey',
  'saveProfile',
  'testProfile',
  'openConnection',
  'invitePasskeyOptions',
  'redeemInvite',
  'recoveryPasskeyOptions',
  'redeemRecovery',
])
export const CREDENTIAL_PREFIXES: readonly string[] = ['setup']
/** Pages that take credentials: first-run wizard, invite and recovery links (login is a function call on `/`). */
export const CREDENTIAL_PAGES: readonly string[] = ['/setup', '/invite', '/recover']

export const SCHEME_REFUSAL = 'insecure_scheme'
export const ORIGIN_REFUSAL = 'forbidden_origin'

/**
 * Function name from a `/_serverFn/<id>` path. Build ids are `<file>.<name>` (vite.config.ts `generateFunctionId`);
 * dev ids are base64url JSON `{file, export}`. Unknown shapes give `undefined`.
 */
export function serverFunctionName(pathname: string): string | undefined {
  if (!pathname.startsWith(SERVER_FN_BASE)) return undefined
  const id = pathname.slice(SERVER_FN_BASE.length).replace(/\/+$/, '')
  if (!id) return undefined
  if (id.startsWith('eyJ')) {
    try {
      const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as { export?: unknown }
      return typeof parsed.export === 'string' ? parsed.export : undefined
    } catch {
      return undefined
    }
  }
  const name = id.split('.').pop()?.replace(/_\d+$/, '')
  return name || undefined
}

export function isCredentialFunction(name: string | undefined): boolean {
  if (name === undefined) return false
  return CREDENTIAL_FUNCTIONS.has(name) || CREDENTIAL_PREFIXES.some((p) => name.startsWith(p))
}

export function routeClassOf(pathname: string): RouteClass {
  if (pathname.startsWith(SERVER_FN_BASE)) return 'function'
  if (pathname === '/api' || pathname.startsWith('/api/')) return 'route'
  if (pathname.startsWith('/assets/')) return 'asset'
  return 'page'
}

const lists = new WeakMap<object, CidrList>()
function listOf(entries: readonly string[]): CidrList {
  let l = lists.get(entries)
  if (!l) lists.set(entries, (l = new CidrList(entries)))
  return l
}

function probeHostMatch(host: string, cfg: GateConfig): boolean {
  const h = host.trim().toLowerCase()
  const bare = h.replace(/:\d+$/, '')
  return cfg.probeHosts.some((p) => p === h || p === bare)
}

function deny(status: number, reason: DenyReason, body = ''): GateDeny {
  return { ok: false, status, reason, body }
}

/** The origin a same-origin browser request must name: the public origin, else scheme + Host of this request. */
function expectedOrigin(req: GateRequest, cfg: GateConfig, scheme: 'http' | 'https'): string {
  const parsed = cfg.publicOrigin ? parsePublicOrigin(cfg.publicOrigin) : null
  if (parsed?.ok) return parsed.value.origin
  return `${scheme}://${(req.headers.get('host') ?? '').trim().toLowerCase()}`
}

/** Origin / Sec-Fetch-Site rule for state-changing requests (SEC-TGT-134). Missing or `null` is refused. */
export function originAllowed(req: GateRequest, cfg: GateConfig, scheme: 'http' | 'https'): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.get('origin')
  if (origin !== null) return origin.trim().toLowerCase() === expectedOrigin(req, cfg, scheme)
  return site === 'same-origin' || site === 'none'
}

/**
 * Slot for the later allow/deny rules (SEC-TGT-128, 129; module `hardening`). Runs after the Host and scheme checks,
 * before the origin check, with the effective client address. Returns a denial or nothing.
 */
export function allowDenyRules(req: GateRequest, address: string, cfg: GateConfig): GateDeny | undefined {
  // HARDENING: allow/deny lists plug in here. Intentionally empty in module `server`.
  void [req, address, cfg]
  return undefined
}

export function evaluateGate(req: GateRequest, cfg: GateConfig): GateResult {
  const routeClass = routeClassOf(req.pathname)
  const address = clientAddress(req.peer, req.headers, cfg) || UNKNOWN_ADDRESS
  const host = req.headers.get('host')

  // 1. Host (FR-SVR-003). Empty body, value never echoed. Probe hosts only for the liveness path and probe peers.
  if (!isHostAllowed(host, cfg)) {
    const probe =
      req.method === 'GET' &&
      PROBE_PATHS.includes(req.pathname) &&
      typeof host === 'string' &&
      probeHostMatch(host, cfg) &&
      listOf(cfg.probeAllow).contains(req.peer)
    if (!probe) return deny(421, 'host')
  }

  // 2. CORS is off: no preflight is ever answered (FR-SVR-008).
  if (req.method === 'OPTIONS') return deny(405, 'method')

  // 2a. Probe paths answer probe peers only (SEC-TGT-132). Anyone else gets a bare 404, as if the route did not exist.
  if (PROBE_PATHS.includes(req.pathname) && !listOf(cfg.probeAllow).contains(req.peer)) return deny(404, 'probe')

  // 2b. Body cap by route class (FR-SVR-009): declared length, or an unbounded (chunked) body on a capped route.
  if (cfg.limits && checkBodyLimit(req.pathname, req.headers, cfg.limits)) return deny(413, 'body', BODY_REFUSAL)

  // 3. Effective scheme (FR-SVR-004).
  const eff = effectiveScheme(req.peer, req.headers, cfg, req.urlScheme)
  if (eff.mismatch) {
    const name = serverFunctionName(req.pathname)
    const credential =
      (routeClass === 'function' && (name === undefined || isCredentialFunction(name))) ||
      CREDENTIAL_PAGES.some((p) => req.pathname === p || req.pathname.startsWith(`${p}/`))
    if (credential) return deny(403, 'scheme', SCHEME_REFUSAL)
  }

  // 4. Allow/deny rules (hardening).
  const ruled = allowDenyRules(req, address, cfg)
  if (ruled) return ruled

  // 5. Origin for state-changing requests on functions and routes (FR-SVR-006).
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req, cfg, eff.scheme)) {
    return deny(403, 'origin', ORIGIN_REFUSAL)
  }

  return { ok: true, clientAddress: address, scheme: eff.scheme, routeClass }
}
