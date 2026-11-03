import { afterEach, describe, expect, it } from 'vitest'
import { checkReady, isShuttingDown, resetReadiness, setShuttingDown } from '~/server/lifecycle/readiness'
import { readyDetail } from '~/server/lifecycle/ready-response'
import { evaluateGate, PROBE_PATHS } from '~/server/net/gate'
import { cfg, req } from './gate-fixtures'

const ok = { stateless: false, mode: 'account', ping: () => undefined }

describe('readiness decision', () => {
  afterEach(resetReadiness)
  it('ready when config and store are fine', () => expect(checkReady({ runtime: () => ok })).toMatchObject({ ready: true, state: 'ok', mode: 'account' }))
  it('not ready when the runtime cannot be built (bad config or store)', () =>
    expect(checkReady({ runtime: () => { throw new Error('x') } })).toEqual({ ready: false, state: 'config' }))
  it('not ready when SELECT 1 fails (locked store)', () =>
    expect(checkReady({ runtime: () => ({ ...ok, ping: () => { throw new Error('locked') } }) })).toMatchObject({ ready: false, state: 'store' }))
  it('stateless skips the store ping', () => {
    let pinged = false
    const r = checkReady({ runtime: () => ({ stateless: true, ping: () => void (pinged = true) }) })
    expect(r.ready).toBe(true)
    expect(pinged).toBe(false)
  })
  it('flips to 503 once shutdown began, without touching the runtime', () => {
    let touched = false
    setShuttingDown()
    expect(isShuttingDown()).toBe(true)
    expect(checkReady({ runtime: () => ((touched = true), ok) })).toEqual({ ready: false, state: 'shutting-down' })
    expect(touched).toBe(false)
  })
  it('detail carries mode, store and version', () =>
    expect(readyDetail({ ready: true, state: 'ok', stateless: false, mode: 'direct' }, '1.2.3')).toEqual({ ready: true, state: 'ok', mode: 'direct', store: 'ok', version: '1.2.3' }))
})

describe('probe routes in the gate', () => {
  const probe = (pathname: string, over: Parameters<typeof req>[0] = {}) =>
    evaluateGate(req({ pathname, peer: '127.0.0.1', ...over, headers: { host: 'localhost:3000', ...over.headers } }), cfg())
  it('both probe paths are registered', () => expect(PROBE_PATHS).toEqual(['/api/health', '/api/ready']))
  for (const path of ['/api/health', '/api/ready']) {
    it(`${path}: loopback peer + probe host passes`, () => expect(probe(path).ok).toBe(true))
    it(`${path}: non-probe peer on an allowed host gets 404`, () =>
      expect(evaluateGate(req({ pathname: path, peer: '203.0.113.9' }), cfg())).toMatchObject({ ok: false, status: 404, reason: 'probe', body: '' }))
    it(`${path}: non-probe peer on a probe host gets 421 (host check first)`, () =>
      expect(probe(path, { peer: '203.0.113.9' })).toMatchObject({ ok: false, status: 421 }))
    it(`${path}: forged Host from loopback is 421`, () =>
      expect(probe(path, { headers: { host: 'forged.invalid' } })).toMatchObject({ ok: false, status: 421 }))
  }
  it('probe peers can be widened (Coolify network)', () =>
    expect(evaluateGate(req({ pathname: '/api/health', peer: '10.0.1.7', headers: { host: '10.0.1.9:3000' } }), cfg({ probeAllow: ['10.0.0.0/8'], probeHosts: ['10.0.1.9'] })).ok).toBe(true))
})
