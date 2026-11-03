import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection } from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Graceful shutdown and the instance lock against the BUILT server (`npm run build` first; skipped when `.output` is
 * missing; the job test also needs the MySQL 8.4 test container on port 33064).
 *
 * Signals: on POSIX the test sends a real `SIGTERM` to the child. Windows cannot signal a child, so the child runs
 * `tests/fixtures/serve-ipc.mjs`, which turns an IPC message into `process.emit('SIGTERM')`: the same handlers run.
 */
const ENTRY = resolve('.output/server/index.mjs')
const built = existsSync(ENTRY)
const WIN = process.platform === 'win32'
const MYSQL_PORT = 33064

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    r.on('error', fail)
    r.end(body)
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- Server function wire format (seroval JSON; plain strings, numbers, booleans, arrays and objects) ----------------
let nodeId = 0
const enc = (v: unknown): unknown => {
  if (typeof v === 'string') return { t: 1, s: v }
  if (typeof v === 'number') return { t: 0, s: v }
  if (typeof v === 'boolean') return { t: 2, s: v ? 2 : 3 }
  if (Array.isArray(v)) return { t: 9, i: nodeId++, a: v.map(enc), o: 0 }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  return { t: 10, i: nodeId++, p: { k: keys, v: keys.map((k) => enc(o[k])) }, o: 0 }
}
const fnBody = (data: unknown) => {
  nodeId = 0
  return JSON.stringify({ t: enc({ data }), f: 127, m: [] })
}
type Node = { t: number; s?: number; a?: Node[]; p?: { k: string[]; v: Node[] } }
const dec = (n: Node): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (n.t === 1 || n.t === 0) return n.s
  if (n.t === 2) return n.s === 2 ? true : n.s === 3 ? false : n.s === 0 ? null : undefined
  if (n.t === 9) return n.a!.map(dec)
  if (n.t === 10) return Object.fromEntries(n.p!.k.map((k, i) => [k, dec(n.p!.v[i]!)]))
  return undefined
}

type Srv = {
  port: number
  dir: string
  child: ChildProcess
  out: () => string
  exited: Promise<number | null>
  signal: (sig: 'SIGTERM' | 'SIGINT') => void
  kill: () => Promise<void>
}

async function start(env: Record<string, string> = {}, opts: { dir?: string; waitReady?: boolean } = {}): Promise<Srv> {
  const port = await freePort()
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'dbloom-life-'))
  const child = spawn(process.execPath, [WIN ? resolve('tests/fixtures/serve-ipc.mjs') : ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DBLOOM_DATA_DIR: dir,
      DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
      DBLOOM_AUTO_SETUP: 'direct',
      DBLOOM_ALLOW_LOOPBACK: 'true',
      DBLOOM_TARGET_TLS: 'off',
      NODE_ENV: 'production',
      CI: '', // srvx skips its graceful-shutdown handler when CI or TEST is set
      TEST: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let out = ''
  child.stdout?.on('data', (d) => (out += d.toString('utf8')))
  child.stderr?.on('data', (d) => (out += d.toString('utf8')))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  const srv: Srv = {
    port,
    dir,
    child,
    out: () => out,
    exited,
    signal: (sig) => {
      if (WIN) child.send(sig)
      else child.kill(sig)
    },
    kill: async () => {
      child.kill('SIGKILL')
      await exited
    },
  }
  if (opts.waitReady !== false) {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await send(port, 'GET', '/api/ready')).status === 200) return srv
      } catch {
        // not listening yet
      }
      if (child.exitCode !== null) break
      await sleep(200)
    }
  }
  return srv
}

