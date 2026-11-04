import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { loadConfigWithWarnings } from '../src/server/config'
import { AuthError, type AccountContext } from '../src/server/auth/types'
import { buildExposure } from '../src/server/exposure'
import { acknowledgeExposureInput } from '../src/server/exposure.functions'
import { createExposureService, type StatusBlock } from '../src/server/exposure-service'
import { createExposureState, UnknownWarning, type RuntimeProbe } from '../src/server/exposure-state'

const SECRET = 'sUpErSeCrEt-key-value-1234567890'
const ENV = {
  DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com', DBLOOM_TRUST_PROXY: '172.18.0.0/16', DBLOOM_LOGIN_MODE: 'account',
  DBLOOM_SECRET_KEY: SECRET, DBLOOM_SETUP_TOKEN: 'tok-abcdef-0123456789', DBLOOM_ALLOW_PRIVATE: 'true',
} as unknown as NodeJS.ProcessEnv

const STATUS: StatusBlock = { ready: true, readyState: 'ok', loginMode: 'account', store: 'ok', schemaVersion: 7, version: '1.2.3', auditSink: { sink: 'stdout', state: 'ok' } }
const probe: RuntimeProbe = { mode: () => 'account', mfaScope: () => 'none', sink: () => ({ sink: 'stdout', state: 'ok' }) }

function rig(audit: (e: string, f: Record<string, unknown>) => void = () => undefined) {
  const { config, warnings } = loadConfigWithWarnings(ENV)
  const report = buildExposure(config, ENV, warnings)
  const state = createExposureState({ report, host: config.host, startedAt: 10, probe, now: () => 99, auditRequired: audit as never })
  const users = new Map([
    ['a1', { id: 'a1', role: 'admin', status: 'active', username: 'root', displayName: 'Root Admin' }],
    ['a2', { id: 'a2', role: 'admin', status: 'disabled', username: 'off', displayName: '' }],
    ['u1', { id: 'u1', role: 'user', status: 'active', username: 'ann', displayName: 'Ann' }],
  ])
  const service = createExposureService({ state, store: { getUser: (id: string) => users.get(id) as never }, status: () => STATUS })
  return { service }
}
const ctx = (id: string | null, role: 'admin' | 'user' = 'user', state: AccountContext['state'] = 'full'): AccountContext => ({
  idHash: 'h', csrf: 'c', kind: 'account', state, ownerKey: `u:${id}`, mfaAt: null, stepupAt: null,
  user: id ? { id, username: id, displayName: id, role, securityVersion: 0 } : null,
})

describe('role matrix', () => {
  it('an administrator reads the report, the warnings and the status block', () => {
    const a = rig().service.get(ctx('a1', 'admin'))
    expect(a.asOf).toBe(10)
    expect(a.status).toEqual(STATUS)
    expect(a.lines.some(([k, v]) => k === 'public origin' && v === 'https://db.example.com')).toBe(true)
    expect(a.items.map((i) => i.id)).toEqual(['private-targets', 'no-mfa', 'admin-any-address'])
    expect(a.banner).toEqual({ raised: true, count: 3 })
  })

  it.each([
    ['ordinary user', ctx('u1', 'user')],
    ['no user', ctx(null)],
    ['disabled administrator', ctx('a2', 'admin')],
    ['administrator before MFA', ctx('a1', 'admin', 'pending_mfa')],
    ['role claimed in the session but row says user', ctx('u1', 'admin')],
  ])('get and acknowledge refuse: %s', (_n, c) => {
    const { service } = rig()
    expect(() => service.get(c)).toThrow(AuthError)
    expect(() => service.acknowledge(c, 'no-mfa')).toThrow(AuthError)
  })
})

describe('acknowledge', () => {
  it('writes the audit row with the administrator as actor, then shows who acknowledged', () => {
    const rows: Record<string, unknown>[] = []
    const { service } = rig((e, f) => void rows.push({ e, ...f }))
    service.acknowledge(ctx('a1', 'admin'), 'no-mfa')
    expect(rows).toEqual([{ e: 'exposure.ack', actor: 'a1', outcome: 'ok', subject: 'no-mfa' }])
    expect(service.get(ctx('a1', 'admin')).items.find((i) => i.id === 'no-mfa')?.acknowledged).toEqual({ by: 'Root Admin', at: 99 })
  })
  it('an unknown id changes nothing', () => {
    const write = vi.fn()
    const { service } = rig(write)
    expect(() => service.acknowledge(ctx('a1', 'admin'), 'nope')).toThrow(UnknownWarning)
    expect(write).not.toHaveBeenCalled()
  })
  it('the input accepts warning ids only', () => {
    for (const id of ['no-mfa', 'unknown-variable:DBLOOM_X', 'config-0a1b2c3d']) expect(acknowledgeExposureInput.safeParse({ id }).success).toBe(true)
    for (const id of ['', ' ', 'a b', 'x'.repeat(101), "a'; drop", '../x']) expect(acknowledgeExposureInput.safeParse({ id }).success).toBe(false)
    expect(acknowledgeExposureInput.safeParse({ id: 'ok', extra: 1 }).success).toBe(false)
  })
})

describe('what an answer may contain', () => {
  it('no secret value from the environment, no key, no token', () => {
    const json = JSON.stringify(rig().service.get(ctx('a1', 'admin')))
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('tok-abcdef-0123456789')
    expect(json).not.toMatch(/secret.?key/i)
  })
})

describe('client chunk', () => {
  it('exposure.functions.ts imports only thin modules (it is loaded in the browser)', () => {
    const src = readFileSync('src/server/exposure.functions.ts', 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]!)
    expect(imports.sort()).toEqual(['./auth/error-transport', './exposure-runtime', './middleware', '@tanstack/react-start', 'zod'])
  })
  it('exports no more than the two functions and the input schema', () => {
    const src = readFileSync('src/server/exposure.functions.ts', 'utf8')
    expect([...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!).sort()).toEqual(['acknowledgeExposure', 'acknowledgeExposureInput', 'getExposure'])
  })
})
