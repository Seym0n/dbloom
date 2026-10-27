import { describe, expect, test, vi } from 'vitest'
import { JobError, JobRegistry, TRANSITIONS, boundRecord, type JobOwner } from '~/server/io/jobs'
import {
  JOB_RECORD_MAX_BYTES,
  JOB_RETENTION_MS,
  type IoJob,
  type JobResult,
  type JobState,
} from '~/server/io/types'

const alice: JobOwner = { sessionId: 's1', user: 'alice' }
const bob: JobOwner = { sessionId: 's2', user: 'bob' }
const empty: JobResult = { skipped: [], rejected: [], rejectedCount: 0, notes: [], durationMs: 5 }

function registry(opts: ConstructorParameters<typeof JobRegistry>[0] = {}) {
  let t = 1000
  let n = 0
  const clock = { advance: (ms: number) => (t += ms) }
  const r = new JobRegistry({
    now: () => t,
    newId: () => `job-${String(++n).padStart(4, '0')}`,
    ...opts,
  })
  return { r, clock }
}

describe('state machine', () => {
  test('queued runs, pauses, resumes and finishes', () => {
    const { r } = registry()
    const j = r.create(alice, 'import')
    expect(j.state).toBe('queued')
    expect(r.start(j.id).state).toBe('running')
    r.pause(j.id, { ...empty, resume: { decodedOffset: 10, statementNumber: 2 } })
    expect(r.get(j.id, alice)?.state).toBe('paused')
    expect(r.get(j.id, alice)?.result?.resume).toEqual({ decodedOffset: 10, statementNumber: 2 })
    expect(r.resume(j.id, alice).state).toBe('running')
    const done = r.finish(j.id, 'done', empty)
    expect(done.state).toBe('done')
    expect(done.endedAt).toBeDefined()
  })

  test('every move outside the table is refused', () => {
    const states = Object.keys(TRANSITIONS) as JobState[]
    for (const from of states) {
      for (const to of states) {
        const { r } = registry()
        const j = r.create(alice, 'export')
        if (from !== 'queued') {
          r.start(j.id)
          if (from === 'paused') r.pause(j.id, empty)
          else if (from !== 'running') r.finish(j.id, from as 'done', empty)
        }
        const allowed = TRANSITIONS[from].includes(to)
        const act = () => {
          if (to === 'running') {
            if (from === 'paused') r.resume(j.id, alice)
            else r.start(j.id)
          } else if (to === 'paused') r.pause(j.id, empty)
          else if (to === 'queued')
            throw new JobError('invalid_transition', 'no way back to queued')
          else r.finish(j.id, to, empty)
        }
        if (allowed) expect(act, `${from} -> ${to}`).not.toThrow()
        else expect(act, `${from} -> ${to}`).toThrow(JobError)
      }
    }
  })

  test('an ended job stays ended', () => {
    const { r } = registry()
    const j = r.create(alice, 'export')
    r.start(j.id)
    r.finish(j.id, 'failed', empty)
    expect(() => r.finish(j.id, 'done', empty)).toThrow(JobError)
    expect(() => r.start(j.id)).toThrow(JobError)
  })

  test('progress is merged while alive and ignored after the end', () => {
    const { r } = registry()
    const j = r.create(alice, 'import')
    r.start(j.id)
    r.progress(j.id, { bytes: 10, rows: 2 })
    r.progress(j.id, { bytes: 20 })
    expect(r.get(j.id, alice)?.progress).toEqual({ bytes: 20, rows: 2 })
    r.finish(j.id, 'done', empty)
    r.progress(j.id, { bytes: 99 })
    expect(r.get(j.id, alice)?.progress.bytes).toBe(20)
  })
})

