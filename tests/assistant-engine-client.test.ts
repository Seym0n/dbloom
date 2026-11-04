import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiError, createAiClient, isBlockedAddress, type ChatRequest } from '~/server/assistant/client'
import { startMockAi, type MockAi } from './fixtures/mock-ai-server'

// SPEC/34 FR-AST-017: the OpenAI-compatible client against a mock server.

let ai: MockAi
beforeAll(async () => {
  ai = await startMockAi()
})
afterAll(async () => ai.close())

const REQ: ChatRequest = { model: 'm-1', messages: [{ role: 'user', content: 'hello' }], tools: [] }
const client = (over: Partial<Parameters<typeof createAiClient>[0]> = {}) =>
  createAiClient({ baseUrl: ai.baseUrl, apiKey: 'sk-test-key', allowPrivate: true, ...over })
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof AiError ? e.code : `other: ${String(e)}`
  }
}

describe('a normal exchange', () => {
  it('sends the model, the messages and the key in the header; parses text, tool calls and tokens', async () => {
    ai.requests.length = 0
    ai.script({ content: 'Hi', tokens: 42 }, { toolCalls: [{ name: 'run_query', arguments: { sql: 'SELECT 1' } }] })
    const first = await client().chat(REQ)
    expect(first).toMatchObject({ content: 'Hi', toolCalls: [], totalTokens: 42, finishReason: 'stop' })
    const second = await client().chat({ ...REQ, tools: [{ type: 'function', function: { name: 'run_query', description: 'd', parameters: { type: 'object' } } }] })
    expect(second.toolCalls).toHaveLength(1)
    expect(second.toolCalls[0]!.function).toEqual({ name: 'run_query', arguments: '{"sql":"SELECT 1"}' })
    const sent = ai.requests.at(-2)!
    expect(sent.url).toBe('/v1/chat/completions')
    expect(sent.headers.authorization).toBe('Bearer sk-test-key')
    expect(JSON.parse(sent.body)).toEqual({ model: 'm-1', messages: REQ.messages, stream: false })
    expect(sent.headers.cookie).toBeUndefined()
  })

  it('without a key no authorization header is sent', async () => {
    ai.requests.length = 0
    ai.script({ content: 'ok' })
    await client({ apiKey: null }).chat(REQ)
    expect(ai.requests[0]!.headers.authorization).toBeUndefined()
  })
})

describe('failures are classified and never carry the key or the body', () => {
  it('a non-success status, a redirect, a bad body, a response without message, bad tool calls', async () => {
    ai.script({ status: 429 })
    const e = (await client().chat(REQ).catch((x: unknown) => x)) as AiError
    expect(e).toBeInstanceOf(AiError)
    expect(e).toMatchObject({ code: 'status', status: 429 })
    expect(String(e.message)).not.toContain('sk-test-key')
    ai.script({ redirectTo: 'http://127.0.0.1:1/elsewhere' })
    expect(await code(client().chat(REQ))).toBe('unreachable')
    ai.script({ raw: 'not json' })
    expect(await code(client().chat(REQ))).toBe('bad_response')
    ai.script({ raw: '{"choices":[]}' })
    expect(await code(client().chat(REQ))).toBe('bad_response')
    ai.script({ raw: '{"choices":[{"message":{"content":null,"tool_calls":[{"id":1}]}}]}' })
    expect(await code(client().chat(REQ))).toBe('bad_response')
  })

  it('a response over the cap is refused, whether announced or streamed', async () => {
    ai.script({ huge: 5000 })
    expect(await code(client({ maxResponseBytes: 1000 }).chat(REQ))).toBe('too_large')
    ai.script({ huge: 5000 })
    expect(await code(client({ maxResponseBytes: 100_000 }).chat(REQ))).toBe('no error')
  })

  it('a slow answer times out and a stop aborts at once', async () => {
    ai.script({ content: 'late', delayMs: 400 })
    expect(await code(client({ timeoutMs: 100 }).chat(REQ))).toBe('timeout')
    ai.script({ content: 'late', delayMs: 400 })
    const stop = new AbortController()
    const p = client().chat(REQ, stop.signal)
    setTimeout(() => stop.abort(), 50)
    expect(await code(p)).toBe('aborted')
  })

  it('an unreachable host is an unreachable error', async () => {
    expect(await code(createAiClient({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: null, allowPrivate: true }).chat(REQ))).toBe('unreachable')
  })
})

describe('addresses: private and loopback are refused unless the operator allowed them', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])('blocks %s', (a) => {
    expect(isBlockedAddress(a)).toBe(true)
  })
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('allows %s', (a) => {
    expect(isBlockedAddress(a)).toBe(false)
  })

  it('a literal private address, a name that resolves to one, or to a mix is refused; a public one passes the check', async () => {
    const make = (baseUrl: string, resolve?: (h: string) => Promise<string[]>) => createAiClient({ baseUrl, apiKey: null, allowPrivate: false, ...(resolve ? { resolve } : {}), fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))) as typeof fetch })
    expect(await code(make('https://127.0.0.1/v1').chat(REQ))).toBe('blocked_address')
    expect(await code(make('https://[::1]/v1').chat(REQ))).toBe('blocked_address')
    expect(await code(make('https://ai.internal/v1', async () => ['10.0.0.5']).chat(REQ))).toBe('blocked_address')
    expect(await code(make('https://ai.example.com/v1', async () => ['93.184.216.34', '192.168.0.9']).chat(REQ))).toBe('blocked_address')
    expect(await code(make('https://ai.example.com/v1', async () => []).chat(REQ))).toBe('blocked_address')
    expect(await code(make('https://ai.example.com/v1', async () => { throw new Error('nx') }).chat(REQ))).toBe('unreachable')
    expect(await code(make('https://ai.example.com/v1', async () => ['93.184.216.34']).chat(REQ))).toBe('no error')
  })

  it('the refusal happens before any request is made', async () => {
    let called = false
    const c = createAiClient({ baseUrl: 'https://10.0.0.1/v1', apiKey: 'k', allowPrivate: false, fetchImpl: (async () => { called = true; return new Response('{}') }) as typeof fetch })
    expect(await code(c.chat(REQ))).toBe('blocked_address')
    expect(called).toBe(false)
  })
})
