import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { JobRegistry, type SpoolSource } from '~/server/io/jobs'
import {
  contentDisposition,
  displayNameOf,
  handleIoDownload,
  handleIoUpload,
  type IoHttpEnv,
} from '~/server/io/http'
import { resolveIoLimits, ioBoundsFromConfig } from '~/server/io/limits'
import { TempStore } from '~/server/io/temp'
import { MiB, type JobResult } from '~/server/io/types'

const CSRF = 'csrf-token-value'
const COOKIE = '__Host-dbloom-session=good-token'

let root: string
let temp: TempStore
let jobs: JobRegistry
let readOnly = false
let limits = resolveIoLimits({ 'io.uploadMiB': 1 }) // 1 MiB

const session = (idHash = 'sess-a') => ({
  idHash,
  csrf: CSRF,
  target: {},
  pool: {},
  readOnly: false,
})
const runtime = (s = session()) =>
  ({
    sessions: {
      resolve: (token: string | undefined) => (token === 'good-token' ? s : undefined),
      verifyCsrf: (_s: unknown, presented: string | undefined) => presented === CSRF,
    },
  }) as never
const env = (sessionId = 'sess-a', user = 'alice'): IoHttpEnv => ({
  temp,
  jobs,
  owner: { sessionId, user },
  limits,
  readOnly,
  targetLabel: 'db:3306',
})

const headers = (extra: Record<string, string> = {}) => ({
  cookie: COOKIE,
  'sec-fetch-site': 'same-origin',
  [`x-dbloom-csrf`]: CSRF,
  ...extra,
})

const put = (
  query: string,
  body: BodyInit | null,
  h: Record<string, string> = {},
  signal?: AbortSignal,
) =>
  handleIoUpload(
    new Request(`http://x/api/io/upload${query}`, {
      method: 'PUT',
      headers: headers(h),
      body,
      signal,
      ...(body && typeof body !== 'string' && !(body instanceof Uint8Array)
        ? { duplex: 'half' }
        : {}),
    } as RequestInit),
    runtime(),
    () => env(),
  )

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error

