import { describe, expect, it } from 'vitest'
import { clientSeenFor, send } from './helpers'

// Direct access to the app port: the peer is the Docker gateway, not a trusted proxy.
describe('direct access to the app port', () => {
  it('ignores forwarded headers from an untrusted peer', async () => {
    const seen = await clientSeenFor('direct', { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' })
    expect(seen).toBeDefined()
    expect(seen).not.toBe('1.2.3.4')
  })

  it('still checks Host and Origin', async () => {
    expect((await send('direct', '/', { host: 'evil.example' })).status).toBe(421)
    expect((await send('direct', '/api/rows/upload', { method: 'POST', body: 'x' })).status).toBe(403)
  })
})