describe('owner binding', () => {
  test('another user or session sees nothing', async () => {
    const { r } = registry()
    const j = r.create(alice, 'export')
    expect(r.get(j.id, bob)).toBeUndefined()
    expect(r.get(j.id, { sessionId: 's9', user: 'alice' })).toBeUndefined()
    expect(r.get('nope', alice)).toBeUndefined()
    expect(r.list(bob)).toEqual([])
    await expect(r.cancel(j.id, bob)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('concurrency', () => {
  test('one import per user by default, two exports, paused does not count', () => {
    const { r } = registry()
    const a = r.create(alice, 'import')
    expect(() => r.create(alice, 'import')).toThrow(expect.objectContaining({ code: 'busy' }))
    r.create(bob, 'import') // another user is not affected
    r.start(a.id)
    expect(() => r.create(alice, 'import')).toThrow(expect.objectContaining({ code: 'busy' }))
    r.pause(a.id, empty)
    const b = r.create(alice, 'import')
    expect(b.state).toBe('queued')
    r.start(b.id)
    // the paused one cannot resume while another import runs
    expect(() => r.resume(a.id, alice)).toThrow(expect.objectContaining({ code: 'busy' }))
    r.finish(b.id, 'done', empty)
    expect(r.resume(a.id, alice).state).toBe('running')

    r.create(alice, 'export')
    r.create(alice, 'export')
    expect(() => r.create(alice, 'export')).toThrow(expect.objectContaining({ code: 'busy' }))
  })

  test('the limit is a parameter (ST-155: up to 3)', () => {
    const { r } = registry()
    for (let i = 0; i < 3; i++) r.create(alice, 'import', { maxImports: 3 })
    expect(() => r.create(alice, 'import', { maxImports: 3 })).toThrow(JobError)
  })

  test('an ended job frees its slot', () => {
    const { r } = registry()
    const a = r.create(alice, 'import')
    r.start(a.id)
    r.finish(a.id, 'failed', empty)
    expect(() => r.create(alice, 'import')).not.toThrow()
  })
})

describe('cancel', () => {
  test('runs the hook, aborts the signal and ends the job as cancelled', async () => {
    const { r } = registry()
    const j = r.create(alice, 'import')
    r.start(j.id)
    const hook = vi.fn()
    r.setCancelHook(j.id, hook)
    const signal = r.signal(j.id)
    expect(signal.aborted).toBe(false)
    const out = await r.cancel(j.id, alice)
    expect(hook).toHaveBeenCalledOnce()
    expect(signal.aborted).toBe(true)
    expect(out.state).toBe('cancelled')
    expect(out.result?.error?.code).toBe('cancelled')
  })

  test('a failing hook does not stop the cancel; a second cancel changes nothing', async () => {
    const { r } = registry()
    const j = r.create(alice, 'export')
    r.start(j.id)
    const hook = vi.fn().mockRejectedValue(new Error('boom'))
    r.setCancelHook(j.id, hook)
    expect((await r.cancel(j.id, alice)).state).toBe('cancelled')
    expect((await r.cancel(j.id, alice)).state).toBe('cancelled')
    expect(hook).toHaveBeenCalledOnce()
  })

  test('a paused job can be cancelled; a done job is returned as is', async () => {
    const { r } = registry()
    const j = r.create(alice, 'import')
    r.start(j.id)
    r.pause(j.id, empty)
    expect((await r.cancel(j.id, alice)).state).toBe('cancelled')
    const k = r.create(alice, 'import')
    r.start(k.id)
    r.finish(k.id, 'done', empty)
    expect((await r.cancel(k.id, alice)).state).toBe('done')
  })
})

describe('record size (NFR-ISS-104)', () => {
  const huge = (): IoJob => ({
    id: 'x'.repeat(22),
    kind: 'import',
    state: 'done_with_rejects',
    progress: {
      bytes: 5e9,
      totalBytes: 5e9,
      rows: 1e9,
      statements: 1e8,
      object: { index: 3, total: 9, name: 'n'.repeat(5000) },
    },
    startedAt: 1,
    endedAt: 2,
    result: {
      fileName: 'f'.repeat(1000),
      skipped: Array.from({ length: 500 }, (_, i) => ({
        object: `t${i}`.repeat(50),
        message: 'm'.repeat(2000),
      })),
      rejected: Array.from({ length: 100 }, (_, i) => ({
        row: i,
        column: 'c'.repeat(300),
        code: 'x',
        message: 'm'.repeat(2000),
      })),
      rejectedCount: 12_345_678,
      notes: Array.from({ length: 300 }, () => 'n'.repeat(1000)),
      statements: { run: 1, skipped: 2, failed: 3 },
      rows: 99,
      error: {
        code: 'statement_failed',
        message: 'e'.repeat(9000),
        serverMessage: 's'.repeat(9000),
        statementText: 'q'.repeat(9000),
        errno: 1064,
      },
      resume: { decodedOffset: 4_000_000_000, statementNumber: 77 },
      durationMs: 5,
    },
  })

  test('boundRecord keeps any record within 4 KB and keeps counts and the resume point', () => {
    const out = boundRecord(huge())
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(JOB_RECORD_MAX_BYTES)
    expect(out.result?.rejectedCount).toBe(12_345_678)
    expect(out.result?.resume).toEqual({ decodedOffset: 4_000_000_000, statementNumber: 77 })
    expect(out.result?.error?.code).toBe('statement_failed')
    expect(out.state).toBe('done_with_rejects')
  })

  test('the registry stores and returns bounded records', () => {
    const { r } = registry()
    const j = r.create(alice, 'import')
    r.start(j.id)
    r.progress(j.id, { bytes: 1, object: { index: 1, total: 1, name: 'o'.repeat(100_000) } })
    r.finish(j.id, 'done_with_rejects', huge().result!)
    const got = r.get(j.id, alice)!
    expect(Buffer.byteLength(JSON.stringify(got))).toBeLessThanOrEqual(JOB_RECORD_MAX_BYTES)
  })

  test('size does not grow with the number of progress updates', () => {
    const { r } = registry()
    const j = r.create(alice, 'import')
    r.start(j.id)
    const size = () => Buffer.byteLength(JSON.stringify(r.get(j.id, alice)))
    r.progress(j.id, { bytes: 1, rows: 1, statements: 1 })
    const first = size()
    for (let i = 0; i < 10_000; i++) r.progress(j.id, { bytes: i * 1e6, rows: i, statements: i })
    expect(size()).toBeLessThanOrEqual(first + 40)
  })
})

describe('retention and sessions', () => {
  test('ended jobs go after 24 hours, running ones stay', () => {
    const removed: string[] = []
    const { r, clock } = registry({ onRemove: (id) => removed.push(id) })
    const a = r.create(alice, 'export')
    const b = r.create(bob, 'export')
    r.start(a.id)
    r.finish(a.id, 'done', empty)
    r.start(b.id)
    clock.advance(JOB_RETENTION_MS - 1)
    expect(r.sweep()).toEqual([])
    clock.advance(1)
    expect(r.sweep()).toEqual([a.id])
    expect(removed).toEqual([a.id])
    expect(r.get(a.id, alice)).toBeUndefined()
    expect(r.get(b.id, bob)?.state).toBe('running')
  })

  test('dropSession cancels and removes the jobs of that session only', async () => {
    const { r } = registry()
    const a = r.create(alice, 'import')
    r.start(a.id)
    const hook = vi.fn()
    r.setCancelHook(a.id, hook)
    const b = r.create(bob, 'import')
    await r.dropSession('s1')
    expect(hook).toHaveBeenCalled()
    expect(r.get(a.id, alice)).toBeUndefined()
    expect(r.get(b.id, bob)).toBeDefined()
  })

  test('whenEnded resolves at the end or at the timeout', async () => {
    vi.useFakeTimers()
    try {
      const { r } = registry()
      const j = r.create(alice, 'export')
      r.start(j.id)
      let ended = false
      const p = r.whenEnded(j.id, 5000).then(() => (ended = true))
      await vi.advanceTimersByTimeAsync(100)
      expect(ended).toBe(false)
      r.finish(j.id, 'done', empty)
      await p
      expect(ended).toBe(true)
      const k = r.create(bob, 'export')
      r.start(k.id)
      const q = r.whenEnded(k.id, 50)
      await vi.advanceTimersByTimeAsync(60)
      await q
    } finally {
      vi.useRealTimers()
    }
  })
})