const streamOf = (chunks: Uint8Array[], failAfter?: number) => {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (failAfter !== undefined && i >= failAfter) return c.error(new Error('connection reset'))
      if (i < chunks.length) c.enqueue(chunks[i++]!)
      else c.close()
    },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dbloom-io-http-'))
  temp = new TempStore({ dir: join(root, 'tmp'), quotaBytes: 8 * MiB })
  jobs = new JobRegistry()
  readOnly = false
  limits = resolveIoLimits({ 'io.uploadMiB': 1 })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('PUT /api/io/upload', () => {
  test('needs session, CSRF header and same origin; the answer is the same neutral 403', async () => {
    const body = Buffer.from('select 1;')
    const call = (h: Record<string, string>) =>
      handleIoUpload(
        new Request('http://x/api/io/upload?format=sql', { method: 'PUT', headers: h, body }),
        runtime(),
        () => env(),
      )
    expect((await call({})).status).toBe(403)
    expect((await call({ cookie: COOKIE })).status).toBe(403)
    expect((await call({ cookie: COOKIE, 'x-dbloom-csrf': 'wrong' })).status).toBe(403)
    expect((await call(headers({ 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
    expect(
      (await call({ cookie: '__Host-dbloom-session=bad', 'x-dbloom-csrf': CSRF })).status,
    ).toBe(403)
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('stores the body under a random name and answers with the id', async () => {
    const res = await put('?format=sql&name=dump%20one.sql', Buffer.from('select 1;'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const out = (await res.json()) as { uploadId: string; fileName: string; bytes: number }
    expect(out.bytes).toBe(9)
    expect(out.fileName).toBe('dump one.sql')
    const f = temp.get(out.uploadId, env().owner)!
    expect(readFileSync(f.path, 'utf8')).toBe('select 1;')
    expect(f.format).toBe('sql')
    expect(readdirSync(temp.dir)).toEqual([out.uploadId])
    // bound to the owner
    expect(temp.get(out.uploadId, { sessionId: 'sess-b', user: 'alice' })).toBeUndefined()
  })

  test('a hostile display name stays metadata', async () => {
    const res = await put(
      '?format=csv&name=' + encodeURIComponent('../../etc/passwd\r\nx: y'),
      Buffer.from('a,b'),
    )
    const out = (await res.json()) as { uploadId: string; fileName: string }
    expect(out.fileName).toBe('.._.._etc_passwdx: y')
    expect(readdirSync(temp.dir)).toEqual([out.uploadId])
    expect(displayNameOf(undefined)).toBe('upload')
    expect(displayNameOf('')).toBe('upload')
    expect(displayNameOf('a'.repeat(400))).toHaveLength(255)
  })

  test('the format must be known and enabled', async () => {
    expect((await errorOf(await put('', Buffer.from('x')))).code).toBe('invalid_request')
    expect((await errorOf(await put('?format=xml', Buffer.from('x')))).code).toBe('invalid_request')
    limits = resolveIoLimits({ 'io.formats': ['sql'] })
    const res = await put('?format=csv', Buffer.from('x'))
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('format_disabled')
  })

  test('read-only refuses before anything is staged', async () => {
    readOnly = true
    const res = await put('?format=sql', Buffer.from('x'))
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('read_only')
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('a declared size over the limit is refused with 413 before the body is read', async () => {
    let pulled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true
          c.enqueue(new Uint8Array(10))
        },
      },
      { highWaterMark: 0 },
    )
    const res = await put('?format=sql', body, { 'content-length': String(2 * MiB) })
    expect(res.status).toBe(413)
    const e = await errorOf(res)
    expect(e.code).toBe('upload_too_large')
    expect(e.message).toMatch(/1 MiB/)
    expect(pulled).toBe(false)
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('a lying length is cut off at the limit and the staged file is removed', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(1)
    const body = streamOf(Array.from({ length: 8 }, () => chunk)) // 2 MiB
    const res = await put('?format=sql', body, { 'content-length': '1000' })
    expect(res.status).toBe(413)
    expect((await errorOf(res)).code).toBe('upload_too_large')
    expect(readdirSync(temp.dir)).toEqual([])
    expect(temp.usedBytes()).toBe(0)
  })

  test('a missing length is counted too', async () => {
    const chunk = new Uint8Array(512 * 1024).fill(1)
    const res = await put('?format=sql', streamOf([chunk, chunk, chunk]))
    expect(res.status).toBe(413)
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('a body shorter than its declared length counts as interrupted', async () => {
    const res = await put('?format=sql', Buffer.from('abc'), { 'content-length': '10' })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('upload_interrupted')
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('an aborted upload removes the staged file', async () => {
    const chunk = new Uint8Array(1024).fill(1)
    const res = await put('?format=sql', streamOf([chunk, chunk, chunk], 2))
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('upload_interrupted')
    expect(readdirSync(temp.dir)).toEqual([])
    expect(temp.usedBytes()).toBe(0)
  })

  test('an empty file is refused, with or without a body stream', async () => {
    const a = await put('?format=sql', Buffer.alloc(0))
    expect((await errorOf(a)).code).toBe('upload_empty')
    const b = await put('?format=sql', null)
    expect((await errorOf(b)).code).toBe('upload_empty')
    const c = await put('?format=sql', streamOf([new Uint8Array(0)]))
    expect((await errorOf(c)).code).toBe('upload_empty')
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('a full temp store answers quota_full with no server details', async () => {
    temp = new TempStore({ dir: join(root, 'tmp2'), quotaBytes: 100 })
    const res = await put('?format=sql', Buffer.alloc(500, 1))
    expect(res.status).toBe(507)
    const e = await errorOf(res)
    expect(e.code).toBe('quota_full')
    expect(readdirSync(temp.dir)).toEqual([])
  })

  test('messages never mention configuration files or paths', async () => {
    const texts: string[] = []
    texts.push(
      (
        await errorOf(
          await put('?format=sql', Buffer.alloc(2 * MiB, 1), { 'content-length': String(2 * MiB) }),
        )
      ).message,
    )
    temp = new TempStore({ dir: join(root, 'tmp3'), quotaBytes: 10 })
    texts.push((await errorOf(await put('?format=sql', Buffer.alloc(50, 1)))).message)
    texts.push((await errorOf(await put('?format=sql', Buffer.alloc(0)))).message)
    limits = resolveIoLimits({}, ioBoundsFromConfig({ importMaxMiB: 1 }))
    texts.push(
      (
        await errorOf(
          await put('?format=sql', Buffer.alloc(2 * MiB, 1), { 'content-length': String(2 * MiB) }),
        )
      ).message,
    )
    for (const t of texts) {
      expect(t).not.toMatch(/php\.ini|\.env|upload_max|post_max|my\.cnf|config|\/|\\/i)
    }
    expect(texts[3]).toMatch(/administrator/)
  })

  test('upload ids from here are accepted by the registry only for the same owner', async () => {
    const res = await put('?format=json', Buffer.from('[]'))
    const { uploadId } = (await res.json()) as { uploadId: string }
    expect(temp.get(uploadId, { sessionId: 'sess-a', user: 'alice' })).toBeDefined()
    expect(temp.get(uploadId, { sessionId: 'sess-a', user: 'bob' })).toBeUndefined()
  })
})

// ---- download ---------------------------------------------------------------------------------------------

const done: JobResult = { skipped: [], rejected: [], rejectedCount: 0, notes: [], durationMs: 1 }
const owner = { sessionId: 'sess-a', user: 'alice' }

function source(over: Partial<SpoolSource> & { stream: () => Readable }): SpoolSource {
  return {
    fileName: 'export.csv',
    contentType: 'text/csv; charset=utf-8',
    size: () => undefined,
    open: () => over.stream(),
    ...over,
  }
}

const get = (id: string, h: Record<string, string> = {}, who = env()) =>
  handleIoDownload(
    new Request(`http://x/api/io/download/${id}`, {
      headers: { cookie: COOKIE, 'sec-fetch-site': 'same-origin', ...h },
    }),
    id,
    runtime(),
    () => who,
  )

const readAll = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString()

describe('GET /api/io/download/:id', () => {
  test('streams a finished export with the headers of FR-IO-009', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    jobs.setOutput(
      job.id,
      source({
        stream: () => Readable.from([Buffer.from('a,b\n'), Buffer.from('1,2\n')]),
        size: () => 8,
      }),
    )
    jobs.finish(job.id, 'done', done)
    const res = await get(job.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="export.csv"; filename*=UTF-8''export.csv`,
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-length')).toBe('8')
    expect(await readAll(res)).toBe('a,b\n1,2\n')
  })

  test('a done_with_skips export is delivered', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    jobs.setOutput(job.id, source({ stream: () => Readable.from([Buffer.from('x')]) }))
    jobs.finish(job.id, 'done_with_skips', done)
    const res = await get(job.id)
    expect(res.headers.get('content-length')).toBeNull()
    expect(await readAll(res)).toBe('x')
  })

  test('the file name cannot inject headers or break out of the quotes', async () => {
    const name = 'ev"il\r\nX-Evil: 1;\\../ü.csv'
    expect(contentDisposition(name)).not.toMatch(/[\r\n]/)
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    jobs.setOutput(
      job.id,
      source({ fileName: name, stream: () => Readable.from([Buffer.from('x')]) }),
    )
    jobs.finish(job.id, 'done', done)
    const res = await get(job.id)
    const cd = res.headers.get('content-disposition')!
    expect(cd).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9._%-]+$/,
    )
    expect(cd).toContain('%C3%BC')
    expect(res.headers.get('x-evil')).toBeNull()
    await res.arrayBuffer()
    expect(contentDisposition("it's (a) *name*.csv")).toContain(
      "UTF-8''it%27s%20%28a%29%20%2Aname%2A.csv",
    )
  })

  test('a live export that fails mid-stream aborts the response', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    const pass = new PassThrough()
    jobs.setOutput(job.id, source({ stream: () => pass }))
    const res = await get(job.id)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    pass.write(Buffer.from('partial'))
    const first = await reader.read()
    expect(Buffer.from(first.value!).toString()).toBe('partial')
    jobs.fail(job.id, { code: 'export_failed', message: 'table unreadable' })
    pass.write(Buffer.from('more'))
    await expect(reader.read()).rejects.toThrow(/export_incomplete/)
  })

  test('a stream that ends while the job is still running and never finishes is not closed cleanly', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    jobs.setOutput(job.id, source({ stream: () => Readable.from([Buffer.from('half')]) }))
    const res = await get(job.id)
    await expect(res.arrayBuffer()).rejects.toThrow()
  }, 15_000)

  test('a source error aborts the response', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    jobs.setOutput(
      job.id,
      source({
        stream: () =>
          new Readable({
            read() {
              this.push(Buffer.from('a'))
              this.destroy(new Error('disk gone'))
            },
          }),
      }),
    )
    jobs.finish(job.id, 'done', done)
    const res = await get(job.id)
    await expect(res.arrayBuffer()).rejects.toThrow()
  })

  test('a failed or cancelled job gives 409 with the reason, never a file', async () => {
    const a = jobs.create(owner, 'export')
    jobs.start(a.id)
    jobs.setOutput(a.id, source({ stream: () => Readable.from([Buffer.from('x')]) }))
    jobs.fail(a.id, { code: 'export_failed', message: 'Table t is unreadable' })
    const ra = await get(a.id)
    expect(ra.status).toBe(409)
    const ea = await errorOf(ra)
    expect(ea.code).toBe('export_failed')
    expect(ea.message).toBe('Table t is unreadable')

    const b = jobs.create(owner, 'export')
    jobs.start(b.id)
    await jobs.cancel(b.id, owner)
    const rb = await get(b.id)
    expect(rb.status).toBe(409)
    expect((await errorOf(rb)).code).toBe('cancelled')
  })

  test('not ready yet is 409 busy; unknown, foreign, import and malformed ids are 404', async () => {
    const a = jobs.create(owner, 'export')
    jobs.start(a.id)
    const r = await get(a.id)
    expect(r.status).toBe(409)
    expect((await errorOf(r)).code).toBe('busy')

    expect((await get('does-not-exist-1234')).status).toBe(404)
    expect((await get('../../etc/passwd')).status).toBe(404)
    expect((await get('short')).status).toBe(404)
    expect((await get(a.id, {}, env('sess-b', 'alice'))).status).toBe(404)
    expect((await get(a.id, {}, env('sess-a', 'bob'))).status).toBe(404)
    const imp = jobs.create(owner, 'import')
    expect((await get(imp.id)).status).toBe(404)
    const fin = jobs.create(owner, 'export')
    jobs.start(fin.id)
    jobs.finish(fin.id, 'done', done) // done but no output
    expect((await get(fin.id)).status).toBe(404)
  })

  test('needs a session; cross-site requests get the neutral 404', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    jobs.setOutput(job.id, source({ stream: () => Readable.from([Buffer.from('x')]) }))
    jobs.finish(job.id, 'done', done)
    const call = (h: Record<string, string>) =>
      handleIoDownload(
        new Request(`http://x/api/io/download/${job.id}`, { headers: h }),
        job.id,
        runtime(),
        () => env(),
      )
    expect((await call({})).status).toBe(404)
    expect((await call({ cookie: COOKIE, 'sec-fetch-site': 'cross-site' })).status).toBe(404)
    expect((await call({ cookie: COOKIE })).status).toBe(200)
  })

  test('a client that goes away destroys the source', async () => {
    const job = jobs.create(owner, 'export')
    jobs.start(job.id)
    const pass = new PassThrough()
    jobs.setOutput(job.id, source({ stream: () => pass }))
    const res = await get(job.id)
    const reader = res.body!.getReader()
    pass.write(Buffer.from('x'))
    await reader.read()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 20))
    expect(pass.destroyed).toBe(true)
  })
})