const same = (port: number) => ({ origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' })

async function fn(srv: Srv, name: string, data: unknown, cookie: string, csrf?: string) {
  const r = await send(
    srv.port,
    'POST',
    `/_serverFn/${name}_createServerFn_handler`,
    { ...same(srv.port), 'x-tsr-serverFn': 'true', 'content-type': 'application/json', cookie, ...(csrf ? { 'x-dbloom-csrf': csrf } : {}) },
    fnBody(data),
  )
  const parsed = r.body.startsWith('{') ? dec(JSON.parse(r.body)) : undefined
  return { status: r.status, result: parsed?.result, raw: r }
}

async function login(srv: Srv): Promise<{ cookie: string; csrf: string }> {
  const r = await send(
    srv.port,
    'POST',
    '/_serverFn/session.functions.login_createServerFn_handler',
    { ...same(srv.port), 'x-tsr-serverFn': 'true', 'content-type': 'application/json' },
    fnBody({ host: '127.0.0.1', port: MYSQL_PORT, username: 'root', password: 'root' }),
  )
  expect(r.status, r.body).toBe(200)
  const set = ([] as string[]).concat(r.headers['set-cookie'] ?? [])[0] ?? ''
  return { cookie: set.split(';')[0]!, csrf: dec(JSON.parse(r.body)).result.csrf }
}

const mysqlUp = async (): Promise<boolean> => {
  try {
    const c = await createConnection({ host: '127.0.0.1', port: MYSQL_PORT, user: 'root', password: 'root' })
    await c.end()
    return true
  } catch {
    return false
  }
}
const haveMysql = built && (await mysqlUp())

const leftovers = (dir: string) => readdirSync(dir).filter((f) => /-(wal|shm)$/.test(f))

const servers: Srv[] = []
const track = (s: Srv) => (servers.push(s), s)
afterAll(async () => {
  await Promise.all(servers.map((s) => (s.child.exitCode === null ? s.kill() : undefined)))
  for (const s of servers) rmSync(s.dir, { recursive: true, force: true })
})

describe.skipIf(!built)('graceful shutdown against the built server', () => {
  it('SIGTERM with a request in flight: ready 503, new connections refused, request finishes, exit 0, clean store', async () => {
    const srv = track(await start({ DBLOOM_SHUTDOWN_SECONDS: '10' }))
    expect(srv.child.exitCode).toBeNull()
    const session = await login(srv)

    // in-flight request: headers and part of the body sent, the rest held back
    const first = 'SELECT 1;\n'
    const second = 'SELECT 2;\n'
    const up = request({
      host: '127.0.0.1',
      port: srv.port,
      method: 'PUT',
      path: '/api/io/upload?format=sql&name=slow.sql',
      setHost: false,
      headers: { host: `localhost:${srv.port}`, ...same(srv.port), cookie: session.cookie, 'x-dbloom-csrf': session.csrf, 'content-length': String(first.length + second.length) },
    })
    const reply = new Promise<Reply>((ok, fail) => {
      up.on('response', (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => ok({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      up.on('error', fail)
    })
    await new Promise<void>((r) => up.write(first, () => r()))

    // a probe connection with a half-sent request: not idle, so shutdown leaves it alone and it can ask for readiness
    const probe = connect(srv.port, '127.0.0.1')
    let probeText = ''
    probe.on('data', (d) => (probeText += d.toString('utf8')))
    probe.on('error', () => undefined)
    await new Promise<void>((r) => probe.once('connect', () => r()))
    probe.write(`GET /api/ready HTTP/1.1\r\nHost: localhost:${srv.port}\r\n`)
    await sleep(150)

    srv.signal('SIGTERM')
    await sleep(500)

    // new connections are refused while the request is still in flight
    await expect(send(srv.port, 'GET', '/api/ready')).rejects.toThrow()
    expect(srv.child.exitCode).toBeNull()

    // readiness answers 503 on the held connection
    probe.write('\r\n')
    await sleep(300)
    expect(probeText).toMatch(/^HTTP\/1\.1 503 /)
    expect(probeText).toContain('"ready":false')

    // the in-flight request completes
    up.end(second)
    const r = await reply
    expect(r.status, r.body).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ fileName: 'slow.sql' })

    const t0 = Date.now()
    const code = await srv.exited
    expect(code).toBe(0)
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(leftovers(srv.dir)).toEqual([])
    expect(srv.out()).toContain('"msg":"shutdown.begin"')
    expect(srv.out()).toContain('"msg":"shutdown.done"')

    // the lock was released: the same data directory starts again at once
    const again = track(await start({}, { dir: srv.dir }))
    expect(again.child.exitCode).toBeNull()
    again.signal('SIGTERM')
    expect(await again.exited).toBe(0)
  }, 60_000)

  it('a second signal exits at once with code 1', async () => {
    const srv = track(await start({ DBLOOM_SHUTDOWN_SECONDS: '20' }))
    const session = await login(srv)
    const up = request({
      host: '127.0.0.1',
      port: srv.port,
      method: 'PUT',
      path: '/api/io/upload?format=sql&name=slow.sql',
      setHost: false,
      headers: { host: `localhost:${srv.port}`, ...same(srv.port), cookie: session.cookie, 'x-dbloom-csrf': session.csrf, 'content-length': '100' },
    })
    up.on('error', () => undefined)
    await new Promise<void>((r) => up.write('SELECT 1;\n', () => r()))
    srv.signal('SIGTERM')
    await sleep(500)
    expect(srv.child.exitCode).toBeNull()
    const t0 = Date.now()
    srv.signal('SIGTERM')
    expect(await srv.exited).toBe(1)
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(srv.out()).toContain('second signal')
  }, 60_000)

  it('stateless mode shuts down cleanly without a lock', async () => {
    const srv = track(await start({ DBLOOM_STORE: 'none' }))
    srv.signal('SIGTERM')
    expect(await srv.exited).toBe(0)
    expect(srv.out()).not.toContain('instance lock')
    expect(leftovers(srv.dir)).toEqual([])
  }, 30_000)
})

describe.skipIf(!built)('instance lock against the built server', () => {
  it('a second process on the same data directory refuses to start and names the holder', async () => {
    const a = track(await start())
    expect(a.child.exitCode).toBeNull()
    const b = track(await start({}, { dir: a.dir, waitReady: false }))
    expect(await b.exited).toBe(1)
    expect(b.out()).toMatch(/Another DBLoom instance uses this store: pid \d+ on host \S+/)
    expect(b.out()).toContain(`pid ${a.child.pid}`)
    // the first instance is untouched
    expect((await send(a.port, 'GET', '/api/ready')).status).toBe(200)
    a.signal('SIGTERM')
    expect(await a.exited).toBe(0)
  }, 60_000)

  it('a crashed holder (SIGKILL, row left behind) is taken over by the next start on the same volume', async () => {
    const a = track(await start())
    await a.kill()
    const b = track(await start({}, { dir: a.dir }))
    expect(b.child.exitCode).toBeNull()
    expect(b.out()).toContain('instance lock taken over')
    b.signal('SIGTERM')
    expect(await b.exited).toBe(0)
  }, 60_000)
})

describe.skipIf(!haveMysql)('running import job at SIGTERM (MySQL 8.4 on 33064)', () => {
  it('the job ends as interrupted, temp files are removed, the store is clean, exit 0', async () => {
    const db = `svr_life_${process.pid}`
    const admin = await createConnection({ host: '127.0.0.1', port: MYSQL_PORT, user: 'root', password: 'root' })
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${db}\``)
    try {
      const srv = track(await start({ DBLOOM_SHUTDOWN_SECONDS: '10' }))
      const s = await login(srv)

      const sql = 'CREATE TABLE t (a INT);\nINSERT INTO t VALUES (1);\nDO SLEEP(60);\nINSERT INTO t VALUES (2);\n'
      const up = await send(srv.port, 'PUT', '/api/io/upload?format=sql&name=slow.sql', { ...same(srv.port), cookie: s.cookie, 'x-dbloom-csrf': s.csrf, 'content-length': String(sql.length) }, sql)
      expect(up.status, up.body).toBe(200)
      const uploadId = JSON.parse(up.body).uploadId as string
      const analysis = await fn(srv, 'import.functions.analyseImport', { uploadId, format: 'sql' }, s.cookie, s.csrf)
      expect(analysis.status, analysis.raw.body).toBe(200)
      const started = await fn(
        srv,
        'import.functions.startImport',
        { uploadId, format: 'sql', db, options: {}, ...(analysis.result.confirmToken ? { confirmToken: analysis.result.confirmToken } : {}) },
        s.cookie,
        s.csrf,
      )
      expect(started.status, started.raw.body).toBe(200)
      const jobId = started.result.jobId as string

      let state = ''
      for (let i = 0; i < 50 && state !== 'running'; i++) {
        await sleep(100)
        state = (await fn(srv, 'export.functions.getJob', { jobId }, s.cookie, s.csrf)).result?.state ?? ''
      }
      expect(state).toBe('running')

      srv.signal('SIGTERM')
      const t0 = Date.now()
      expect(await srv.exited).toBe(0)
      expect(Date.now() - t0).toBeLessThan(10_000)
      const out = srv.out()
      expect(out).toMatch(new RegExp(`"msg":"io.job.interrupted"[^\\n]*"jobId":"${jobId}"[^\\n]*"state":"interrupted"`))
      expect(out).toContain('"msg":"io.temp.removed"')
      expect(leftovers(srv.dir)).toEqual([])
      const tmp = join(srv.dir, 'tmp')
      expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([])
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => undefined)
      await admin.end()
    }
  }, 90_000)
})
