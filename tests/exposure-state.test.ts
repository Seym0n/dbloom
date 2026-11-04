import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditUnavailable, registerAuditStore, unregisterAuditStore } from '../src/server/audit'
import { resetSinks } from '../src/server/audit/sink'
import { loadConfigWithWarnings } from '../src/server/config'
import { buildExposure } from '../src/server/exposure'
import { bannerOf, createExposureState, runtimeWarnings, UnknownWarning, type RuntimeProbe } from '../src/server/exposure-state'
import { openSqliteStore, type SqliteStore } from '../src/server/store/sqlite-store'

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv
const reportOf = (e: Record<string, string>) => {
  const { config, warnings } = loadConfigWithWarnings(env(e))
  return { config, report: buildExposure(config, env(e), warnings) }
}
const probe = (p: Partial<{ mode: ReturnType<RuntimeProbe['mode']>; mfa: string; sink: { sink: string; state: string } }> = {}): RuntimeProbe => ({
  mode: () => p.mode ?? 'account',
  mfaScope: () => p.mfa ?? 'all',
  sink: () => p.sink ?? { sink: 'stdout', state: 'ok' },
})
const ids = (p: RuntimeProbe) => runtimeWarnings(p).map((w) => w.id)

describe('runtime warnings', () => {
  it('account mode: no enforced second factor and the open administration pages', () => {
    expect(ids(probe({ mfa: 'none' }))).toEqual(['no-mfa', 'admin-any-address'])
    expect(ids(probe({ mfa: 'all' }))).toEqual(['admin-any-address'])
    expect(ids(probe({ mfa: 'admins' }))).toEqual(['admin-any-address'])
  })
  it('setup still open', () => {
    expect(ids(probe({ mode: 'setup' }))).toEqual(['setup-open'])
  })
  it('direct and stateless installs have no administrator warnings', () => {
    expect(ids(probe({ mode: 'direct', mfa: 'none' }))).toEqual([])
    expect(ids(probe({ mode: 'stateless', mfa: 'none' }))).toEqual([])
  })
  it('a degraded external sink, in any mode; a working or absent one raises nothing', () => {
    expect(ids(probe({ mode: 'direct', sink: { sink: 'file', state: 'degraded' } }))).toEqual(['audit-sink-degraded'])
    expect(ids(probe({ mode: 'direct', sink: { sink: 'file', state: 'ok' } }))).toEqual([])
    expect(ids(probe({ mode: 'direct', sink: { sink: 'stdout', state: 'ok' } }))).toEqual([])
  })
})

describe('banner rule', () => {
  const item = (id: string, acknowledged = false) => ({ id, text: id, source: 'runtime' as const, ...(acknowledged ? { acknowledged: { by: 'x', at: 1 } } : {}) })
  it('never on a loopback bind, whatever the warnings', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(bannerOf(host, [item('a')])).toEqual({ raised: false, count: 1 })
  })
  it('off loopback: raised while anything is unacknowledged, counting only those', () => {
    expect(bannerOf('0.0.0.0', [item('a'), item('b', true)])).toEqual({ raised: true, count: 1 })
    expect(bannerOf('0.0.0.0', [item('a', true)])).toEqual({ raised: false, count: 0 })
    expect(bannerOf('0.0.0.0', [])).toEqual({ raised: false, count: 0 })
  })
})

