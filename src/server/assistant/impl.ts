/**
 * Input checks and the plain functions behind the assistant server functions (SPEC/34). Server only.
 * The server functions themselves are in `../assistant.functions.ts`.
 */
import { z } from 'zod'
import { StructureRefusal, toClientError } from '../structure/errors'
import { assistantService, assistantSessionFor } from '../assistant-runtime'
import { getRuntime } from '../runtime'
import type { LiveSession } from '../sessions'
import type { Opened, Poll, Status, Summary } from './service'
import { MESSAGE_MAX } from './service'

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

export const idInput = z.object({ id }).strict()
export const sendInput = z.object({ id, text: z.string().min(1).max(MESSAGE_MAX) }).strict()
export const pollInput = z.object({ id, after: z.number().int().min(0).max(10_000_000) }).strict()
export const resolveInput = z.object({ id, callId: z.string().min(1).max(64), decision: z.enum(['approve', 'deny']) }).strict()
export const modeInput = z.object({ id, mode: z.enum(['manual', 'auto']) }).strict()
export const renameInput = z.object({ id, title: z.string().min(1).max(200) }).strict()

export type IdInput = z.infer<typeof idInput>
export type SendInput = z.infer<typeof sendInput>
export type PollInput = z.infer<typeof pollInput>
export type ResolveInput = z.infer<typeof resolveInput>
export type ModeInput = z.infer<typeof modeInput>
export type RenameInput = z.infer<typeof renameInput>

export const parseId = (raw: unknown): IdInput => idInput.parse(raw)
export const parseSend = (raw: unknown): SendInput => sendInput.parse(raw)
export const parsePoll = (raw: unknown): PollInput => pollInput.parse(raw)
export const parseResolve = (raw: unknown): ResolveInput => resolveInput.parse(raw)
export const parseMode = (raw: unknown): ModeInput => modeInput.parse(raw)
export const parseRename = (raw: unknown): RenameInput => renameInput.parse(raw)

type Caller = Parameters<typeof assistantSessionFor>[0]

/** Refusals become the `code: message` form the client reads. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof StructureRefusal) throw toClientError(error)
    throw toClientError(error)
  }
}

export const statusImpl = (s: Caller): Promise<Status> => guarded(() => assistantService().status(assistantSessionFor(s)))
export const listImpl = (s: Caller): Promise<Summary[]> => guarded(() => assistantService().list(assistantSessionFor(s)))
export const createImpl = (s: Caller): Promise<Summary> => guarded(() => assistantService().create(assistantSessionFor(s)))
export const openImpl = (s: Caller, d: IdInput): Promise<Opened> => guarded(() => assistantService().open(assistantSessionFor(s), d.id))
export const sendImpl = (s: Caller, d: SendInput): Promise<{ next: number }> => guarded(() => assistantService().send(assistantSessionFor(s), d.id, d.text))
export const pollImpl = (s: Caller, d: PollInput): Promise<Poll> => guarded(() => assistantService().poll(assistantSessionFor(s), d.id, d.after))
export const resolveImpl = (s: Caller, d: ResolveInput): Promise<{ next: number }> => guarded(() => assistantService().resolve(assistantSessionFor(s), d.id, d.callId, d.decision))
export const modeImpl = (s: Caller, d: ModeInput): Promise<{ mode: 'manual' | 'auto' }> => guarded(() => assistantService().setMode(assistantSessionFor(s), d.id, d.mode))
export const stopImpl = (s: Caller, d: IdInput): Promise<{ next: number }> => guarded(() => assistantService().stop(assistantSessionFor(s), d.id))
export const renameImpl = (s: Caller, d: RenameInput): Promise<Summary> => guarded(() => assistantService().rename(assistantSessionFor(s), d.id, d.title))
/** Suggestions for the markings: administrators only, from the connection the call is made on. */
export const suggestImpl = (s: Caller) =>
  guarded(() => {
    const sess = assistantSessionFor(s)
    const user = sess.userId ? getRuntime().store.accounts.getUser(sess.userId) : undefined
    if (!user || user.role !== 'admin' || user.status !== 'active') throw new StructureRefusal('assistant_forbidden', 'Only administrators can do this.')
    return assistantService().suggest(sess)
  })
export const deleteImpl = (s: Caller, d: IdInput): Promise<{ ok: true }> => guarded(() => assistantService().delete(assistantSessionFor(s), d.id))

export type { Caller as AssistantCaller, LiveSession }
