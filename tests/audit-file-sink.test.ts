import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anonymise, configureAnonymiser, truncateAddress } from '../src/server/audit/anonymise'
import { createFileSink, fileLine, type FileSinkStatus } from '../src/server/audit/file-sink'
import type { AuditEntry } from '../src/server/audit/sink'
import { loadConfig } from '../src/server/config'

let dir: string
const entry = (n: number, fields: AuditEntry['fields'] = {}, ctx?: AuditEntry['ctx']): AuditEntry => ({ t: '2026-11-03T10:00:00.000Z', event: 'sql.run', fields: { n, ...fields }, ...(ctx ? { ctx } : {}) })
const lines = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-audit-file-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  configureAnonymiser('off')
  rmSync(dir, { recursive: true, force: true })
})

describe('file sink', () => {
  it('appends one JSON line per event after the flush interval, with mode 0600', () => {
    const path = join(dir, 'audit.log')
    const sink = createFileSink({ path })
    sink.write(entry(1))
    sink.write(entry(2))
    expect(existsSync(path)).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(lines(path).map((l) => l.n)).toEqual([1, 2])
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    sink.write(entry(3))
    vi.advanceTimersByTime(1000)
    expect(lines(path).map((l) => l.n)).toEqual([1, 2, 3])
    sink.close()
  })

  it('unwritable path: buffers, degraded, recovers without double writes', () => {
    const states: FileSinkStatus[] = []
    const path = join(dir, 'missing', 'audit.log')
    const sink = createFileSink({ path, onState: (s) => states.push(s) })
    sink.write(entry(1))
    sink.write(entry(2))
    vi.advanceTimersByTime(1000)
    expect(sink.status()).toMatchObject({ state: 'degraded', buffered: 2, drops: 0, lastError: 'ENOENT' })
    expect(JSON.stringify(sink.status())).not.toContain('missing')
    vi.advanceTimersByTime(5000)
    expect(sink.status().state).toBe('degraded')
    mkdirSync(join(dir, 'missing'))
    sink.write(entry(3))
    vi.advanceTimersByTime(5000)
    expect(sink.status()).toMatchObject({ state: 'ok', buffered: 0 })
    expect(lines(path).map((l) => l.n)).toEqual([1, 2, 3])
    expect(states.map((s) => s.state)).toEqual(['degraded', 'ok'])
    sink.close()
  })

  it('drops the oldest beyond the cap and counts them', () => {
    const sink = createFileSink({ path: join(dir, 'missing', 'a.log'), cap: 3 })
    for (let i = 1; i <= 5; i++) sink.write(entry(i))
    expect(sink.status()).toMatchObject({ buffered: 3, drops: 2 })
    mkdirSync(join(dir, 'missing'))
    vi.advanceTimersByTime(1000)
    expect(lines(join(dir, 'missing', 'a.log')).map((l) => l.n)).toEqual([3, 4, 5])
    expect(sink.status().drops).toBe(2)
    sink.close()
  })

  it('redacts secrets in the line', () => {
    const line = fileLine(entry(1, { password: 'hunter2', note: 'Bearer abcdefghijklmnop' }))
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('abcdefghijklmnop')
  })
})

describe('anonymisation', () => {
  it('truncates IPv4 to /24 and IPv6 to /48', () => {
    expect(truncateAddress('203.0.113.77')).toBe('203.0.113.0')
    expect(truncateAddress('2001:db8:abcd:12:34::1')).toBe('2001:db8:abcd::')
    expect(truncateAddress('::ffff:198.51.100.9')).toBe('198.51.100.0')
    expect(truncateAddress('::1')).toBe('0:0:0::')
    expect(truncateAddress('nonsense')).toBe('unknown')
  })
  it('modes: off keeps, truncate truncates, hash is stable per key and differs per address', () => {
    expect(anonymise('203.0.113.77')).toBe('203.0.113.77')
    configureAnonymiser('truncate')
    expect(anonymise('203.0.113.77')).toBe('203.0.113.0')
    configureAnonymiser('hash', Buffer.alloc(32, 1))
    const a = anonymise('203.0.113.77')
    expect(a).toMatch(/^h:[0-9a-f]{16}$/)
    expect(anonymise('203.0.113.77')).toBe(a)
    expect(anonymise('203.0.113.78')).not.toBe(a)
    configureAnonymiser('hash', Buffer.alloc(32, 2))
    expect(anonymise('203.0.113.77')).not.toBe(a)
    expect(anonymise(undefined)).toBeNull()
  })
  it('file line uses the context address, anonymised', () => {
    configureAnonymiser('truncate')
    expect(JSON.parse(fileLine(entry(1, {}, { address: '203.0.113.77' }))).address).toBe('203.0.113.0')
  })
})

describe('config', () => {
  it('default is stdout; file needs an absolute path; anonymise values are validated', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv)).toMatchObject({ auditFile: undefined, auditAnonymiseIp: 'off' })
    expect(loadConfig({ DBLOOM_AUDIT_SINK: 'stdout' } as NodeJS.ProcessEnv).auditFile).toBeUndefined()
    expect(loadConfig({ DBLOOM_AUDIT_SINK: 'file:/var/log/dbloom/audit.log' } as NodeJS.ProcessEnv).auditFile).toBe('/var/log/dbloom/audit.log')
    expect(() => loadConfig({ DBLOOM_AUDIT_SINK: 'file:relative.log' } as NodeJS.ProcessEnv)).toThrow(/DBLOOM_AUDIT_SINK/)
    expect(() => loadConfig({ DBLOOM_AUDIT_SINK: 'syslog' } as NodeJS.ProcessEnv)).toThrow(/DBLOOM_AUDIT_SINK/)
    expect(loadConfig({ DBLOOM_AUDIT_ANONYMISE_IP: 'HASH' } as NodeJS.ProcessEnv).auditAnonymiseIp).toBe('hash')
    expect(() => loadConfig({ DBLOOM_AUDIT_ANONYMISE_IP: 'mask' } as NodeJS.ProcessEnv)).toThrow(/DBLOOM_AUDIT_ANONYMISE_IP/)
  })
})
