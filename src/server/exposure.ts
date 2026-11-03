import { loadConfigWithWarnings, type Config } from './config'

/**
 * Exposure report (FR-SVR-011, SEC-TGT-125, DEP-TGT-122). Pure: reads the environment, prints effective settings and the
 * warnings that apply today. Never a secret, never a key value; paths and counts only.
 */
export type ExposureReport = {
  lines: [label: string, value: string][]
  warnings: string[]
}

const list = (xs: string[]) => (xs.length === 0 ? '(none)' : xs.join(', '))

export function buildExposure(config: Config, env: NodeJS.ProcessEnv, configWarnings: string[] = []): ExposureReport {
  const loginMode = env.DBLOOM_LOGIN_MODE?.trim() || (config.store === 'none' ? 'direct' : 'chosen by setup wizard')
  const loopbackBind = config.host === '127.0.0.1' || config.host === '::1' || config.host === 'localhost'
  const scheme = config.publicOrigin ? config.publicOrigin.split(':')[0]! : 'http (loopback only)'
  const direct = loginMode === 'direct'
  const freeForm = direct && config.allowedTargets.length === 0 && config.freeFormAck

  const lines: ExposureReport['lines'] = [
    ['bind', `${config.host}:${config.port}${loopbackBind ? ' (loopback)' : ''}`],
    ['public origin', config.publicOrigin ?? '(unset)'],
    ['scheme', scheme],
    ['allowed hosts', list(config.allowedHosts)],
    [
      'trusted proxies',
      config.trustProxyLegacy ? 'legacy: any private-range peer' : list(config.trustedProxies),
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

  const warnings = [...configWarnings]
  if (!loopbackBind && config.publicOrigin?.startsWith('http:')) warnings.push('Public origin is not https')
  if (config.trustProxyLegacy) warnings.push('Legacy trust-proxy accepts any private-range peer')
  if (freeForm) warnings.push('Direct mode accepts any database target (free-form)')
  if (config.tls === 'skip-verify' || config.tls === 'off') warnings.push(`Target TLS is ${config.tls}`)
  if (config.allowLoopback || config.allowPrivate) warnings.push('Targets on loopback or private networks are allowed')
  if (config.allowedHosts.some((h) => h.includes('*'))) warnings.push('Allowed hosts contain a wildcard')
  if (config.probeAllow.some((c) => c === '0.0.0.0/0' || c === '::/0')) warnings.push('Probe endpoints are open to every address')
  return { lines, warnings: [...new Set(warnings)] }
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
