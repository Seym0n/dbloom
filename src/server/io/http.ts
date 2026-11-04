import { CONNECTION_HEADER, CONNECTION_PARAM, CSRF_HEADER } from '../../lib/csrf'
import { SESSION_COOKIE } from '../middleware'
import { AuthError } from '../auth/types'
import { resolveTargetSession } from '../session-context'
import type { Runtime } from '../runtime'
import type { LiveSession } from '../sessions'
import { isStateless, ownerKeyFor } from '../sql/state'
import { auditIo } from '../audit'
import { registerShutdownStep, unregisterShutdownStep } from '../lifecycle/shutdown'
import { log } from '../log'
import { JobRegistry, isDone, isTerminal, type JobOwner } from './jobs'
import { limitsFor, uploadLimitNote, type IoLimitsResolved } from './limits'
import { memoryIoPrefs } from './store'
import { TempError, TempStore, type StageWriter, type TempOwner } from './temp'
import { ioFormat, type IoErrorCode } from './types'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

/**
 * Request handling of the two routes under `/api/io/` (FR-IO-012, FR-IO-009), kept out of the route files so
 * it can be tested with plain `Request` objects. A caller that cannot be identified gets the same neutral
 * answer whatever the reason. Error bodies use the closed code list of `types.ts`; no text names server
 * configuration files (FR-IOX-095).
 */

type RuntimeLike = Pick<Runtime, 'sessions' | 'config' | 'store'> & Partial<Pick<Runtime, 'setup' | 'statelessPrefs'>>

export type IoHttpEnv = {
  temp: TempStore
  jobs: JobRegistry
  owner: JobOwner & TempOwner
  limits: IoLimitsResolved
  /** Read-only is forced by `.env` or set on the session: import (and so upload) is refused. */
  readOnly: boolean
  /** Audit labels. */
  targetLabel: string
}

// ---- Shared services -------------------------------------------------------------------------------------

export type IoServices = { temp: TempStore; jobs: JobRegistry }
let services: IoServices | undefined

/** Process-wide temp store and job registry; created on first use with the temp directory of the config. */
export function getIoServices(
  config: Pick<Runtime['config'], 'dataDir' | 'tempDir' | 'tempQuotaMiB'>,
): IoServices {
  if (services) return services
  const temp = new TempStore({
    dir: config.tempDir ?? join(config.dataDir, 'tmp'),
    quotaBytes: (config.tempQuotaMiB ?? 10_240) * 1024 * 1024,
  })
  const jobs = new JobRegistry({ onRemove: (id) => void temp.remove(id) })
  temp.startSweeper()
  jobs.startSweeper()
  services = { temp, jobs }
  // Shutdown (FR-SVR-014): running jobs end as `interrupted` first, their files are removed after the pools closed.
  registerShutdownStep({
    name: 'io-jobs',
    order: 10,
    run: async () => {
      jobs.stopSweeper()
      for (const j of await jobs.interruptAll()) log.info('io.job.interrupted', { jobId: j.id, kind: j.kind, was: j.from, state: 'interrupted' })
    },
  })
  registerShutdownStep({
    name: 'io-temp',
    order: 30,
    run: async () => {
      temp.stopSweeper()
      log.info('io.temp.removed', { files: await temp.removeAll() })
    },
  })
  return services
}

/** For tests: forget the singleton. */
export function resetIoServices(): void {
  services?.temp.stopSweeper()
  services?.jobs.stopSweeper()
  unregisterShutdownStep('io-jobs')
  unregisterShutdownStep('io-temp')
  services = undefined
}

export function ioEnvOf(session: LiveSession, runtime: RuntimeLike): IoHttpEnv {
  const stateless = isStateless()
  const ownerKey = ownerKeyFor(session)
  const targetLabel = `${session.target.host}${session.target.zone ?? ''}:${session.target.port}`
  const prefs = stateless ? (runtime.statelessPrefs?.io ?? memoryIoPrefs) : runtime.store.ioPrefs
  return {
    ...getIoServices(runtime.config),
    owner: { sessionId: session.idHash, user: ownerKey },
    limits: limitsFor(prefs, ownerKey, targetLabel, runtime.config),
    readOnly: runtime.config.readOnly || session.readOnly,
    targetLabel,
  }
}

// ---- Request helpers (same rules as rows/http.ts) -----------------------------------------------------

function cookieOf(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/** Browsers announce cross-site requests; refuse them (SEC-TGT-042). */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  return !site || site === 'same-origin' || site === 'none'
}

