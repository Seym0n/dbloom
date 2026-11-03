import { afterEach, describe, expect, it, vi } from 'vitest'
import { audit } from '~/server/audit'
import { addSink, dispatch, listSinks, resetSinks, sinkFailures, type AuditEntry } from '~/server/audit/sink'

afterEach(() => {
  resetSinks()
  vi.restoreAllMocks()
})

describe('audit sinks', () => {
  it('writes the unchanged stdout JSON line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    audit('auth.signin', { actor: 'alice', outcome: 'ok' })
    expect(log).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(log.mock.calls[0]![0]))
    expect(line).toMatchObject({ audit: 'auth.signin', actor: 'alice', outcome: 'ok' })
    expect(Object.keys(line).slice(0, 2)).toEqual(['t', 'audit'])
  })

  it('fans out to every sink, replacing a sink of the same name', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen: AuditEntry[] = []
    addSink({ name: 'x', write: () => void seen.push({ t: '', event: 'old', fields: {} }) })
    addSink({ name: 'x', write: (e) => void seen.push(e) })
    audit('user.create', { subject: 'u1' })
    expect(listSinks().map((s) => s.name)).toEqual(['stdout', 'x'])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ event: 'user.create', fields: { subject: 'u1' } })
  })

  it('a throwing sink never throws into the caller, the other sinks still run, failures are counted', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    addSink({ name: 'bad', write: () => { throw new Error('disk full') } })
    expect(() => audit('user.delete', { subject: 'u1' })).not.toThrow()
    expect(() => audit('user.delete', { subject: 'u2' })).not.toThrow()
    expect(log).toHaveBeenCalledTimes(2)
    expect(sinkFailures()).toEqual({ bad: 2 })
    // logged once per minute, not per event
    expect(err.mock.calls.filter((c) => String(c[0]).includes('audit.sink_failed'))).toHaveLength(1)
    dispatch({ t: '', event: 'user.delete', fields: {} }, Date.now() + 61_000)
    expect(err.mock.calls.filter((c) => String(c[0]).includes('audit.sink_failed'))).toHaveLength(2)
  })

  it('an event that is not in the catalog throws under test', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(() => audit('user.creat')).toThrow('not in the catalog')
  })

  it('outside test the unlisted event is logged as an error and still written', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => audit('user.creat')).not.toThrow()
    vi.unstubAllEnvs()
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0]![0])).toContain('not in the catalog')
  })
})
