import { describe, expect, it } from 'vitest'
import { bodyCapOf, checkBodyLimit } from '~/server/http/limits'
import { evaluateGate } from '~/server/net/gate'
import { cfg, req } from './gate-fixtures'

const limits = { functionBodyKiB: 1024, otherBodyKiB: 64 }

describe('body caps by route class', () => {
  it('functions 1 MiB, others 64 KiB, uploads own', () => {
    expect(bodyCapOf('/_serverFn/a.b', limits)).toEqual({ bytes: 1024 * 1024 })
    expect(bodyCapOf('/api/startup', limits)).toEqual({ bytes: 64 * 1024 })
    expect(bodyCapOf('/', limits)).toEqual({ bytes: 64 * 1024 })
    expect(bodyCapOf('/api/io/upload', limits)).toBe('own')
    expect(bodyCapOf('/api/rows/upload', limits)).toBe('own')
  })
  it('declared length over the cap is refused, at the cap passes', () => {
    const h = (n: string) => new Headers({ 'content-length': n })
    expect(checkBodyLimit('/api/x', h(String(64 * 1024)), limits)).toBe(false)
    expect(checkBodyLimit('/api/x', h(String(64 * 1024 + 1)), limits)).toBe(true)
    expect(checkBodyLimit('/_serverFn/a.b', h(String(1024 * 1024 + 1)), limits)).toBe(true)
    expect(checkBodyLimit('/_serverFn/a.b', h('1000'), limits)).toBe(false)
  })
  it('garbage length and chunked bodies on capped routes are refused; no body passes', () => {
    expect(checkBodyLimit('/api/x', new Headers({ 'content-length': 'abc' }), limits)).toBe(true)
    expect(checkBodyLimit('/api/x', new Headers({ 'transfer-encoding': 'chunked' }), limits)).toBe(true)
    expect(checkBodyLimit('/api/x', new Headers(), limits)).toBe(false)
  })
  it('upload routes are never capped by the gate', () => {
    const big = new Headers({ 'content-length': String(5 * 1024 ** 3) })
    expect(checkBodyLimit('/api/io/upload', big, limits)).toBe(false)
    expect(checkBodyLimit('/api/io/upload', new Headers({ 'transfer-encoding': 'chunked' }), limits)).toBe(false)
  })
})

describe('gate: 413', () => {
  const c = cfg({ limits })
  const post = (pathname: string, length: number) =>
    evaluateGate(
      req({ method: 'POST', pathname, headers: { 'content-length': String(length), origin: 'https://db.example.org', 'sec-fetch-site': 'same-origin' } }),
      c,
    )
  it('over-limit body is 413 with the fixed body', () => {
    expect(post('/api/startup', 65 * 1024)).toMatchObject({ ok: false, status: 413, body: 'payload_too_large', reason: 'body' })
    expect(post('/_serverFn/a.b', 2 * 1024 * 1024)).toMatchObject({ ok: false, status: 413 })
  })
  it('within limit passes; forged Host still 421 first', () => {
    expect(post('/api/startup', 10).ok).toBe(true)
    expect(evaluateGate(req({ method: 'POST', headers: { host: 'evil.example', 'content-length': '999999' } }), c)).toMatchObject({ status: 421 })
  })
})