async function sessionOf(
  request: Request,
  runtime: RuntimeLike,
  requireCsrf: boolean,
): Promise<LiveSession | undefined> {
  if (!sameOrigin(request)) return undefined
  // Account mode: the connection comes in a header, or in a query parameter where a link cannot set one (FR-AUT-018).
  const connectionId = request.headers.get(CONNECTION_HEADER) ?? new URL(request.url).searchParams.get(CONNECTION_PARAM) ?? undefined
  const csrf = request.headers.get(CSRF_HEADER) ?? undefined
  try {
    return await resolveTargetSession(runtime, {
      token: cookieOf(request, SESSION_COOKIE),
      connectionId,
      csrf,
      requireCsrf,
      background: false,
    })
  } catch (error) {
    // Maintenance mode refuses a user: the same neutral answer as a missing session.
    if (error instanceof AuthError) return undefined
    throw error
  }
}

const neutral = (status: number) =>
  new Response(status === 404 ? 'Not found' : 'Forbidden', {
    status,
    headers: { 'cache-control': 'no-store' },
  })

const STATUS: Partial<Record<IoErrorCode, number>> = {
  invalid_request: 400,
  upload_empty: 400,
  upload_interrupted: 400,
  upload_too_large: 413,
  quota_full: 507,
  upload_failed: 500,
  read_only: 403,
  format_disabled: 400,
  busy: 429,
  export_failed: 409,
  cancelled: 409,
  interrupted: 409,
}

