import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The gate and the central headers against the BUILT server (`npm run build` first; skipped when `.output` is missing).
 * Server A: loopback defaults (http). Server B: https public origin, loopback peer trusted as proxy.
 */
const ENTRY = resolve('.output/server/index.mjs')
const built = existsSync(ENTRY)

type Reply = { status: number; headers: Record<string, string>; body: string }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        ok({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    r.on('error', fail)
    r.end()
  })
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

type Srv = { port: number; child: ChildProcess; stop: () => Promise<void> }
async function start(env: Record<string, string>): Promise<Srv> {
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), DBLOOM_DATA_DIR: mkdtempSync(join(tmpdir(), 'dbloom-gate-')), DBLOOM_AUTO_SETUP: 'direct', NODE_ENV: 'production', ...env },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await send(port, 'GET', '/api/health', { host: `localhost:${port}` })
      if (r.status === 200) break
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return {
    port,
    child,
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done())
        child.kill()
      }),
  }
}

const VOLATILE = new Set(['date', 'etag', 'last-modified', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'content-type'])
const stable = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a.localeCompare(b)))

const ORIGIN = 'https://db.example.test'
let a: Srv, b: Srv
const assetPath = () => `/assets/${readdirSync('.output/public/assets').find((f) => f.endsWith('.js'))!}`

describe.skipIf(!built)('gate against the built server', () => {
  beforeAll(async () => {
    a = await start({})
    b = await start({ DBLOOM_PUBLIC_ORIGIN: ORIGIN, DBLOOM_TRUST_PROXY: '127.0.0.0/8', DBLOOM_ALLOWED_HOSTS: 'db.example.test' })
  }, 60_000)
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
  })

  const hostA = () => `localhost:${a.port}`
  const proxied = (extra: Record<string, string> = {}) => ({ host: 'db.example.test', 'x-forwarded-proto': 'https', ...extra })

  describe('forged Host is 421 with an empty body on every route class', () => {
    const targets = ['/', '/setup', '/assets/none.js', '/_serverFn/auth.functions.getBootState', '/api/startup', '/api/rows/upload', '/api/io/upload', '/api/health', '/nope']
    for (const path of targets) {
      it(path, async () => {
        for (const srv of [() => a, () => b]) {
          for (const method of ['GET', 'POST']) {
            const r = await send(srv().port, method, path, { host: 'forged.invalid', 'x-forwarded-host': 'db.example.test' })
            expect(r.status, `${method} ${path}`).toBe(421)
            expect(r.body).toBe('')
            expect(r.headers['x-content-type-options']).toBe('nosniff')
          }
        }
      })
    }
  })

  it('probe host reaches /api/health but nothing else (server B)', async () => {
    expect((await send(b.port, 'GET', '/api/health', { host: `localhost:${b.port}` })).status).toBe(200)
    expect((await send(b.port, 'GET', '/', { host: `localhost:${b.port}` })).status).toBe(421)
  })

  it('origin: cross-site, null and missing Origin are refused on functions and routes; same-origin passes the gate', async () => {
    for (const path of ['/_serverFn/auth.functions.signOut', '/api/rows/upload', '/api/io/upload']) {
      for (const origin of ['http://evil.example', 'null', undefined]) {
        const r = await send(a.port, 'POST', path, { host: hostA(), ...(origin ? { origin } : {}) })
        expect(r.status, `${path} ${origin}`).toBe(403)
        expect(r.body).toBe('forbidden_origin')
      }
      const ok = await send(a.port, 'POST', path, { host: hostA(), origin: `http://${hostA()}`, 'sec-fetch-site': 'same-origin' })
      expect(ok.body).not.toBe('forbidden_origin')
    }
  })

  it('OPTIONS is 405 without CORS headers', async () => {
    const r = await send(a.port, 'OPTIONS', '/api/health', { host: hostA(), origin: 'http://evil.example', 'access-control-request-method': 'POST' })
    expect(r.status).toBe(405)
    expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([])
  })

  it('scheme mismatch: proxy says http for an https origin -> credential function and setup page refused', async () => {
    const headers = proxied({ 'x-forwarded-proto': 'http', origin: ORIGIN, 'sec-fetch-site': 'same-origin' })
    const fn = await send(b.port, 'POST', '/_serverFn/auth.functions.passwordSignIn', headers)
    expect(fn).toMatchObject({ status: 403, body: 'insecure_scheme' })
    expect((await send(b.port, 'GET', '/setup', { host: 'db.example.test', 'x-forwarded-proto': 'http' })).body).toBe('insecure_scheme')
    const fine = await send(b.port, 'GET', '/', { host: 'db.example.test', 'x-forwarded-proto': 'http' })
    expect(fine.status).toBe(200)
  })

  it('HSTS only on the https origin', async () => {
    const https = await send(b.port, 'GET', '/', proxied())
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000')
    const http = await send(a.port, 'GET', '/', { host: hostA() })
    expect(http.headers['strict-transport-security']).toBeUndefined()
  })

  it('header diff: page, asset, function, route, error, refusal (snapshot)', async () => {
    const out: Record<string, unknown> = {}
    const classes: [string, string, string, Record<string, string>][] = [
      ['page', 'GET', '/', {}],
      ['asset', 'GET', assetPath(), {}],
      ['function', 'GET', '/_serverFn/auth.functions.getBootState', { 'sec-fetch-site': 'same-origin', 'x-tsr-serverFn': 'true' }],
      ['route', 'GET', '/api/health', {}],
      ['error-404', 'GET', '/no-such-page', {}],
      ['refusal-421', 'GET', '/', { host: 'forged.invalid' }],
      ['refusal-405', 'OPTIONS', '/', {}],
    ]
    for (const [name, method, path, extra] of classes) {
      const ra = await send(a.port, method, path, { host: hostA(), ...extra })
      const rb = await send(b.port, method, path, { ...proxied(), ...extra })
      out[name] = { http: { status: ra.status, headers: stable(ra.headers) }, https: { status: rb.status, headers: stable(rb.headers) } }
      // every class carries the fixed headers, none carries CORS
      for (const r of [ra, rb]) {
        expect(r.headers['x-content-type-options'], name).toBe('nosniff')
        expect(r.headers['referrer-policy'], name).toBe('no-referrer')
        expect(r.headers['x-robots-tag'], name).toBe('noindex, nofollow')
        expect(r.headers['cross-origin-opener-policy'], name).toBe('same-origin')
        expect(r.headers['permissions-policy'], name).toContain('camera=()')
        expect(r.headers['cache-control'], name).toBeTruthy()
        expect(Object.keys(r.headers).some((k) => k.startsWith('access-control-')), name).toBe(false)
      }
    }
    expect(out).toMatchSnapshot()
  })
})
