/**
 * OpenAI-compatible chat client (SPEC/34 FR-AST-017). `fetch` only: TLS is verified by the platform, redirects are refused,
 * the address of the endpoint must not be private or loopback unless the operator allowed it, request time and response
 * size are capped, the key is sent in the header and never logged, and no body is ever logged. The request carries what
 * the orchestrator gives it (messages with tokens, tool schemas, the model name): no cookie, session id or credential.
 *
 * An outbound proxy: Node's own `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` applies to `fetch` (docs/deploy.md); there is no
 * proxy setting of DBLoom's own (ST-033 is not built).
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { CidrList, PRIVATE_RANGES } from '../net/cidr'

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string }
export type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type ChatRequest = { model: string; messages: ChatMessage[]; tools: ToolDef[] }
export type ChatResponse = {
  content: string | null
  toolCalls: ToolCall[]
  totalTokens: number
  finishReason: string | null
}

export type AiErrorCode = 'unreachable' | 'timeout' | 'status' | 'too_large' | 'bad_response' | 'blocked_address' | 'aborted'
export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public status?: number,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

/** The private ranges of the server plus "this host", carrier-grade NAT and the unspecified addresses. */
const BLOCKED = new CidrList(['0.0.0.0/8', '100.64.0.0/10', '::/128'])

export function isBlockedAddress(address: string): boolean {
  return PRIVATE_RANGES.contains(address) || BLOCKED.contains(address)
}

export type ClientOptions = {
  baseUrl: string
  apiKey: string | null
  allowPrivate: boolean
  timeoutMs?: number
  maxResponseBytes?: number
  fetchImpl?: typeof fetch
  /** All addresses of a host name; tests replace it. */
  resolve?: (host: string) => Promise<string[]>
}

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const resolveAll = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address)

async function checkAddress(url: URL, allowPrivate: boolean, resolve: (host: string) => Promise<string[]>): Promise<void> {
  if (allowPrivate) return
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (isIP(host)) addresses = [host]
  else {
    try {
      addresses = await resolve(host)
    } catch {
      throw new AiError('unreachable', 'The AI endpoint could not be resolved.')
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new AiError('blocked_address', 'The AI endpoint is on a private or loopback address; the operator has not allowed that.')
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) throw new AiError('too_large', 'The AI response is too large.')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new AiError('too_large', 'The AI response is too large.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

type Wire = { choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[]; usage?: { total_tokens?: unknown } }

function parseCalls(raw: unknown): ToolCall[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new AiError('bad_response', 'The AI response has no usable tool calls.')
  return raw.map((c) => {
    const o = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (typeof o?.id !== 'string' || typeof o.function?.name !== 'string' || typeof o.function.arguments !== 'string') {
      throw new AiError('bad_response', 'The AI response has no usable tool calls.')
    }
    return { id: o.id, type: 'function' as const, function: { name: o.function.name, arguments: o.function.arguments } }
  })
}

export function createAiClient(opts: ClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch
  const resolve = opts.resolve ?? resolveAll
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const endpoint = new URL(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`)

  return {
    async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      await checkAddress(endpoint, opts.allowPrivate, resolve)
      const timeout = AbortSignal.timeout(timeoutMs)
      const both = signal ? AbortSignal.any([signal, timeout]) : timeout
      let res: Response
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: req.model, messages: req.messages, tools: req.tools.length ? req.tools : undefined, stream: false }),
          signal: both,
        })
      } catch (error) {
        if (signal?.aborted) throw new AiError('aborted', 'Stopped.')
        if (timeout.aborted) throw new AiError('timeout', 'The AI service did not answer in time.')
        void error
        throw new AiError('unreachable', 'The AI service could not be reached.')
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new AiError('status', `The AI service answered with status ${res.status}.`, res.status)
      }
      let text: string
      try {
        text = await readCapped(res, maxBytes)
      } catch (error) {
        if (error instanceof AiError) throw error
        if (signal?.aborted) throw new AiError('aborted', 'Stopped.')
        if (timeout.aborted) throw new AiError('timeout', 'The AI service did not answer in time.')
        throw new AiError('unreachable', 'The AI service could not be reached.')
      }
      let wire: Wire
      try {
        wire = JSON.parse(text) as Wire
      } catch {
        throw new AiError('bad_response', 'The AI response is not JSON.')
      }
      const choice = wire.choices?.[0]
      const message = choice?.message
      if (!message) throw new AiError('bad_response', 'The AI response has no message.')
      const content = typeof message.content === 'string' ? message.content : null
      const total = typeof wire.usage?.total_tokens === 'number' ? wire.usage.total_tokens : 0
      return { content, toolCalls: parseCalls(message.tool_calls), totalTokens: total, finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null }
    },
  }
}

export type AiClient = ReturnType<typeof createAiClient>
