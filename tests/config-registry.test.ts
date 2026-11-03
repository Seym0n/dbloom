import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ENV_NAMES, ENV_VARS, loadConfig, loadConfigWithWarnings, renderEnvExample } from '~/server/config'

describe('env registry', () => {
  it('has unique names with sane ranges', () => {
    expect(ENV_NAMES.size).toBe(ENV_VARS.length)
    for (const e of ENV_VARS) {
      if (e.min !== undefined && e.max !== undefined) expect(e.min).toBeLessThanOrEqual(e.max)
      if (e.kind === 'enum') expect(e.values?.length).toBeGreaterThan(0)
    }
  })

  it('.env.example names equal the schema names and the file is the generated one', () => {
    const text = readFileSync('.env.example', 'utf8').replace(/\r\n/g, '\n')
    const names = [...text.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]).sort()
    expect(names).toEqual([...ENV_NAMES].sort())
    expect(text).toBe(renderEnvExample())
  })

  it('every registered config default loads', () => {
    const env: Record<string, string> = {}
    for (const e of ENV_VARS) if (e.owner === 'config' && e.default && e.name !== 'DBLOOM_DATA_DIR') env[e.name] = e.default
    expect(() => loadConfig(env)).not.toThrow()
  })
})

describe('strict numeric, enum and bool variables', () => {
  const cases: [string, string, boolean][] = [
    ['PORT', '0', false],
    ['PORT', '65536', false],
    ['PORT', 'abc', false],
    ['PORT', '8080', true],
    ['DBLOOM_PROXY_HOPS', '17', false],
    ['DBLOOM_PROXY_HOPS', '2', true],
    ['DBLOOM_HSTS', 'maybe', false],
    ['DBLOOM_HSTS_MAX_AGE', '-1', false],
    ['DBLOOM_HSTS_SUBDOMAINS', 'yes', false],
    ['DBLOOM_HSTS_SUBDOMAINS', 'true', true],
    ['DBLOOM_SHUTDOWN_SECONDS', '0', false],
    ['DBLOOM_SHUTDOWN_SECONDS', '301', false],
    ['DBLOOM_LOG_LEVEL', 'trace', false],
    ['DBLOOM_LOG_LEVEL', 'WARN', true],
    ['DBLOOM_BODY_LIMIT_OTHER_KIB', '0', false],
    ['DBLOOM_BODY_LIMIT_OTHER_KIB', '1.5', false],
    ['DBLOOM_PROBE_ALLOW', '10.0.0.0/33', false],
    ['DBLOOM_PROBE_ALLOW', '10.0.0.0/8,::1', true],
    ['DBLOOM_PROBE_HOSTS', '*.x', false],
  ]
  it.each(cases)('%s=%s accepted: %s', (name, value, ok) => {
    const run = () => loadConfig({ [name]: value })
    if (ok) expect(run).not.toThrow()
    else expect(run).toThrow(new RegExp(name))
  })

  it('errors never contain the value', () => {
    try {
      loadConfig({ PORT: 'supersecretvalue' })
      throw new Error('did not throw')
    } catch (e) {
      expect((e as Error).message).toContain('PORT')
      expect((e as Error).message).not.toContain('supersecretvalue')
    }
  })
})

describe('defaults', () => {
  it('match SPEC/27', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      publicOrigin: undefined,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000'],
      trustedProxies: [],
      trustProxy: false,
      tlsMode: 'proxy',
      shutdownSeconds: 25,
      logLevel: 'info',
      probeHosts: ['localhost', '127.0.0.1'],
      probeAllow: ['127.0.0.0/8', '::1/128'],
      store: 'sqlite',
    })
    expect(c.hsts).toEqual({ enabled: true, maxAgeSeconds: 31_536_000, includeSubDomains: false })
    expect(c.limits.functionBodyKiB).toBe(1024)
  })
})

describe('unknown names and placeholders', () => {
  it('warns on unknown DBLOOM_ names, suggests the near one, never prints values', () => {
    const { warnings } = loadConfigWithWarnings({
      DBLOOM_PUBLIC_ORIGN: 'https://secret.example',
      DBLOOM_ZZZZZZZZ: '1',
      OTHER: 'x',
    })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('DBLOOM_PUBLIC_ORIGIN')
    expect(warnings.join()).not.toContain('secret.example')
    expect(warnings[1]).not.toContain('did you mean')
  })

  it.each(['change-me', 'CHANGE_ME', '<change-me>', 'your-secret-here', 'replace-me', 'xxxxxx'])(
    'placeholder %s stops startup naming only the variable',
    (value) => {
      for (const name of ['DBLOOM_SECRET_KEY', 'DBLOOM_PUBLIC_ORIGIN', 'DBLOOM_SETUP_TOKEN']) {
        let message = ''
        try {
          loadConfig({ [name]: value })
        } catch (e) {
          message = (e as Error).message
        }
        expect(message).toContain(name)
        expect(message).not.toContain(value)
      }
    },
  )

  it('empty values count as unset', () => {
    expect(() =>
      loadConfig({ DBLOOM_SECRET_KEY: '', DBLOOM_PUBLIC_ORIGIN: '', DBLOOM_TRUST_PROXY: '', PORT: '' }),
    ).not.toThrow()
  })
})