export function ioErrorResponse(
  code: IoErrorCode,
  message: string,
  status = STATUS[code] ?? 400,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Display name: control characters out, separators to `_`, at most 255 characters. Metadata only, never a path. */
export function displayNameOf(raw: string | null | undefined): string {
  if (!raw) return 'upload'
  const name = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
  return name ? name.slice(0, 255) : 'upload'
}

// ---- PUT /api/io/upload ---------------------------------------------------------------------------------------

const tooLarge = (l: IoLimitsResolved) => `The file is larger than the limit. ${uploadLimitNote(l)}`

/**
 * `PUT /api/io/upload?name=<display name>&format=sql|csv|json` (CSRF header and session). The body is the
 * file itself. `Content-Length` is checked before anything is read; bytes are counted while reading, so a
 * lying or missing length is cut off at the limit. The answer carries the upload id.
 */
export async function handleIoUpload(
  request: Request,
  runtime: RuntimeLike,
  env: (session: LiveSession) => IoHttpEnv = (s) => ioEnvOf(s, runtime),
): Promise<Response> {
  const session = await sessionOf(request, runtime, true)
  if (!session) return neutral(403)
  let e: IoHttpEnv
  try {
    e = env(session)
  } catch {
    return ioErrorResponse('upload_failed', 'The file could not be stored')
  }
  const audit = (
    event: 'io.upload' | 'io.upload.refused',
    extra: {
      bytes?: number
      code?: string
      uploadId?: string
      fileName?: string
      format?: string
    } = {},
  ) =>
    auditIo(event, {
      user: e.owner.user,
      target: e.targetLabel,
      errorCode: extra.code,
      bytes: extra.bytes,
      uploadId: extra.uploadId,
      fileName: extra.fileName,
      format: extra.format,
    })

  if (e.readOnly) {
    audit('io.upload.refused', { code: 'read_only' })
    return ioErrorResponse('read_only', 'The connection is read-only; imports are not available')
  }
  const url = new URL(request.url)
  const fmt = ioFormat.safeParse(url.searchParams.get('format'))
  if (!fmt.success)
    return ioErrorResponse('invalid_request', 'The file format is missing or not supported')
  if (!e.limits.formats.includes(fmt.data))
    return ioErrorResponse('format_disabled', 'This file format is not enabled')
  const name = displayNameOf(url.searchParams.get('name'))
  const limit = e.limits.uploadBytes

  const declaredHeader = request.headers.get('content-length')
  const declared =
    declaredHeader === null || declaredHeader.trim() === '' ? undefined : Number(declaredHeader)
  if (declared !== undefined && (!Number.isInteger(declared) || declared < 0)) {
    return ioErrorResponse('invalid_request', 'The request length is invalid')
  }
  if (declared !== undefined && declared > limit) {
    audit('io.upload.refused', { code: 'upload_too_large', bytes: declared })
    return ioErrorResponse('upload_too_large', tooLarge(e.limits))
  }
  if (declared === 0 || !request.body) {
    return ioErrorResponse('upload_empty', 'The file is empty')
  }

  let writer: StageWriter
  try {
    writer = await e.temp.begin(e.owner, 'upload', { name, format: fmt.data, maxBytes: limit })
  } catch (error) {
    return tempFailure(error, e.limits, audit)
  }
  const reader = request.body.getReader()
  const onAbort = () => void reader.cancel().catch(() => undefined)
  request.signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      let step
      try {
        step = await reader.read()
      } catch {
        await writer.abort()
        audit('io.upload.refused', { code: 'upload_interrupted', bytes: writer.bytes })
        return ioErrorResponse('upload_interrupted', 'The upload was interrupted')
      }
      if (step.done) break
      await writer.write(step.value)
    }
    if (request.signal.aborted || (declared !== undefined && writer.bytes !== declared)) {
      await writer.abort()
      audit('io.upload.refused', { code: 'upload_interrupted', bytes: writer.bytes })
      return ioErrorResponse('upload_interrupted', 'The upload was interrupted')
    }
    if (writer.bytes === 0) {
      await writer.abort()
      return ioErrorResponse('upload_empty', 'The file is empty')
    }
    const file = await writer.commit()
    audit('io.upload', { bytes: file.bytes, uploadId: file.id, fileName: name, format: fmt.data })
    return new Response(JSON.stringify({ uploadId: file.id, fileName: name, bytes: file.bytes }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await writer.abort()
    return tempFailure(error, e.limits, audit)
  } finally {
    request.signal.removeEventListener('abort', onAbort)
  }
}

function tempFailure(
  error: unknown,
  limits: IoLimitsResolved,
  audit: (event: 'io.upload.refused', extra: { code: string; bytes?: number }) => void,
): Response {
  if (error instanceof TempError) {
    audit('io.upload.refused', { code: error.code })
    if (error.code === 'upload_too_large')
      return ioErrorResponse('upload_too_large', tooLarge(limits))
    if (error.code === 'quota_full') {
      return ioErrorResponse(
        'quota_full',
        'The server has no room for more import files right now; try again later',
      )
    }
    return ioErrorResponse(error.code, error.message)
  }
  audit('io.upload.refused', { code: 'upload_failed' })
  return ioErrorResponse('upload_failed', 'The file could not be stored')
}

// ---- GET /api/io/download/<id> ----------------------------------------------------------------------------------

/** `attachment` header with an ASCII fallback and the UTF-8 name (RFC 6266, 5987). */
export function contentDisposition(fileName: string): string {
  const clean = fileName.replace(/[\u0000-\u001f\u007f"\\/]/g, '_') || 'export'
  const ascii = clean.replace(/[^A-Za-z0-9._-]/g, '_')
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const MAX_END_WAIT_MS = 5000

/**
 * `GET /api/io/download/<jobId>`: streams the output of an export job of this session and user. The answer
 * is never a clean end unless the job ended in a `done*` state: a failed or cancelled job aborts the stream
 * (the browser shows a failed download, FR-IO-010).
 */
export async function handleIoDownload(
  request: Request,
  id: string,
  runtime: RuntimeLike,
  env: (session: LiveSession) => IoHttpEnv = (s) => ioEnvOf(s, runtime),
): Promise<Response> {
  const session = await sessionOf(request, runtime, false)
  if (!session) return neutral(404)
  let e: IoHttpEnv
  try {
    e = env(session)
  } catch {
    return neutral(404)
  }
  if (id.length < 8 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return neutral(404)
  const { jobs, owner } = e
  const job = jobs.get(id, owner)
  if (!job || job.kind !== 'export') return neutral(404)
  if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted') {
    const err = job.result?.error
    return ioErrorResponse(
      job.state === 'cancelled' ? 'cancelled' : job.state === 'interrupted' ? 'interrupted' : 'export_failed',
      err?.message ?? 'The export did not finish',
      409,
    )
  }
  const output = jobs.getOutput(id, owner)
  if (!output) {
    return isTerminal(job.state)
      ? neutral(404)
      : ioErrorResponse('busy', 'The export is not ready yet', 409)
  }

  let src: Readable
  try {
    src = await output.open()
  } catch {
    return ioErrorResponse('export_failed', 'The export file is not available', 410)
  }

  const fail = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    src.destroy()
    try {
      controller.error(new Error('export_incomplete'))
    } catch {
      // already closed
    }
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => src.destroy()
      request.signal.addEventListener('abort', onAbort, { once: true })
      src.on('data', (chunk: Buffer | string) => {
        const state = jobs.stateOf(id)
        if (state === undefined || state === 'failed' || state === 'cancelled' || state === 'interrupted')
          return fail(controller)
        try {
          controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk))
        } catch {
          return src.destroy()
        }
        if ((controller.desiredSize ?? 1) <= 0) src.pause()
      })
      src.on('end', () => {
        void jobs.whenEnded(id, MAX_END_WAIT_MS).then(() => {
          const state = jobs.stateOf(id)
          if (state !== undefined && isDone(state)) {
            try {
              controller.close()
            } catch {
              // cancelled by the client
            }
          } else fail(controller)
        })
      })
      src.on('error', () => fail(controller))
      src.on('close', () => request.signal.removeEventListener('abort', onAbort))
    },
    pull() {
      src.resume()
    },
    cancel() {
      src.destroy()
    },
  })

  const headers: Record<string, string> = {
    'content-type': output.contentType,
    'content-disposition': contentDisposition(output.fileName),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  const size = output.size()
  if (size !== undefined && isDone(job.state)) headers['content-length'] = String(size)
  return new Response(body, { status: 200, headers })
}
