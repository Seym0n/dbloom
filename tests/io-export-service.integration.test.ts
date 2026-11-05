import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createPool, type Pool } from 'mysql2/promise'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { handleIoDownload, type IoHttpEnv } from '~/server/io/http'
import { JobRegistry, isTerminal } from '~/server/io/jobs'
import { resolveIoLimits } from '~/server/io/limits'
import {
  cancelJobImpl,
  getIoCapabilitiesImpl,
  getJobImpl,
  resetExportState,
  startExportImpl,
  type ExportServiceEnv,
} from '~/server/io/export-service'
import { MemoryIoPrefs, MemoryIoTemplates } from '~/server/io/store'
import { TempStore } from '~/server/io/temp'
import { exportRequest, MiB, type ExportRequest, type IoJob } from '~/server/io/types'
import { createFixture } from './io-export-fixture'
import { PRODUCTS } from './io-roundtrip-helpers'

// FR-IO-001, 009, 010, 021: jobs, polling, cancel, download and audit around the export engine.

describe.each(PRODUCTS)('export jobs on $name', ({ port, product }) => {
  const DB = `io_expjob_${product}`
  let pool: Pool
  let limitedPool: Pool
  let root: string
  let temp: TempStore
  let jobs: JobRegistry
  const owner = { sessionId: 'sess', user: 'alice' }
  let logs: string[] = []

  const limits = resolveIoLimits()
  const env = (over: Partial<ExportServiceEnv> = {}): ExportServiceEnv => ({
    pool,
    temp,
    jobs,
    owner,
    limits,
    mayDisableFormulaNeutralisation: true,
    prefs: new MemoryIoPrefs(),
    templates: new MemoryIoTemplates(),
    targetLabel: `127.0.0.1:${port}`,
    serverName: '127.0.0.1',
    ...over,
  })
  const req = (o: Record<string, unknown>): ExportRequest =>
    exportRequest.parse({ scope: { kind: 'table', db: DB, table: 'z_parent' }, format: 'sql', compression: 'none', ...o })

  const finished = async (id: string, ms = 60_000): Promise<IoJob> => {
    const until = Date.now() + ms
    for (;;) {
      const job = getJobImpl(env(), id)
      if (isTerminal(job.state)) return job
      if (Date.now() > until) throw new Error('job did not end')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  const runtime = {
    sessions: {
      resolve: (t: string | undefined) => (t === 'good' ? { idHash: 'sess' } : undefined),
      verifyCsrf: () => true,
    },
  } as never
  const download = (id: string) =>
    handleIoDownload(
      new Request(`http://x/api/io/download/${id}`, { headers: { cookie: '__Host-dbloom-session=good', 'sec-fetch-site': 'same-origin' } }),
      id,
      runtime,
      () => ({ temp, jobs, owner, limits, readOnly: false, targetLabel: 'x' }) as IoHttpEnv,
    )
  const auditLines = (name: string) =>
    logs.flatMap((l) => {
      try {
        const o = JSON.parse(l) as Record<string, unknown>
        return o.audit === name ? [o] : []
      } catch {
        return []
      }
    })

  beforeAll(async () => {
    const opts = { host: '127.0.0.1', port, charset: 'utf8mb4' as const, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, jsonStrings: true }
    pool = createPool({ ...opts, user: 'root', password: 'root', connectionLimit: 10 })
    await createFixture(pool, DB, product, 20_000)
    const user = `io_job_${product}`
    await pool.query(`DROP USER IF EXISTS '${user}'@'%'`)
    await pool.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'pw'`)
    await pool.query(`GRANT SELECT ON ${DB}.z_parent TO '${user}'@'%'`)
    await pool.query(`GRANT INSERT ON ${DB}.a_child TO '${user}'@'%'`)
    limitedPool = createPool({ ...opts, user, password: 'pw', connectionLimit: 4 })
  }, 120_000)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'io-expjob-'))
    temp = new TempStore({ dir: root, quotaBytes: 2048 * MiB, maxFilesPerOwner: 50 })
    jobs = new JobRegistry()
    resetExportState()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((l: unknown) => void logs.push(String(l)))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await pool.query(`DROP USER IF EXISTS 'io_job_${product}'@'%'`)
    await pool.query(`DROP DATABASE IF EXISTS ${DB}`)
    await limitedPool.end()
    await pool.end()
  })

  test('start, poll, download (SCN-052)', async () => {
    const { jobId } = await startExportImpl(env(), req({}))
    expect(jobId.length).toBeGreaterThan(10)
    const job = await finished(jobId)
    expect(job.state).toBe('done')
    expect(job.result?.fileName).toBe(`z_parent_${DB}.sql`)
    expect(job.result?.rows).toBe(2)
    expect(JSON.stringify(job).length).toBeLessThanOrEqual(4096)

    const res = await download(jobId)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/sql')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="z_parent_${DB}.sql"; filename*=UTF-8''z_parent_${DB}.sql`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(100)
    const body = await res.text()
    expect(body).toContain('CREATE TABLE `z_parent`')
    expect(body).toContain("INSERT INTO `z_parent` (`id`,`name`) VALUES (1,'one'),(2,'zwei');")

    // the same job is not visible to another session or user
    expect(jobs.get(jobId, { sessionId: 'other', user: 'alice' })).toBeUndefined()

    // audit: start and end lines, no cell value, no statement text
    const start = auditLines('io.export.start')
    const end = auditLines('io.export.end')
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({ jobId, scope: 'table', format: 'sql', compression: 'none', db: DB, user: 'alice' })
    expect(end[0]).toMatchObject({ jobId, state: 'done', rows: 2, format: 'sql' })
    const text = logs.join('\n')
    for (const secret of ['zwei', 'SELECT', 'INSERT', 'CREATE TABLE']) expect(text).not.toContain(secret)
  })

  test('text view is served as text and at most 2 MiB (FR-IO-009)', async () => {
    const { jobId } = await startExportImpl(env(), req({ view: 'text', format: 'csv' }))
    expect((await finished(jobId)).state).toBe('done')
    const res = await download(jobId)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('id,name\n1,one\n2,zwei\n')
  })

  test('failed job: no output, the download aborts with the reason (FR-IO-010)', async () => {
    const { jobId } = await startExportImpl(
      env({ pool: limitedPool }),
      req({ scope: { kind: 'table', db: DB, table: 'a_child' }, format: 'csv' }),
    )
    const job = await finished(jobId)
    expect(job.state).toBe('failed')
    expect(job.result?.error).toMatchObject({ code: 'export_failed', errno: 1142 })
    expect(job.result?.error?.message).toContain('a_child')
    const res = await download(jobId)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('export_failed')
    expect(readdirSync(root).filter((f) => /^[0-9a-f]{32}$/.test(f))).toHaveLength(0)
    expect(auditLines('io.export.end')[0]).toMatchObject({ state: 'failed', errorCode: 'export_failed', errno: 1142 })
  })

  test('skipped objects end as done_with_skips and are listed (SCN-055)', async () => {
    const { jobId } = await startExportImpl(
      env({ pool: limitedPool }),
      req({ scope: { kind: 'database', db: DB, tables: ['a_child', 'z_parent'] }, skipUnreadable: true, options: { content: 'data' } }),
    )
    const job = await finished(jobId)
    expect(job.state).toBe('done_with_skips')
    expect(job.result?.skipped).toHaveLength(1)
    expect(job.result?.skipped[0]!.object).toBe(`${DB}.a_child`)
    expect(job.result?.skipped[0]!.message).toMatch(/denied/i)
    expect((await download(jobId)).status).toBe(200)
  })

  test('cancel ends the job, offers nothing and audits the event (G4)', async () => {
    const { jobId } = await startExportImpl(env(), req({ scope: { kind: 'table', db: DB, table: 'bulk' }, format: 'json', options: { pretty: true } }))
    // wait for rows, then cancel
    for (let i = 0; i < 200 && (getJobImpl(env(), jobId).progress.rows ?? 0) === 0 && !isTerminal(getJobImpl(env(), jobId).state); i++)
      await new Promise((r) => setTimeout(r, 5))
    const cancelled = await cancelJobImpl(env(), jobId)
    const job = await finished(jobId)
    // a very fast export may have finished before the cancel; then nothing was cancelled
    if (cancelled.state === 'cancelled') {
      expect(job.state).toBe('cancelled')
      expect(job.result?.error?.code).toBe('cancelled')
      expect((await download(jobId)).status).toBe(409)
      expect(existsSync(join(root, 'nothing'))).toBe(false)
      // the job is terminal as soon as the cancel lands; the spool file goes when the export run unwinds, a moment later
      await vi.waitFor(() => expect(readdirSync(root).filter((f) => /^[0-9a-f]{32}$/.test(f))).toHaveLength(0), { timeout: 5000 })
    }
    expect(auditLines('io.job.cancel')).toHaveLength(1)
  })

  test('two exports at a time per user, further starts are busy (FR-IO-001)', async () => {
    const big = req({ scope: { kind: 'table', db: DB, table: 'bulk' }, format: 'csv' })
    const a = await startExportImpl(env(), big)
    const b = await startExportImpl(env(), big)
    await expect(startExportImpl(env(), big)).rejects.toMatchObject({ code: 'busy' })
    await finished(a.jobId)
    await finished(b.jobId)
    // another user is not affected
    const c = await startExportImpl(env({ owner: { sessionId: 'sess2', user: 'bob' } }), big)
    expect(c.jobId).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
  })

  test('only the newest spool files of an owner stay (per-owner file limit)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const { jobId } = await startExportImpl(env(), req({}))
      ids.push(jobId)
      await finished(jobId)
    }
    const files = readdirSync(root).filter((f) => /^[0-9a-f]{32}$/.test(f))
    expect(files.length).toBeLessThanOrEqual(4)
    expect((await download(ids[5]!)).status).toBe(200)
  })

  test('compressed download is a gzip file with the name and type', async () => {
    const { jobId } = await startExportImpl(env(), req({ compression: 'gzip', format: 'json' }))
    expect((await finished(jobId)).state).toBe('done')
    const res = await download(jobId)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    expect(res.headers.get('content-disposition')).toContain(`z_parent_${DB}.json.gz`)
    const doc = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()) as unknown[]
    expect(doc).toHaveLength(3)
  })

  test('a hostile file name template becomes harmless (SEC-IOX-033)', async () => {
    const { jobId } = await startExportImpl(env(), req({ fileNameTemplate: '../x";.csv<img onerror=1>', format: 'csv' }))
    const job = await finished(jobId)
    expect(job.result?.fileName).toMatch(/^[\p{L}\p{N}_.-]+$/u)
    expect(job.result?.fileName).not.toContain('..')
    const res = await download(jobId)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9._%-]+$/)
  })

  test('capabilities report formats, limits and the target', async () => {
    const caps = await getIoCapabilitiesImpl(env())
    expect(caps.formats).toEqual(['sql', 'csv', 'json'])
    expect(caps.compressions).toEqual(['none', 'gzip', 'zip'])
    expect(caps.limits.mayDisableFormulaNeutralisation).toBe(true)
    expect(caps.target.product).toBe(product)
    expect(caps.charsets.map((c) => c.name)).toContain('windows-1252')
  })
})
