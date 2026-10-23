import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectAuth, LOGIN_FAILED } from '~/server/auth'
import type { Config } from '~/server/config'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore } from '~/server/store/sqlite-store'
import type { Store } from '~/server/store/store'

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
]

const config: Config = {
  dataDir: '',
  allowedTargets: [],
  freeFormAck: true,
  allowLoopback: true,
  allowPrivate: false,
  tls: 'off',
  trustProxy: false,
  sessionIdleMs: 60_000,
  sessionAbsoluteMs: 600_000,
  connectTimeoutMs: 3000,
}

describe.each(servers)('direct-mode login against $name', ({ port }) => {
  let dir: string
  let store: Store
  let now: number
  let sessions: SessionManager
  let auth: DirectAuth
  const login = (over: Partial<Parameters<DirectAuth['login']>[0]> = {}, ip = '1.2.3.4') =>
    auth.login({ host: '127.0.0.1', port, username: 'root', password: 'root', ...over }, ip)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbloom-'))
    store = openSqliteStore(join(dir, 'store.db'))
    now = 1_000_000
    sessions = new SessionManager(store, config, () => now)
    auth = new DirectAuth(config, sessions)
  })
  afterEach(async () => {
    await sessions.sweep()
    for (const t of tokens) await sessions.destroy(t)
    tokens.length = 0
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const tokens: string[] = []
  const ok = async (over = {}) => {
    const s = await login(over)
    tokens.push(s.token)
    return s
  }

  test('good credentials give a session that can query the target', async () => {
    const { token } = await ok()
    const live = sessions.resolve(token)
    expect(live).toBeDefined()
    const [rows] = await live!.pool.query('SELECT 1 AS one')
    // BIGINT comes back as a string (precision); MySQL types a bare literal as BIGINT, MariaDB as INT
    expect(String((rows as { one: unknown }[])[0]!.one)).toBe('1')
  })

  test('the token is not stored, only its hash', async () => {
    const { token } = await ok()
    const live = sessions.resolve(token)!
    expect(live.idHash).not.toContain(token)
    expect(store.getSession(token)).toBeUndefined()
  })

  test('wrong password, denied host and invalid host give one identical error', async () => {
    const messages = new Set<string>()
    for (const over of [
      { password: 'wrong' },
      { host: '169.254.169.254' },
      { host: '127.1' },
      { port: 1 },
      { username: '' },
    ]) {
      await login(over, `9.9.9.${messages.size}`).catch((e: Error) => messages.add(e.message))
    }
    expect([...messages]).toEqual([LOGIN_FAILED])
  })

  test('five wrong passwords for one target and user block even the right password', async () => {
    for (let i = 0; i < 5; i++)
      await login({ password: 'wrong' }, `8.8.8.${i}`).catch(() => undefined)
    await expect(login({}, '7.7.7.7')).rejects.toThrow(LOGIN_FAILED)
  })

  test('unknown session token is not valid', () => {
    expect(sessions.resolve('forged')).toBeUndefined()
    expect(sessions.resolve(undefined)).toBeUndefined()
  })

  test('logout ends the session and the old token stays dead', async () => {
    const { token } = await ok()
    await sessions.destroy(token)
    expect(sessions.resolve(token)).toBeUndefined()
  })

  test('idle timeout ends the session; activity renews it', async () => {
    const { token } = await ok()
    now += 59_000
    expect(sessions.resolve(token)).toBeDefined()
    now += 59_000
    expect(sessions.resolve(token)).toBeDefined()
    now += 61_000
    expect(sessions.resolve(token)).toBeUndefined()
  })

  test('absolute lifetime cannot be extended by activity', async () => {
    const { token } = await ok()
    for (let i = 0; i < 10; i++) {
      now += 55_000
      sessions.resolve(token)
    }
    now += 55_000
    expect(sessions.resolve(token)).toBeUndefined()
  })

  test('a session record without live credentials (restart) is ended', async () => {
    const { token } = await ok()
    const other = new SessionManager(store, config, () => now)
    expect(other.resolve(token)).toBeUndefined()
    expect(sessions.resolve(token)).toBeUndefined()
  })

  test('csrf token must match', async () => {
    const { token, csrf } = await ok()
    const live = sessions.resolve(token)!
    expect(sessions.verifyCsrf(live, csrf)).toBe(true)
    expect(sessions.verifyCsrf(live, 'x'.repeat(csrf.length))).toBe(false)
    expect(sessions.verifyCsrf(live, undefined)).toBe(false)
  })
})

describe('TLS to the target', () => {
  const run = async (tls: Config['tls']) => {
    const dir = mkdtempSync(join(tmpdir(), 'dbloom-'))
    const store = openSqliteStore(join(dir, 'store.db'))
    const cfg = { ...config, tls }
    const sessions = new SessionManager(store, cfg)
    try {
      const s = await new DirectAuth(cfg, sessions).login(
        { host: '127.0.0.1', port: 33064, username: 'root', password: 'root' },
        '5.5.5.5',
      )
      await sessions.destroy(s.token)
      return 'ok'
    } catch (e) {
      return (e as Error).message
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  test('skip-verify connects over TLS to the self-signed MySQL', async () => {
    expect(await run('skip-verify')).toBe('ok')
  })
  test('verify refuses the self-signed certificate', async () => {
    expect(await run('verify')).toBe(LOGIN_FAILED)
  })
})
