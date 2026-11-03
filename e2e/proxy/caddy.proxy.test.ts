import { describe, expect, it } from 'vitest'
import { clientSeenFor, send } from './helpers'

// Caddy runs the header and forwarding subset (Q7).
describe('through Caddy', () => {
  it('serves the app with HSTS', async () => {
    const r = await send('caddy', '/')
    expect(r.status).toBe(200)
    expect(r.headers['strict-transport-security']).toContain('max-age=')
  })

  it('refuses a forged Host with 421', async () => {
    expect((await send('caddy', '/', { host: 'evil.example' })).status).toBe(421)
  })

  it('does not let a client spoof its address', async () => {
    const seen = await clientSeenFor('caddy', { 'x-forwarded-for': '1.2.3.4' })
    expect(seen).toBeDefined()
    expect(seen).not.toBe('1.2.3.4')
  })

  it('refuses a state-changing request without Origin', async () => {
    expect((await send('caddy', '/api/rows/upload', { method: 'POST', body: 'x' })).status).toBe(403)
  })
})
