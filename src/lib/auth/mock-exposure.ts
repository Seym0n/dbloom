/**
 * Mock of the exposure functions (SPEC/31). One fixed report as of a start time one hour ago: a non-loopback bind, one
 * environment warning and two runtime warnings. Acknowledgements live in this tab's session storage (the real server keeps
 * them in memory until a restart). Flags (`dbloom.authMock.flags`): `exposure-clean` (no warnings), `exposure-loopback`
 * (banner never raised).
 */
import type { AuthApi } from './api'

const ACK_KEY = 'dbloom.authMock.exposureAck'
const START = Date.now() - 3_600_000
const LINES: [string, string][] = [
  ['bind', '0.0.0.0:3000'],
  ['public origin', 'https://db.example.com'],
  ['scheme', 'https'],
  ['trusted proxies', '172.18.0.0/16'],
  ['hsts', 'on, max-age 31536000'],
  ['login mode', 'account'],
  ['store', 'sqlite in /data'],
  ['target tls', 'verify'],
]
const ITEMS = [
  { id: 'private-targets', text: 'Targets on loopback or private networks are allowed', source: 'environment' as const },
  { id: 'no-mfa', text: 'No second factor is enforced for sign-in', source: 'runtime' as const },
  { id: 'admin-any-address', text: 'Administration pages are reachable from any address', source: 'runtime' as const },
]

type Acks = Record<string, { by: string; at: number }>
const read = (): Acks => {
  try {
    return JSON.parse(window.sessionStorage.getItem(ACK_KEY) ?? '{}') as Acks
  } catch {
    return {}
  }
}
const write = (a: Acks) => {
  try {
    window.sessionStorage.setItem(ACK_KEY, JSON.stringify(a))
  } catch {
    /* in-memory only */
  }
}

type Deps = { flag: (name: string) => boolean; wait: <T>(v: T) => Promise<T>; who: () => string }

export function createMockExposureApi(d: Deps): Pick<AuthApi, 'getExposure' | 'acknowledgeExposure'> {
  const items = () => (d.flag('exposure-clean') ? [] : ITEMS)
  return {
    getExposure: async () => {
      const acks = read()
      const list = items().map((i) => (acks[i.id] ? { ...i, acknowledged: acks[i.id]! } : i))
      const count = list.filter((i) => !('acknowledged' in i)).length
      return d.wait({
        asOf: START,
        lines: LINES,
        items: list,
        banner: { raised: !d.flag('exposure-loopback') && count > 0, count },
        status: {
          ready: true,
          readyState: 'ok',
          loginMode: 'account',
          store: 'ok' as const,
          schemaVersion: 7,
          version: '0.0.0',
          auditSink: d.flag('audit-degraded') ? { sink: 'file', state: 'degraded', buffered: 42, drops: 0 } : { sink: 'stdout', state: 'ok' },
        },
      })
    },
    acknowledgeExposure: async (id) => {
      if (!items().some((i) => i.id === id)) throw new Error(JSON.stringify({ code: 'auth_failed' }))
      const acks = read()
      acks[id] = { by: d.who(), at: Date.now() }
      write(acks)
      return d.wait({ ok: true as const })
    },
  }
}
