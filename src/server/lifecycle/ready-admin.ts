/**
 * Administrator-session branch of `/api/ready` (SPEC/31 FR-AEX-006): an administrator with a valid, fully signed-in
 * session sees the detail body from any permitted address. Anything else, including a request without a session cookie,
 * gets the fixed body; a request without the cookie causes no session lookup at all.
 */
export type AdminProbe = {
  resolve(cookie: string): { state: string; user: { id: string; role: string } | null } | undefined
  getUser(id: string): { role: string; status: string } | undefined
}

export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim())
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export function isAdministratorRequest(request: Request, cookieName: string, probe: AdminProbe): boolean {
  const cookie = cookieValue(request.headers.get('cookie'), cookieName)
  if (!cookie) return false
  try {
    const ctx = probe.resolve(cookie)
    if (!ctx || ctx.state !== 'full' || !ctx.user || ctx.user.role !== 'admin') return false
    const row = probe.getUser(ctx.user.id)
    return !!row && row.role === 'admin' && row.status === 'active'
  } catch {
    return false
  }
}
