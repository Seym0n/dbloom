import { createServerFn } from '@tanstack/react-start'
import { sessionMiddleware } from './middleware'
import {
  createImpl,
  deleteImpl,
  listImpl,
  modeImpl,
  openImpl,
  parseId,
  parseMode,
  parsePoll,
  parseRename,
  parseResolve,
  parseSend,
  pollImpl,
  renameImpl,
  resolveImpl,
  sendImpl,
  statusImpl,
  stopImpl,
  suggestImpl,
  type IdInput,
  type ModeInput,
  type PollInput,
  type RenameInput,
  type ResolveInput,
  type SendInput,
} from './assistant/impl'
import type { Suggestion } from './assistant/suggest'
import type { Opened, Poll, Status, Summary } from './assistant/service'

// Only server functions live here; logic is in assistant/service.ts and assistant/impl.ts. Every export calls createServerFn
// directly: the TanStack compiler only strips handlers (and their node-only imports) from the client bundle when it can see that call.

export const getAssistantStatus = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<Status> => statusImpl(context.session))

export const listAssistantConversations = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<Summary[]> => listImpl(context.session))

export const createAssistantConversation = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<Summary> => createImpl(context.session))

export const openAssistantConversation = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: IdInput) => parseId(raw))
  .handler(({ context, data }): Promise<Opened> => openImpl(context.session, data))

export const sendAssistantMessage = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: SendInput) => parseSend(raw))
  .handler(({ context, data }): Promise<{ next: number }> => sendImpl(context.session, data))

export const pollAssistantTurn = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: PollInput) => parsePoll(raw))
  .handler(({ context, data }): Promise<Poll> => pollImpl(context.session, data))

export const resolveAssistantCall = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ResolveInput) => parseResolve(raw))
  .handler(({ context, data }): Promise<{ next: number }> => resolveImpl(context.session, data))

export const setAssistantMode = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ModeInput) => parseMode(raw))
  .handler(({ context, data }): Promise<{ mode: 'manual' | 'auto' }> => modeImpl(context.session, data))

export const stopAssistantTurn = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: IdInput) => parseId(raw))
  .handler(({ context, data }): Promise<{ next: number }> => stopImpl(context.session, data))

export const renameAssistantConversation = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: RenameInput) => parseRename(raw))
  .handler(({ context, data }): Promise<Summary> => renameImpl(context.session, data))

export const deleteAssistantConversation = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: IdInput) => parseId(raw))
  .handler(({ context, data }): Promise<{ ok: true }> => deleteImpl(context.session, data))

export const suggestPiiColumns = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<{ suggestions: Suggestion[]; more: boolean }> => suggestImpl(context.session))
