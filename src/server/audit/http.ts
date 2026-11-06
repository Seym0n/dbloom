import { sessionCookieOf } from '../session-cookie'
import type { AccountContext } from '../auth/types'
import type { AuditService } from './service'

const neutral = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })

function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

/**
 * Download of a started export. The `audit.export` row was written when the export started; this route only streams.
 * A caller that cannot be identified, or holds no valid token, gets the same neutral 404.
 */
export function handleAuditExportWith(
  request: Request,
  token: string,
  resolve: (cookie: string | undefined) => AccountContext | undefined,
  service: () => AuditService,
): Response {
  const ctx = resolve(cookieOf(request, sessionCookieOf(request)))
  if (!ctx) return neutral()
  try {
    const out = service().openExport(ctx, token)
    return new Response(out.stream, {
      status: 200,
      headers: {
        'Content-Type': out.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return neutral()
  }
}

export async function handleAuditExport(request: Request, token: string): Promise<Response> {
  const [{ getRuntime }, { auditService }] = await Promise.all([import('../runtime'), import('./runtime')])
  const { sessions } = getRuntime()
  return handleAuditExportWith(request, token, (cookie) => sessions.resolveAccount(cookie, { background: false }) ?? undefined, auditService)
}
