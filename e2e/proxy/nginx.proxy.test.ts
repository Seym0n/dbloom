import { describe, expect, it } from 'vitest'
import { clientSeenFor, send } from './helpers'

// nginx runs the header, forwarding and limit subset with the reference config in deploy/proxy/nginx/default.conf.
describe('through nginx', () => {
  it('serves the app with HSTS from the app', async () => {
    const r = await send('nginx', '/')
    expect(r.status).toBe(200)
    expect(r.headers['strict-transport-security']).toContain('max-age=')
  })

  it('refuses a forged Host with 421', async () => {
    expect((await send('nginx', '/', { host: 'evil.example' })).status).toBe(421)
  })

  it('does not let a client spoof its address', async () => {
    const seen = await clientSeenFor('nginx', { 'x-forwarded-for': '1.2.3.4' })
    expect(seen).toBeDefined()
    expect(seen).not.toBe('1.2.3.4')
  })

  it('refuses a state-changing request without Origin', async () => {
    expect((await send('nginx', '/api/rows/upload', { method: 'POST', body: 'x' })).status).toBe(403)
  })

  it('caps request bodies in the proxy (client_max_body_size 4m)', async () => {
    const r = await send('nginx', '/api/rows/upload', {
      method: 'POST',
      headers: { origin: 'https://dbloom.test', 'sec-fetch-site': 'same-origin' },
      body: Buffer.alloc(5 * 1024 * 1024, 'a'),
    })
    expect(r.status).toBe(413)
  })
})