describe('acknowledgement', () => {
  const OFF = { DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com', DBLOOM_TRUST_PROXY: '172.18.0.0/16', DBLOOM_LOGIN_MODE: 'account', DBLOOM_ALLOW_PRIVATE: 'true' }
  const make = (p: RuntimeProbe, write: (e: string, f: Record<string, string | number | boolean | undefined>) => void = () => undefined, clock = { t: 1000 }) => {
    const { config, report } = reportOf(OFF)
    return createExposureState({ report, host: config.host, startedAt: 500, probe: p, now: () => clock.t, auditRequired: write })
  }

  it('the view lists environment and runtime items and raises the banner off loopback', () => {
    const v = make(probe({ mfa: 'none' })).view()
    expect(v.asOf).toBe(500)
    expect(v.items.map((i) => `${i.source}:${i.id}`)).toEqual(['environment:private-targets', 'runtime:no-mfa', 'runtime:admin-any-address'])
    expect(v.banner).toEqual({ raised: true, count: 3 })
  })

  it('acknowledging writes the audit row first, then marks the item and lowers the count; the item stays listed', () => {
    const order: string[] = []
    const state = make(probe({ mfa: 'none' }), (e, f) => void order.push(`audit:${e}:${f.subject}:${f.actor}`))
    state.acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')
    order.push('after')
    expect(order).toEqual(['audit:exposure.ack:no-mfa:u1', 'after'])
    const v = state.view()
    expect(v.items.find((i) => i.id === 'no-mfa')?.acknowledged).toEqual({ by: 'root', at: 1000 })
    expect(v.banner).toEqual({ raised: true, count: 2 })
    state.acknowledge({ id: 'u1', name: 'root' }, 'private-targets')
    state.acknowledge({ id: 'u1', name: 'root' }, 'admin-any-address')
    expect(state.view().banner).toEqual({ raised: false, count: 0 })
    expect(state.view().items).toHaveLength(3)
  })

  it('an unknown or no longer true warning is refused and writes nothing', () => {
    const write = vi.fn()
    const state = make(probe({ mfa: 'all' }), write)
    expect(() => state.acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')).toThrow(UnknownWarning)
    expect(() => state.acknowledge({ id: 'u1', name: 'root' }, 'nonsense')).toThrow(UnknownWarning)
    expect(write).not.toHaveBeenCalled()
  })

  it('a failing audit write refuses the acknowledgement: nothing is recorded, the banner stays', () => {
    const state = make(probe({ mfa: 'none' }), () => {
      throw new AuditUnavailable('locked')
    })
    expect(() => state.acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')).toThrow(AuditUnavailable)
    expect(state.view().items.find((i) => i.id === 'no-mfa')?.acknowledged).toBeUndefined()
    expect(state.view().banner.count).toBe(3)
  })

  it('a warning that stops being true loses its acknowledgement; when it returns it is new', () => {
    let mfa = 'none'
    const p: RuntimeProbe = { mode: () => 'account', mfaScope: () => mfa, sink: () => ({ sink: 'stdout', state: 'ok' }) }
    const state = make(p)
    state.acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')
    mfa = 'all'
    expect(state.view().items.some((i) => i.id === 'no-mfa')).toBe(false)
    mfa = 'none'
    expect(state.view().items.find((i) => i.id === 'no-mfa')?.acknowledged).toBeUndefined()
  })

  it('a restart (a new state object) shows every warning again', () => {
    const first = make(probe({ mfa: 'none' }))
    first.acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')
    expect(first.view().banner.count).toBe(2)
    expect(make(probe({ mfa: 'none' })).view().banner.count).toBe(3)
  })
})

describe('with the real required audit write', () => {
  let dir: string
  let store: SqliteStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbloom-exposure-'))
    store = openSqliteStore(join(dir, 'dbloom.db'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    unregisterAuditStore()
    resetSinks()
    vi.restoreAllMocks()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const build = () => {
    const { config, report } = reportOf({ DBLOOM_HOST: '0.0.0.0', DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com', DBLOOM_TRUST_PROXY: '172.18.0.0/16' })
    return createExposureState({ report, host: config.host, startedAt: 1, probe: probe({ mfa: 'none' }) })
  }

  it('writes the exposure.ack row with actor and warning id', () => {
    registerAuditStore(store.db)
    build().acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')
    expect(store.db.prepare("SELECT actor_id, subject, outcome FROM audit_log WHERE event = 'exposure.ack'").all()).toEqual([{ actor_id: 'u1', subject: 'no-mfa', outcome: 'ok' }])
  })

  it('without a table (stateless) the acknowledgement fails closed', () => {
    const state = build()
    expect(() => state.acknowledge({ id: 'u1', name: 'root' }, 'no-mfa')).toThrow(AuditUnavailable)
    expect(state.view().items.find((i) => i.id === 'no-mfa')?.acknowledged).toBeUndefined()
  })
})
