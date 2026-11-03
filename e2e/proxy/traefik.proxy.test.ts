import { describe, expect, it } from 'vitest'
import { clientSeenFor, send } from './helpers'

describe('through Traefik', () => {
  it('serves the app and sets HSTS and the central headers', async () => {
    const r = await send('traefik', '/')
    expect(r.status).toBe(200)
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('redirects http to https', async () => {
    const r = await send('traefikHttp', '/setup')
    expect([301, 302, 307, 308]).toContain(r.status)
    expect(String(r.headers.location)).toMatch(/^https:\/\//)
  })

  it('refuses a forged Host with 421 and an empty body', async () => {
    const r = await send('traefik', '/', { host: 'evil.example' })
    expect(r.status).toBe(421)
    expect(r.body).toBe('')
  })

  it('ignores forged X-Forwarded-Host and Forwarded for the origin', async () => {
    const r = await send('traefik', '/', {
      headers: { 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example;proto=http' },
    })
    expect(r.status).toBe(200)
  })

  it('does not let a client spoof its address (X-Forwarded-For)', async () => {
    const seen = await clientSeenFor('traefik', { 'x-forwarded-for': '1.2.3.4' })
    expect(seen).toBeDefined()
    expect(seen).not.toBe('1.2.3.4')
  })

  it('refuses credential pages when the proxy reports http', async () => {
    const bad = await send('traefik', '/invite', { headers: { 'x-test-force-http': '1' } })
    expect(bad.status).toBe(403)
    const ok = await send('traefik', '/invite')
    expect(ok.status).toBeLessThan(400)
  })

  it('refuses a state-changing request without Origin', async () => {
    const r = await send('traefik', '/api/rows/upload', { method: 'POST', body: 'x' })
    expect(r.status).toBe(403)
  })

  it('refuses a cross-site Origin and answers OPTIONS 405 without CORS headers', async () => {
    const post = await send('traefik', '/api/rows/upload', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: 'x',
    })
    expect(post.status).toBe(403)
    const pre = await send('traefik', '/api/rows/upload', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    expect(pre.status).toBe(405)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('caps request bodies in the proxy (buffering middleware, 4 MiB)', async () => {
    const r = await send('traefik', '/api/rows/upload', {
      method: 'POST',
      headers: { origin: 'https://dbloom.test', 'sec-fetch-site': 'same-origin' },
      body: Buffer.alloc(5 * 1024 * 1024, 'a'),
    })
    expect(r.status).toBe(413)
  })

  it('does not answer probes for public peers', async () => {
    const r = await send('traefik', '/api/health')
    expect(r.status).toBe(404)
  })
})
