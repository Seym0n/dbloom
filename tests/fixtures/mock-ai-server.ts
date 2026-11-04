/**
 * A mock OpenAI-compatible server for the assistant tests (SPEC/34 task 3). It answers `POST /v1/chat/completions` from a
 * script and records every request body exactly as received, so a test can scan what would have left the machine.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockToolCall = { name: string; arguments: Record<string, unknown> | string }
export type MockReply = { content?: string | null; toolCalls?: MockToolCall[]; tokens?: number; status?: number; raw?: string; delayMs?: number; redirectTo?: string; huge?: number }
export type Recorded = { url: string; headers: Record<string, string>; body: string }
export type MockAi = {
  baseUrl: string
  requests: Recorded[]
  /** Queue replies in order; when the queue is empty the next request gets a plain text answer. */
  script(...replies: (MockReply | ((body: { messages: { role: string; content: unknown }[]; tools?: unknown[] }) => MockReply))[]): void
  close(): Promise<void>
}

export async function startMockAi(): Promise<MockAi> {
  const requests: Recorded[] = []
  const queue: (MockReply | ((body: never) => MockReply))[] = []
  let n = 0
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : (v ?? '')
      requests.push({ url: req.url ?? '', headers, body })
      const next = queue.shift()
      let reply: MockReply = {}
      if (typeof next === 'function') {
        try {
          reply = next(JSON.parse(body) as never)
        } catch {
          reply = { content: 'mock script error' }
        }
      } else if (next) reply = next
      else reply = { content: 'Nothing scripted.' }
      const send = () => {
        if (reply.redirectTo) {
          res.writeHead(302, { location: reply.redirectTo })
          res.end()
          return
        }
        if (reply.status && reply.status !== 200) {
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'mock failure' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        if (reply.raw !== undefined) {
          res.end(reply.raw)
          return
        }
        if (reply.huge) {
          res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(reply.huge) }, finish_reason: 'stop' }] }))
          return
        }
        const toolCalls = (reply.toolCalls ?? []).map((c) => ({
          id: `call_${++n}`,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) },
        }))
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: reply.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
            usage: { total_tokens: reply.tokens ?? 10 },
          }),
        )
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs)
      else send()
    })
  }
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script: (...replies) => void queue.push(...(replies as (MockReply | ((body: never) => MockReply))[])),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
