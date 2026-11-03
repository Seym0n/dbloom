import { describe, expect, it } from 'vitest'
import { isLoopbackHost, loadConfig, loadConfigWithWarnings, parseCidr } from '~/server/config'

type Env = Record<string, string>
const ORIGIN = 'https://db.example.com'
const PROXY = '10.0.0.0/8'
const nonLoop = { DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: ORIGIN, DBLOOM_TRUST_PROXY: PROXY }

describe('bind rule (FR-SVR-002, Q2)', () => {
  const refused: [string, Env, string][] = [
    ['0.0.0.0 without origin', { DBLOOM_HOST: '0.0.0.0', DBLOOM_TRUST_PROXY: PROXY }, 'DBLOOM_PUBLIC_ORIGIN'],
    ['0.0.0.0 without proxy', { DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: ORIGIN }, 'DBLOOM_TRUST_PROXY'],
    ['0.0.0.0 with proxy=false', { ...nonLoop, DBLOOM_TRUST_PROXY: 'false' }, 'DBLOOM_TRUST_PROXY'],
    ['LAN address bare', { DBLOOM_HOST: '192.168.1.5' }, 'DBLOOM_PUBLIC_ORIGIN'],
    ['IPv6 any', { DBLOOM_HOST: '::', DBLOOM_PUBLIC_ORIGIN: ORIGIN }, 'DBLOOM_TRUST_PROXY'],
    ['own TLS on loopback', { DBLOOM_TLS: 'own' }, 'DBLOOM_TLS'],
    ['own TLS with everything', { ...nonLoop, DBLOOM_TLS: 'own' }, 'DBLOOM_TLS'],
    ['bad proxy list', { ...nonLoop, DBLOOM_TRUST_PROXY: 'proxy.example.com' }, 'DBLOOM_TRUST_PROXY'],
  ]
  it.each(refused)('refuses %s', (_n, env, name) => {
    expect(() => loadConfig(env)).toThrow(new RegExp(name))
  })

  const accepted: [string, Env][] = [
    ['default', {}],
    ['localhost', { DBLOOM_HOST: 'localhost' }],
    ['::1', { DBLOOM_HOST: '::1' }],
    [
      'image + compose',
      { ...nonLoop, DBLOOM_TRUST_PROXY: '172.16.0.0/12,fd00::/8', NODE_ENV: 'production', DBLOOM_DATA_DIR: '/data', PORT: '3000' },
    ],
    ['legacy proxy true', { ...nonLoop, DBLOOM_TRUST_PROXY: 'true' }],
  ]
  it.each(accepted)('accepts %s', (_n, env) => {
    expect(() => loadConfig(env)).not.toThrow()
  })

  it('image start with origin and proxy supplied', () => {
    const { config, warnings } = loadConfigWithWarnings(nonLoop)
    expect(config.allowedHosts).toEqual(['db.example.com'])
    expect(config.trustedProxies).toEqual(['10.0.0.0/8'])
    expect(config.trustProxy).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('legacy DBLOOM_TRUST_PROXY (Q4)', () => {
  it.each(['true', '1', 'TRUE'])('%s warns and keeps trustProxy', (v) => {
    const { config, warnings } = loadConfigWithWarnings({ DBLOOM_TRUST_PROXY: v })
    expect(config.trustProxy).toBe(true)
    expect(config.trustProxyLegacy).toBe(true)
    expect(config.trustedProxies).toEqual([])
    expect(warnings.some((w) => w.includes('DBLOOM_TRUST_PROXY'))).toBe(true)
  })
  it.each(['false', '0', ''])('%j is off without warning', (v) => {
    const { config, warnings } = loadConfigWithWarnings({ DBLOOM_TRUST_PROXY: v })
    expect(config.trustProxy).toBe(false)
    expect(warnings).toEqual([])
  })
})

describe('public origin and allowed hosts (FR-SVR-003)', () => {
  const bad = ['db.example.com', 'ftp://x.com', 'https://x.com/path', 'https://u:p@x.com', 'https://x.com?a=1', 'http://db.example.com', 'http://10.0.0.1']
  it.each(bad)('refuses origin %s', (o) => {
    expect(() => loadConfig({ DBLOOM_PUBLIC_ORIGIN: o })).toThrow(/DBLOOM_PUBLIC_ORIGIN/)
  })
  const good = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://db.example.com:8443']
  it.each(good)('accepts origin %s', (o) => {
    expect(loadConfig({ DBLOOM_PUBLIC_ORIGIN: o }).publicOrigin).toBe(new URL(o).origin)
  })
  it('default allowed hosts is the origin host including a non-default port', () => {
    expect(loadConfig({ DBLOOM_PUBLIC_ORIGIN: 'https://DB.example.com:8443' }).allowedHosts).toEqual(['db.example.com:8443'])
  })
  it('explicit list is lower-cased and trimmed', () => {
    expect(loadConfig({ DBLOOM_ALLOWED_HOSTS: ' A.example.com , b.example.com:8080 ' }).allowedHosts).toEqual([
      'a.example.com',
      'b.example.com:8080',
    ])
  })
  it.each(['a b', 'x/y', 'http://x.com', 'x..', '-x.com'])('refuses malformed host %j', (h) => {
    expect(() => loadConfig({ DBLOOM_ALLOWED_HOSTS: h })).toThrow(/DBLOOM_ALLOWED_HOSTS/)
  })
  it('wildcards: loopback bind only', () => {
    expect(loadConfig({ DBLOOM_ALLOWED_HOSTS: '*.localhost' }).allowedHosts).toEqual(['*.localhost'])
    for (const h of ['*', '*.example.com']) {
      expect(() => loadConfig({ ...nonLoop, DBLOOM_ALLOWED_HOSTS: h })).toThrow(/DBLOOM_ALLOWED_HOSTS/)
    }
  })
})

describe('store and mode rules (FR-SVR-017)', () => {
  it('stateless with account mode is refused', () => {
    expect(() => loadConfig({ DBLOOM_STORE: 'none', DBLOOM_LOGIN_MODE: 'account' })).toThrow(/DBLOOM_STORE=none/)
  })
  const table: [Env, 'sqlite' | 'none'][] = [
    [{ DBLOOM_STORE: 'none' }, 'none'],
    [{ DBLOOM_STORE: 'none', DBLOOM_LOGIN_MODE: 'direct' }, 'none'],
    [{ DBLOOM_LOGIN_MODE: 'account' }, 'sqlite'],
    [{}, 'sqlite'],
  ]
  it.each(table)('%j -> %s', (env, store) => {
    expect(loadConfig(env).store).toBe(store)
  })
})

describe('log and HSTS rules', () => {
  it('debug in production needs the acknowledgement and then warns', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DBLOOM_LOG_LEVEL: 'debug' })).toThrow(/DBLOOM_ALLOW_DEBUG/)
    const r = loadConfigWithWarnings({ NODE_ENV: 'production', DBLOOM_LOG_LEVEL: 'debug', DBLOOM_ALLOW_DEBUG: 'true' })
    expect(r.warnings).toHaveLength(1)
    expect(loadConfig({ DBLOOM_LOG_LEVEL: 'debug' }).logLevel).toBe('debug')
  })
  it('HSTS off warns', () => {
    const r = loadConfigWithWarnings({ DBLOOM_HSTS: 'off' })
    expect(r.config.hsts.enabled).toBe(false)
    expect(r.warnings.join()).toContain('DBLOOM_HSTS')
  })
})

describe('helpers', () => {
  const cidrs: [string, string | null][] = [
    ['10.0.0.0/8', '10.0.0.0/8'],
    ['10.1.2.3', '10.1.2.3/32'],
    ['::1', '::1/128'],
    ['FD00::/8', 'fd00::/8'],
    ['10.0.0.0/33', null],
    ['::/129', null],
    ['10.0.0/8', null],
    ['a/b', null],
    ['10.0.0.0/8/1', null],
    ['', null],
  ]
  it.each(cidrs)('parseCidr(%j) = %j', (input, out) => {
    expect(parseCidr(input)).toBe(out)
  })
  const hosts: [string, boolean][] = [
    ['127.0.0.1', true], ['127.9.9.9', true], ['localhost', true], ['[::1]', true], ['::1', true],
    ['0.0.0.0', false], ['::', false], ['10.0.0.1', false], ['example.com', false],
  ]
  it.each(hosts)('isLoopbackHost(%s) = %s', (h, r) => {
    expect(isLoopbackHost(h)).toBe(r)
  })
})
