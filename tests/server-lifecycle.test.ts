import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstanceLock, InstanceLockError } from '~/server/lifecycle/instance-lock'
import { isShuttingDown, resetReadiness } from '~/server/lifecycle/readiness'
import {
  clearShutdownSteps,
  createShutdownController,
  registerShutdownStep,
  registeredShutdownSteps,
  runShutdownSteps,
  type ShutdownStep,
} from '~/server/lifecycle/shutdown'
import { createLogger } from '~/server/log'
import { JobRegistry } from '~/server/io/jobs'
import { TempStore } from '~/server/io/temp'

const quiet = createLogger({ level: () => 'error', write: () => undefined })
const owner = { sessionId: 's1', user: 'alice' }

afterEach(() => {
  resetReadiness()
  clearShutdownSteps()
})

describe('shutdown sequencing', () => {
  const mk = (over: Partial<Parameters<typeof createShutdownController>[0]> = {}) => {
    const calls: string[] = []
    const step = (name: string, order: number, fail = false): ShutdownStep => ({
      name,
      order,
      run: () => {
        calls.push(name)
        if (fail) throw new Error('boom')
      },
    })
    const exit = vi.fn((code: number) => void calls.push(`exit ${code}`))
    return { calls, step, exit, over }
  }

  it('steps run in order of `order`, whatever the registration order', () => {
    const { step } = mk()
    registerShutdownStep(step('store', 40))
    registerShutdownStep(step('jobs', 10))
    registerShutdownStep(step('pools', 20))
    expect(registeredShutdownSteps().map((s) => s.name)).toEqual(['jobs', 'pools', 'store'])
  })

  it('first signal flips readiness and waits for the server to close; then steps, then exit 0', async () => {
    const { calls, step, exit } = mk()
    const c = createShutdownController({ graceMs: 1000, drains: true, exit, log: quiet, steps: () => [step('jobs', 10), step('store', 40)] })
    c.onSignal('SIGTERM')
    expect(isShuttingDown()).toBe(true)
    await Promise.resolve()
    expect(calls).toEqual([]) // nothing runs before the in-flight requests are done
    c.onServerClosed()
    await vi.waitFor(() => expect(calls).toEqual(['jobs', 'store', 'exit 0']))
  })

  it('a close without a signal (dev reload) does nothing', async () => {
    const { calls, step, exit } = mk()
    const c = createShutdownController({ graceMs: 1000, drains: true, exit, log: quiet, steps: () => [step('jobs', 10)] })
    c.onServerClosed()
    await Promise.resolve()
    expect(calls).toEqual([])
    expect(isShuttingDown()).toBe(false)
  })

  it('a failing step is logged, the rest still run, exit code is 1', async () => {
    const { calls, step, exit } = mk()
    const c = createShutdownController({ graceMs: 1000, drains: true, exit, log: quiet, steps: () => [step('a', 1, true), step('b', 2)] })
    c.onSignal('SIGINT')
    c.onServerClosed()
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'exit 1']))
  })

  it('second signal exits at once with 1 and runs no steps', () => {
    const { calls, step, exit } = mk()
    const c = createShutdownController({ graceMs: 1000, drains: true, exit, log: quiet, steps: () => [step('jobs', 10)] })
    c.onSignal('SIGTERM')
    c.onSignal('SIGTERM')
    expect(calls).toEqual(['exit 1'])
  })

  it('steps run once even if close fires twice', async () => {
    const { calls, step, exit } = mk()
    const c = createShutdownController({ graceMs: 1000, drains: true, exit, log: quiet, steps: () => [step('jobs', 10)] })
    c.onSignal('SIGTERM')
    c.onServerClosed()
    c.onServerClosed()
    await vi.waitFor(() => expect(calls).toEqual(['jobs', 'exit 0']))
  })

  it('without srvx draining (CI/TEST set) the steps run at once', async () => {
    const { calls, step, exit } = mk()
    const c = createShutdownController({ graceMs: 1000, drains: false, exit, log: quiet, steps: () => [step('jobs', 10)] })
    c.onSignal('SIGTERM')
    await vi.waitFor(() => expect(calls).toEqual(['jobs', 'exit 0']))
  })

  it('safety timer forces the sequence when close never fires', async () => {
    vi.useFakeTimers()
    try {
      const { calls, step, exit } = mk()
      const c = createShutdownController({ graceMs: 1000, slackMs: 500, drains: true, exit, log: quiet, steps: () => [step('jobs', 10)] })
      c.onSignal('SIGTERM')
      await vi.advanceTimersByTimeAsync(1499)
      expect(calls).toEqual([])
      await vi.advanceTimersByTimeAsync(2)
      expect(calls).toEqual(['jobs', 'exit 1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('runShutdownSteps reports the failed names', async () => {
    const { step } = mk()
    expect(await runShutdownSteps([step('a', 1), step('b', 2, true)], quiet)).toEqual(['b'])
  })
})

describe('job registry at shutdown', () => {
  it('queued, running and paused jobs end as interrupted, hooks run, ended jobs stay', async () => {
    const r = new JobRegistry()
    const hook = vi.fn()
    const a = r.create(owner, 'import')
    r.start(a.id)
    r.setCancelHook(a.id, hook)
    const b = r.create({ ...owner, user: 'bob' }, 'export')
    const c = r.create({ ...owner, user: 'carol' }, 'import')
    r.start(c.id)
    r.pause(c.id, { skipped: [], rejected: [], rejectedCount: 0, notes: [], durationMs: 1 })
    const d = r.create({ ...owner, user: 'dave' }, 'import')
    r.start(d.id)
    r.fail(d.id, { code: 'statement_failed', message: 'x' })

    const out = await r.interruptAll()
    expect(out.map((o) => [o.id, o.from]).sort()).toEqual([[a.id, 'running'], [b.id, 'queued'], [c.id, 'paused']].sort())
    expect(hook).toHaveBeenCalledOnce()
    expect(r.signal(a.id).aborted).toBe(true)
    expect(r.get(a.id, owner)).toMatchObject({ state: 'interrupted', result: { error: { code: 'interrupted' } } })
    expect(r.get(b.id, { ...owner, user: 'bob' })?.state).toBe('interrupted')
    expect(r.get(d.id, { ...owner, user: 'dave' })?.state).toBe('failed')
  })

  it('a runner that finishes after the interrupt is ignored (state stays interrupted)', async () => {
    const r = new JobRegistry()
    const j = r.create(owner, 'import')
    r.start(j.id)
    await r.interruptAll()
    expect(() => r.finish(j.id, 'done', { skipped: [], rejected: [], rejectedCount: 0, notes: [], durationMs: 1 })).toThrow()
    expect(r.stateOf(j.id)).toBe('interrupted')
  })
})

describe('temp store at shutdown', () => {
  it('removeAll deletes registered files and unregistered 32-hex leftovers, nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbloom-tmp-'))
    try {
      const t = new TempStore({ dir: join(dir, 't'), quotaBytes: 1 << 20 })
      const w = await t.begin(owner, 'upload', { name: 'a.sql', maxBytes: 1000 })
      await w.write(Buffer.from('x'))
      await w.commit()
      writeFileSync(join(dir, 't', 'a'.repeat(32)), 'left over')
      writeFileSync(join(dir, 't', 'keep.txt'), 'not ours')
      expect(await t.removeAll()).toBe(2)
      expect(readdirSync(join(dir, 't'))).toEqual(['keep.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('instance lock', () => {
  const newDb = () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE site (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    return db
  }
  let t = 1_000_000
  const lock = (db: DatabaseSync, o: ConstructorParameters<typeof InstanceLock>[1] = {}) =>
    new InstanceLock(db, { now: () => t, heartbeatMs: 10_000, log: quiet, pid: 100, host: 'h1', isPidAlive: () => true, ...o })
  const rows = (db: DatabaseSync) => db.prepare('SELECT value FROM site').all() as { value: string }[]

  afterEach(() => {
    t = 1_000_000
  })

  it('acquire writes pid, host, start time and heartbeat; release removes the row', () => {
    const db = newDb()
    const l = lock(db)
    l.acquire()
    expect(JSON.parse(rows(db)[0]!.value)).toMatchObject({ pid: 100, host: 'h1', startedAt: t, heartbeatAt: t })
    l.release()
    expect(rows(db)).toEqual([])
    l.release() // twice is fine
  })

  it('a live holder refuses a second process and the message names pid and host', () => {
    const db = newDb()
    lock(db, { pid: 100 }).acquire()
    t += 5_000
    const second = lock(db, { pid: 200 })
    expect(() => second.acquire()).toThrow(InstanceLockError)
    expect(() => second.acquire()).toThrow(/pid 100 on host h1/)
    expect(second.isHeld).toBe(false)
  })

  it('a refusal leaves the holder row untouched and no open transaction', () => {
    const db = newDb()
    lock(db, { pid: 100 }).acquire()
    const before = rows(db)
    expect(() => lock(db, { pid: 200 }).acquire()).toThrow(InstanceLockError)
    expect(rows(db)).toEqual(before)
    expect(() => db.exec('BEGIN IMMEDIATE; ROLLBACK')).not.toThrow()
  })

  it('heartbeat keeps the lock fresh; the refreshed time is visible', () => {
    const db = newDb()
    const l = lock(db, { pid: 100 })
    l.acquire()
    t += 8_000
    l.beat()
    expect(JSON.parse(rows(db)[0]!.value).heartbeatAt).toBe(t)
    t += 25_000 // 25 s after the beat: still fresh (stale after 30 s)
    expect(() => lock(db, { pid: 200, host: 'other' }).acquire()).toThrow(InstanceLockError)
  })

  it('stale: heartbeat older than three intervals is taken over, also from another host', () => {
    const db = newDb()
    lock(db, { pid: 100, host: 'old-container' }).acquire()
    t += 30_001
    const l = lock(db, { pid: 200, host: 'new-container' })
    l.acquire()
    expect(JSON.parse(rows(db)[0]!.value)).toMatchObject({ pid: 200, host: 'new-container' })
  })

  it('stale: same host and the pid is gone', () => {
    const db = newDb()
    lock(db, { pid: 100 }).acquire()
    t += 1_000
    lock(db, { pid: 200, isPidAlive: (p) => p !== 100 }).acquire()
    expect(JSON.parse(rows(db)[0]!.value).pid).toBe(200)
  })

  it('stale: same host and same pid (restarted container, pid 1 again)', () => {
    const db = newDb()
    lock(db, { pid: 1 }).acquire()
    t += 1_000
    lock(db, { pid: 1 }).acquire()
    expect(rows(db)).toHaveLength(1)
  })

  it('not stale: another host with a fresh heartbeat, even if its pid number is dead here', () => {
    const db = newDb()
    lock(db, { pid: 100, host: 'other' }).acquire()
    t += 1_000
    expect(() => lock(db, { pid: 200, isPidAlive: () => false }).acquire()).toThrow(/host other/)
  })

  it('a heartbeat that finds another owner reports it and stops', () => {
    const db = newDb()
    const lost = vi.fn()
    const a = lock(db, { pid: 100, onLost: lost })
    a.acquire()
    t += 40_000
    lock(db, { pid: 200, host: 'h2' }).acquire()
    a.beat()
    expect(lost).toHaveBeenCalledWith(expect.stringContaining('pid 200'))
    expect(a.isHeld).toBe(false)
    a.release() // never deletes the new owner's row
    expect(rows(db)).toHaveLength(1)
  })

  it('release does not delete a row that now belongs to someone else', () => {
    const db = newDb()
    const a = lock(db, { pid: 100 })
    a.acquire()
    t += 40_000
    lock(db, { pid: 200, host: 'h2' }).acquire()
    a.release()
    expect(JSON.parse(rows(db)[0]!.value).pid).toBe(200)
  })

  it('works through two real connections to one file (second sees the first)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbloom-lock-'))
    const path = join(dir, 's.db')
    const a = new DatabaseSync(path)
    const b = new DatabaseSync(path)
    try {
      a.exec('PRAGMA journal_mode = WAL; CREATE TABLE site (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
      b.exec('PRAGMA busy_timeout = 2000')
      lock(a, { pid: 100 }).acquire()
      expect(() => lock(b, { pid: 200 }).acquire()).toThrow(InstanceLockError)
    } finally {
      a.close()
      b.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
