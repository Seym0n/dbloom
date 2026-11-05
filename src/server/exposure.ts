import { createHash } from 'node:crypto'
import { loadConfigWithWarnings, type Config } from './config'

/**
 * Exposure report (FR-SVR-011, SEC-TGT-125, DEP-TGT-122). Pure: reads the environment, prints effective settings and the
 * warnings that apply today. Never a secret, never a key value; paths and counts only.
 */
/** A warning with a stable id: the id survives rewording and is what an acknowledgement refers to (SPEC/31 FR-AEX-001). */
export type ExposureWarning = { id: string; text: string }

export type ExposureReport = {
  lines: [label: string, value: string][]
  /** The texts, exactly as the command line and the startup log print them. */
  warnings: string[]
  /** The same warnings with ids, one to one with `warnings`. */
  items: ExposureWarning[]
}

/** Ids of the warnings that `loadConfigWithWarnings` produces; any other text gets an id from its hash. */
export function configWarningId(text: string): string {
  const unknown = /^Unknown variable (\S+) is ignored/.exec(text)
  if (unknown) return `unknown-variable:${unknown[1]}`
  if (text.startsWith('DBLOOM_TRUST_PROXY=true is deprecated')) return 'trust-proxy-deprecated'
  if (text.startsWith('DBLOOM_HSTS=off')) return 'hsts-off'
  if (text.startsWith('Debug logging is enabled in production')) return 'debug-logging'
  return `config-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`
}

/** A bind address that only this machine can reach. */
export const isLoopbackBind = (host: string): boolean => host === '127.0.0.1' || host === '::1' || host === 'localhost'

const list = (xs: string[]) => (xs.length === 0 ? '(none)' : xs.join(', '))

export function buildExposure(config: Config, env: NodeJS.ProcessEnv, configWarnings: string[] = []): ExposureReport {
  const loginMode = env.DBLOOM_LOGIN_MODE?.trim() || (config.store === 'none' ? 'direct' : 'chosen by setup wizard')
  const loopbackBind = isLoopbackBind(config.host)
  const scheme = config.publicOrigin ? config.publicOrigin.split(':')[0]! : config.originDerived ? 'from X-Forwarded-Proto' : 'http (loopback only)'
  const direct = loginMode === 'direct'
  const freeForm = direct && config.allowedTargets.length === 0 && config.freeFormAck

  const lines: ExposureReport['lines'] = [
    ['bind', `${config.host}:${config.port}${loopbackBind ? ' (loopback)' : ''}`],
    ['public origin', config.publicOrigin ?? (config.originDerived ? '(derived from each request via the proxy)' : '(unset)')],
    ['scheme', scheme],
    ['allowed hosts', list(config.allowedHosts)],
    [
      'trusted proxies',
      config.trustProxyImplicit
        ? 'any private-range peer (default)'
        : config.trustProxyLegacy
          ? 'legacy: any private-range peer'
          : list(config.trustedProxies),
    ],
    ['proxy hops', config.proxyHops > 0 ? String(config.proxyHops) : '(unused)'],
    [
      'hsts',
      config.hsts.enabled
        ? `on, max-age ${config.hsts.maxAgeSeconds}${config.hsts.includeSubDomains ? ', includeSubDomains' : ''}`
        : 'off',
    ],
    ['probe hosts', list(config.probeHosts)],
    ['probe allow', list(config.probeAllow)],
    ['login mode', loginMode],
    ['store', config.store === 'none' ? 'none (stateless)' : `sqlite in ${config.dataDir}`],
    [
      'direct targets',
      !direct
        ? '(not used)'
        : config.allowedTargets.length > 0
          ? `allow-list of ${config.allowedTargets.length}`
          : freeForm
            ? 'free-form (acknowledged)'
            : 'missing: startup refuses',
    ],
    ['temp dir', config.tempDir ?? `${config.dataDir}/tmp`],
    ['import dir', config.importDir ?? '(disabled)'],
    ['target tls', config.tls],
    ['diagnostics', config.allowDebug || config.logLevel === 'debug' ? `log level ${config.logLevel}, debug allowed` : `log level ${config.logLevel}`],
  ]

  const items: ExposureWarning[] = configWarnings.map((text) => ({ id: configWarningId(text), text }))
  const warn = (id: string, text: string) => void items.push({ id, text })
  if (!loopbackBind && config.publicOrigin?.startsWith('http:')) warn('origin-not-https', 'Public origin is not https')
  if (config.originDerived) warn('origin-derived', 'No public origin is set: the origin comes from each request, and any Host reaching the proxy is answered')
  if (config.trustProxyImplicit) warn('implicit-trust-proxy', 'No trusted proxy list is set: any private-range peer is trusted; set DBLOOM_TRUST_PROXY to narrow it')
  else if (config.trustProxyLegacy) warn('legacy-trust-proxy', 'Legacy trust-proxy accepts any private-range peer')
  if (freeForm) warn('direct-free-form', 'Direct mode accepts any database target (free-form)')
  if (config.tls === 'skip-verify' || config.tls === 'off') warn('target-tls', `Target TLS is ${config.tls}`)
  if (config.allowLoopback || config.allowPrivate) warn('private-targets', 'Targets on loopback or private networks are allowed')
  if (!config.originDerived && config.allowedHosts.some((h) => h.includes('*'))) warn('wildcard-hosts', 'Allowed hosts contain a wildcard')
  if (config.probeAllow.some((c) => c === '0.0.0.0/0' || c === '::/0')) warn('probe-open', 'Probe endpoints are open to every address')
  // One entry per text (as the command line always did); the first id wins.
  const seen = new Set<string>()
  const unique = items.filter((w) => (seen.has(w.text) ? false : (seen.add(w.text), true)))
  return { lines, warnings: unique.map((w) => w.text), items: unique }
}

export function renderExposure(report: ExposureReport): string {
  const width = Math.max(...report.lines.map(([k]) => k.length))
  const body = report.lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`)
  const warn = report.warnings.length === 0 ? ['Warnings: none'] : ['Warnings:', ...report.warnings.map((w) => `  - ${w}`)]
  return [...body, '', ...warn].join('\n') + '\n'
}

/** Loads the configuration from `env` and renders the report; a refused configuration is returned as text, exit 1. */
export function exposureCommand(env: NodeJS.ProcessEnv): { stdout: string; exitCode: number } {
  try {
    const { config, warnings } = loadConfigWithWarnings(env)
    return { stdout: renderExposure(buildExposure(config, env, warnings)), exitCode: 0 }
  } catch (error) {
    return { stdout: `Configuration refused: ${error instanceof Error ? error.message : 'invalid'}\n`, exitCode: 1 }
  }
}
