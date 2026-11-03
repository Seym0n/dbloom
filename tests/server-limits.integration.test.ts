import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Limits, health, readiness and the logger against the BUILT server (`npm run build` first; skipped when `.output` is
 * missing). Server A: defaults plus short timeouts and small caps. Server B: stateless, debug logging off.
 */
const ENTRY = resolve('.output/server/index.mjs')
const built = existsSync(ENTRY)

type Reply = { status: number; headers: Record<string, string>; body: string }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers }, setHost: false }, (res) => {
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
    r.end(body)
  })
}

/** Raw TCP exchange: write `parts` with `gapMs` between them, collect the reply until the server closes or `waitMs`. */
function raw(port: number, parts: string[], gapMs = 0, waitMs = 8000): Promise<{ text: string; closedBy: 'server' | 'wait' }> {
  return new Promise((done) => {
    const s = connect(port, '127.0.0.1')
    let text = ''
    const stop = setTimeout(() => {
      s.destroy()
      done({ text, closedBy: 'wait' })
    }, waitMs)
    s.on('data', (d) => (text += d.toString('utf8')))
    s.on('close', () => {
      clearTimeout(stop)
      done({ text, closedBy: 'server' })
    })
    s.on('error', () => undefined)
    void (async () => {
      for (const p of parts) {
        s.write(p)
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs))
      }
    })()
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

type Srv = { port: number; child: ChildProcess; out: () => string; stop: () => Promise<void> }
async function start(env: Record<string, string>, probe = '/api/health'): Promise<Srv> {
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), DBLOOM_DATA_DIR: mkdtempSync(join(tmpdir(), 'dbloom-lim-')), DBLOOM_AUTO_SETUP: 'direct', NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d) => (out += d.toString('utf8')))
  child.stderr?.on('data', (d) => (out += d.toString('utf8')))
  for (let i = 0; i < 100; i++) {
    try {
      if ((await send(port, 'GET', probe)).status === 200) break
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { port, child, out: () => out, stop: () => new Promise((done) => { child.once('exit', () => done()); child.kill() }) }
}

let a: Srv, b: Srv
describe.skipIf(!built)('limits, health, readiness, logger against the built server', () => {
  beforeAll(async () => {
    a = await start({ DBLOOM_BODY_LIMIT_OTHER_KIB: '1', DBLOOM_BODY_LIMIT_FUNCTIONS_KIB: '16', DBLOOM_LOG_LEVEL: 'info' })
    b = await start({ DBLOOM_STORE: 'none' })
  }, 60_000)
  afterAll(async () => {
    await Promise.all([a?.stop(), b?.stop()])
  })

  const same = (port: number) => ({ origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' })

  describe('body caps', () => {
    it('other routes: 413 with the fixed body over the cap, passes under it', async () => {
      const big = await send(a.port, 'POST', '/api/startup', same(a.port), 'x'.repeat(2048))
      expect(big.status).toBe(413)
      expect(big.body).toBe('payload_too_large')
      expect(big.headers['x-content-type-options']).toBe('nosniff')
      const small = await send(a.port, 'POST', '/api/startup', same(a.port), 'x'.repeat(100))
      expect(small.status).not.toBe(413)
    })
    it('server functions: own, larger cap', async () => {
      const mid = await send(a.port, 'POST', '/_serverFn/auth.functions.signOut', same(a.port), 'x'.repeat(8 * 1024))
      expect(mid.status).not.toBe(413)
      const big = await send(a.port, 'POST', '/_serverFn/auth.functions.signOut', same(a.port), 'x'.repeat(17 * 1024))
      expect(big).toMatchObject({ status: 413, body: 'payload_too_large' })
    })
    it('chunked body on a capped route is 413', async () => {
      const r = await raw(a.port, [
        `POST /api/startup HTTP/1.1\r\nHost: localhost:${a.port}\r\nOrigin: http://localhost:${a.port}\r\nSec-Fetch-Site: same-origin\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
        '3\r\nabc\r\n0\r\n\r\n',
      ])
      expect(r.text).toContain('413')
    })
    it('upload routes are not capped by the gate (their own limit answers)', async () => {
      const r = await send(a.port, 'PUT', '/api/io/upload', { ...same(a.port), 'x-file-name': 'a.csv' }, 'x'.repeat(4096))
      expect(r.status).not.toBe(413)
      expect(r.body).not.toBe('payload_too_large')
    })
  })

  describe('health', () => {
    it('loopback + probe host: fixed body, 200, no-store', async () => {
      const r = await send(a.port, 'GET', '/api/health')
      expect(r.status).toBe(200)
      expect(r.body).toBe('{"ok":true}')
      expect(r.headers['cache-control']).toBe('no-store')
    })
    it('the Docker HEALTHCHECK shape (Host 127.0.0.1:PORT from loopback) works', async () => {
      expect((await send(a.port, 'GET', '/api/health', { host: `127.0.0.1:${a.port}` })).status).toBe(200)
    })
    it('forged Host is 421', async () => {
      const r = await send(a.port, 'GET', '/api/health', { host: 'forged.invalid' })
      expect(r.status).toBe(421)
      expect(r.body).toBe('')
    })
    it('a non-probe peer is 404 (needs a second address: probe peers narrowed to a foreign range)', async () => {
      const c = await start({ DBLOOM_PROBE_ALLOW: '203.0.113.0/24' }, '/')
      try {
        for (const path of ['/api/health', '/api/ready']) {
          const r = await send(c.port, 'GET', path)
          expect(r.status, path).toBe(404)
          expect(r.body).toBe('')
        }
      } finally {
        await c.stop()
      }
    })
  })

  describe('readiness', () => {
    it('stateful: 200; loopback gets detail', async () => {
      const r = await send(a.port, 'GET', '/api/ready')
      expect(r.status).toBe(200)
      expect(r.headers['cache-control']).toBe('no-store')
      expect(JSON.parse(r.body)).toMatchObject({ ready: true, state: 'ok', store: 'ok' })
    })
    it('stateless: 200 and says no store', async () => {
      const r = await send(b.port, 'GET', '/api/ready')
      expect(r.status).toBe(200)
      expect(JSON.parse(r.body)).toMatchObject({ ready: true, store: 'none' })
    })
    // The shutdown flip (503 after setShuttingDown) is covered at unit level (tests/server-health.test.ts); a
    // test hook on the built server would be an endpoint an outsider could reach, so none exists. Task 5 tests it
    // with a real SIGTERM.
  })

  describe('logger', () => {
    it('writes JSON lines with a request id, and no secret from URL or headers', async () => {
      const secret = 'Zx9-secret-token-value-123456789'
      const r = await send(a.port, 'GET', `/no-such-page?token=${secret}&page=2`, { authorization: `Bearer ${secret}`, cookie: `__Host-dbloom_session=${secret}` })
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
      await new Promise((res) => setTimeout(res, 300))
      const out = a.out()
      expect(out).not.toContain(secret)
      const lines = out.split('\n').filter((l) => l.startsWith('{'))
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
      const mine = parsed.find((l) => l.requestId === r.headers['x-request-id'])
      expect(mine).toMatchObject({ level: 'info', msg: 'request', method: 'GET', status: 404, path: '/no-such-page?token=[redacted]&page=2' })
    })
    it('refused requests are logged with reason, without the Host value', async () => {
      await send(a.port, 'GET', '/', { host: 'forged-host-marker.invalid' })
      await new Promise((res) => setTimeout(res, 300))
      expect(a.out()).toContain('"msg":"gate.refused"')
      expect(a.out()).not.toContain('forged-host-marker')
    })
  })
})
