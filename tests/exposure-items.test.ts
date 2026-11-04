import { describe, expect, it } from 'vitest'
import { loadConfigWithWarnings } from '../src/server/config'
import { buildExposure, configWarningId, exposureCommand, renderExposure } from '../src/server/exposure'

const topologies: Record<string, Record<string, string>> = {
  'local default': { DBLOOM_DIRECT_TARGETS: 'db:3306' },
  'behind proxy': { DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com', DBLOOM_TRUST_PROXY: '172.18.0.0/16', DBLOOM_LOGIN_MODE: 'account' },
  'risky stateless': { DBLOOM_STORE: 'none', DBLOOM_DIRECT_FREE_FORM_ACK: 'true', DBLOOM_TARGET_TLS: 'skip-verify', DBLOOM_ALLOW_PRIVATE: 'true' },
}
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv
const report = (e: Record<string, string>) => {
  const { config, warnings } = loadConfigWithWarnings(env(e))
  return buildExposure(config, env(e), warnings)
}

describe('warning ids', () => {
  it('items match warnings one to one, in the same order', () => {
    for (const [name, e] of Object.entries(topologies)) {
      const r = report(e)
      expect(r.items.map((i) => i.text), name).toEqual(r.warnings)
      expect(new Set(r.items.map((i) => i.id)).size, name).toBe(r.items.length)
    }
  })

  it('every environment warning has its stable id', () => {
    const risky = report({
      DBLOOM_STORE: 'none', DBLOOM_DIRECT_FREE_FORM_ACK: 'true', DBLOOM_TARGET_TLS: 'off', DBLOOM_ALLOW_LOOPBACK: 'true',
      DBLOOM_ALLOWED_HOSTS: '*.example.com', DBLOOM_PROBE_ALLOW: '0.0.0.0/0', DBLOOM_HSTS: 'off', DBLOOM_TRUST_PROXY: 'true', DBLOOM_NOPE: '1',
    })
    const http = report({ DBLOOM_STORE: 'none', DBLOOM_DIRECT_TARGETS: 'db:3306', DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: 'http://localhost:3000', DBLOOM_TRUST_PROXY: '10.0.0.0/8' })
    const ids = [...risky.items, ...http.items].map((i) => i.id)
    for (const id of ['origin-not-https', 'legacy-trust-proxy', 'direct-free-form', 'target-tls', 'private-targets', 'wildcard-hosts', 'probe-open', 'hsts-off', 'trust-proxy-deprecated', 'unknown-variable:DBLOOM_NOPE'])
      expect(ids, id).toContain(id)
  })

  it('ids do not depend on the wording of the value part: the target TLS id is the same for skip-verify and off', () => {
    const a = report({ DBLOOM_DIRECT_FREE_FORM_ACK: 'true', DBLOOM_STORE: 'none', DBLOOM_TARGET_TLS: 'skip-verify' }).items.find((i) => i.id === 'target-tls')
    const b = report({ DBLOOM_DIRECT_FREE_FORM_ACK: 'true', DBLOOM_STORE: 'none', DBLOOM_TARGET_TLS: 'off' }).items.find((i) => i.id === 'target-tls')
    expect(a?.text).toContain('skip-verify')
    expect(b?.text).toContain('off')
  })

  it('config warnings: the known ones keep their id, any other gets a hash id that does not change', () => {
    expect(configWarningId('DBLOOM_HSTS=off disables Strict-Transport-Security')).toBe('hsts-off')
    expect(configWarningId('Debug logging is enabled in production (DBLOOM_ALLOW_DEBUG=true)')).toBe('debug-logging')
    expect(configWarningId('Unknown variable DBLOOM_TLZ is ignored (did you mean DBLOOM_TLS?)')).toBe('unknown-variable:DBLOOM_TLZ')
    const other = configWarningId('Some future warning')
    expect(other).toMatch(/^config-[0-9a-f]{8}$/)
    expect(configWarningId('Some future warning')).toBe(other)
  })
})

describe('the page and the command show the same report (FR-AEX-007)', () => {
  it('for each topology the rendered text of the page report equals the command output', () => {
    for (const [name, e] of Object.entries(topologies)) {
      expect(renderExposure(report(e)), name).toBe(exposureCommand(env(e)).stdout)
    }
  })
  it('the lines and warnings of both builds are equal', () => {
    for (const e of Object.values(topologies)) {
      const a = report(e)
      const b = report({ ...e })
      expect(a).toEqual(b)
    }
  })
})
