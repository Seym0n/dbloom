import { describe, expect, it, vi } from 'vitest'
import { cookieValue, isAdministratorRequest, type AdminProbe } from '../src/server/lifecycle/ready-admin'

const NAME = '__Host-dbloom-session'
const req = (cookie?: string) => new Request('http://localhost/api/ready', { headers: cookie === undefined ? {} : { cookie } })

const probe = (ctx: ReturnType<AdminProbe['resolve']>, row?: { role: string; status: string }): AdminProbe & { resolve: ReturnType<typeof vi.fn> } => ({
  resolve: vi.fn(() => ctx),
  getUser: () => row,
})
const admin = { state: 'full', user: { id: 'a1', role: 'admin' } }

describe('administrator branch of /api/ready', () => {
  it('an administrator session gets the detail', () => {
    expect(isAdministratorRequest(req(`${NAME}=tok`), NAME, probe(admin, { role: 'admin', status: 'active' }))).toBe(true)
  })

  it.each([
    ['ordinary user', { state: 'full', user: { id: 'u1', role: 'user' } }, { role: 'user', status: 'active' }],
    ['administrator not fully signed in', { state: 'pending_mfa', user: { id: 'a1', role: 'admin' } }, { role: 'admin', status: 'active' }],
    ['session without a user', { state: 'full', user: null }, undefined],
    ['administrator disabled since', admin, { role: 'admin', status: 'disabled' }],
    ['administrator demoted since', admin, { role: 'user', status: 'active' }],
    ['user row gone', admin, undefined],
  ])('no detail for: %s', (_n, ctx, row) => {
    expect(isAdministratorRequest(req(`${NAME}=tok`), NAME, probe(ctx, row))).toBe(false)
  })

  it('an unknown or expired session gets no detail', () => {
    expect(isAdministratorRequest(req(`${NAME}=tok`), NAME, probe(undefined))).toBe(false)
  })

  it('no cookie, a cookie of another name, or an empty value: no session lookup at all', () => {
    for (const cookie of [undefined, '', 'theme=dark', `other${NAME}=x`, `${NAME}=`]) {
      const p = probe(admin, { role: 'admin', status: 'active' })
      expect(isAdministratorRequest(req(cookie), NAME, p), String(cookie)).toBe(false)
      expect(p.resolve).not.toHaveBeenCalled()
    }
  })

  it('a failing lookup is not an administrator', () => {
    const p: AdminProbe = { resolve: () => { throw new Error('store locked') }, getUser: () => undefined }
    expect(isAdministratorRequest(req(`${NAME}=tok`), NAME, p)).toBe(false)
  })

  it('finds the cookie among others and decodes it; a broken escape is ignored', () => {
    expect(cookieValue(`a=1; ${NAME}=ab%2Fc; z=2`, NAME)).toBe('ab/c')
    expect(cookieValue(`${NAME}=%E0%A4%A`, NAME)).toBeUndefined()
    expect(cookieValue(null, NAME)).toBeUndefined()
  })
})
