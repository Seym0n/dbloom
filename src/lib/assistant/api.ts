/**
 * The only place the assistant sidebar gets server data from (SPEC/34 task 5). Three implementations, like the auth API:
 *  - real: dynamic import of `assistant.functions.ts` (so the mock path never loads it);
 *  - mock (`mock-api.ts`): in memory, selected by the auth mock switch (`?authMock=...`);
 *  - a test fake installed with `setAssistantApi`.
 * Failures are `Error`s whose message is `code: text` (StructureRefusal form); read them with `assistantErrorText`.
 */
import { isAuthMock } from '~/lib/auth/api'
import type { Opened, Poll, Status, Summary } from '~/server/assistant/service'
import type { AssistantMode } from '~/server/assistant/store'
import { createMockAssistantApi } from './mock-api'

export type { Opened, Poll, Status, Summary }
export type { AssistantMode }

export type AssistantApi = {
  status(): Promise<Status>
  list(): Promise<Summary[]>
  create(): Promise<Summary>
  open(id: string): Promise<Opened>
  send(id: string, text: string): Promise<{ next: number }>
  poll(id: string, after: number): Promise<Poll>
  resolve(id: string, callId: string, decision: 'approve' | 'deny'): Promise<{ next: number }>
  setMode(id: string, mode: AssistantMode): Promise<{ mode: AssistantMode }>
  stop(id: string): Promise<{ next: number }>
  rename(id: string, title: string): Promise<Summary>
  remove(id: string): Promise<{ ok: true }>
}

type Mod = Record<string, unknown>
type Fn = (arg?: { data: unknown }) => Promise<unknown>
const load = () => import('~/server/assistant.functions') as Promise<Mod>

async function call<T>(name: string, data?: unknown): Promise<T> {
  const fn = (await load())[name] as Fn | undefined
  if (typeof fn !== 'function') throw new Error(`unavailable: ${name}`)
  return (data === undefined ? fn() : fn({ data })) as Promise<T>
}

export function createServerAssistantApi(): AssistantApi {
  return {
    status: () => call('getAssistantStatus'),
    list: () => call('listAssistantConversations'),
    create: () => call('createAssistantConversation'),
    open: (id) => call('openAssistantConversation', { id }),
    send: (id, text) => call('sendAssistantMessage', { id, text }),
    poll: (id, after) => call('pollAssistantTurn', { id, after }),
    resolve: (id, callId, decision) => call('resolveAssistantCall', { id, callId, decision }),
    setMode: (id, mode) => call('setAssistantMode', { id, mode }),
    stop: (id) => call('stopAssistantTurn', { id }),
    rename: (id, title) => call('renameAssistantConversation', { id, title }),
    remove: (id) => call('deleteAssistantConversation', { id }),
  }
}

let override: AssistantApi | undefined
let real: AssistantApi | undefined
let mock: AssistantApi | undefined

/** Tests install a fake; `undefined` goes back to the selection by flag. */
export function setAssistantApi(api: AssistantApi | undefined): void {
  override = api
}

export function assistantApi(): AssistantApi {
  if (override) return override
  if (isAuthMock()) return (mock ??= createMockAssistantApi())
  return (real ??= createServerAssistantApi())
}

/** `code: text` of a refusal, or a generic text. The code decides the message shown; the text of the server is not shown as is. */
export function assistantErrorCode(error: unknown): string {
  const m = error instanceof Error ? error.message : ''
  const code = /^([a-z_]+)(?:@\d+)?: /.exec(m)?.[1]
  return code ?? 'unexpected'
}
