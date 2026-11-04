import { CONNECTION_HEADER, CONNECTION_PARAM, CSRF_HEADER } from '../../lib/csrf'
import { SESSION_COOKIE } from '../middleware'
import { AuthError } from '../auth/types'
import { resolveTargetSession } from '../session-context'
import type { Runtime } from '../runtime'
import type { LiveSession } from '../sessions'
import {
  cellDownloadResponse,
  clientError,
  rowsEnvOf,
  stageUpload,
  uploadLimit,
  type RowsEnv,
} from './service'
import { UploadRefusal } from './blob'

/**
 * Request handling of the two routes under `/api/rows/` (FR-ROW-012), kept out of the route files so it can be
 * tested with plain `Request` objects. Every failure to identify the caller is the same neutral answer.
 */

type RuntimeLike = Pick<Runtime, 'sessions'>

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

const neutral = (status: number) =>
  new Response(status === 404 ? 'Not found' : 'Forbidden', {
    status,
    headers: { 'cache-control': 'no-store' },
  })

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

/** `GET /api/rows/cell/<id>`: one use, 60 seconds, owning session only. */
export async function handleCellGet(
  request: Request,
  id: string,
  runtime: RuntimeLike,
  env: (session: LiveSession) => RowsEnv = rowsEnvOf,
): Promise<Response> {
  const session = await sessionOf(request, runtime, false)
  if (!session) return neutral(404)
  try {
    return await cellDownloadResponse(env(session), id)
  } catch {
    return neutral(404)
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

function fileNameOf(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    // keep the raw text
  }
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
  return name ? name.slice(0, 255) : undefined
}

/** Reads the body up to `limit` bytes; `undefined` when it is larger. */
async function readLimited(request: Request, limit: number): Promise<Buffer | undefined> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return undefined
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * `POST /api/rows/upload` (CSRF header and session): the body is the file itself (`application/octet-stream`,
 * optional `X-File-Name`) or a `multipart/form-data` form with the file in the field `file`. The bytes are
 * staged in session memory; the answer carries the id the write refers to.
 */
export async function handleUpload(
  request: Request,
  runtime: RuntimeLike,
  env: (session: LiveSession) => RowsEnv = rowsEnvOf,
): Promise<Response> {
  const session = await sessionOf(request, runtime, true)
  if (!session) return neutral(403)
  try {
    const rowsEnv = env(session)
    // Writes are refused on a read-only connection before anything is staged.
    if (rowsEnv.guard.forcedReadOnly || rowsEnv.guard.sessionReadOnly) {
      return json(403, { error: 'read-only' })
    }
    const limit = await uploadLimit(rowsEnv)
    const type = request.headers.get('content-type') ?? ''
    let bytes: Buffer | undefined
    let fileName: string | undefined
    if (type.toLowerCase().startsWith('multipart/form-data')) {
      const declared = Number(request.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > limit + 1024 * 1024) {
        return json(413, { error: 'too-large', limit })
      }
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof File)) return json(400, { error: 'no-file' })
      if (file.size > limit) return json(413, { error: 'too-large', limit })
      bytes = Buffer.from(await file.arrayBuffer())
      fileName = fileNameOf(file.name)
    } else {
      bytes = await readLimited(request, limit)
      fileName = fileNameOf(request.headers.get('x-file-name'))
    }
    if (!bytes) return json(413, { error: 'too-large', limit })
    return json(200, stageUpload(rowsEnv, bytes, fileName))
  } catch (error) {
    if (error instanceof UploadRefusal) return json(413, { error: error.code })
    return json(500, { error: clientError(error).message.split(':')[0] })
  }
}
