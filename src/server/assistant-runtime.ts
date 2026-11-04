/**
 * Runtime wiring of the assistant (SPEC/34): the service of this process with the real settings, store, audit and SQL
 * environment. Server only; kept out of `assistant.functions.ts` so the client build does not pull the runtime in.
 */
import { audit, auditRegistered, auditRequired } from './audit'
import { createApprovalStore, createRateLimiter } from './assistant/approval'
import { createAiClient } from './assistant/client'
import { readAssistantEnv, type AssistantEnv } from './assistant/config'
import { assistantSessionOf, createAssistantService, type AssistantService, type AssistantSession } from './assistant/service'
import { informationSchemaSource } from './assistant/schema-source'
import { getRuntime } from './runtime'
import { envOf } from './sql/service'
import { isStateless, ownerKeyFor } from './sql/state'
import type { LiveSession } from './sessions'

let envCache: AssistantEnv | undefined
/** The environment is read once per process: the key file is not read again on every call. */
export const assistantEnv = (): AssistantEnv => (envCache ??= readAssistantEnv())

/** Test hook. */
export function resetAssistantRuntime(): void {
  envCache = undefined
  service = undefined
}

let service: AssistantService | undefined

/** Audit fields are plain values: a list becomes a comma list, a missing value is left out. */
export function flatFields(fields: Record<string, unknown>): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue
    out[k] = Array.isArray(v) ? v.map(String).join(',') : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
  }
  return out
}
export function assistantService(): AssistantService {
  if (service) return service
  const runtime = getRuntime()
  service = createAssistantService({
    env: assistantEnv,
    settings: () => runtime.settings(),
    store: () => (isStateless() ? undefined : runtime.store.assistant),
    schema: informationSchemaSource,
    sqlEnv: (s, signal) => envOf({ idHash: s.scopeKey, csrf: '', target: s.target, pool: s.pool, readOnly: s.readOnly, ownerKey: s.ownerKey } as LiveSession, signal),
    createClient: (env) => {
      if (!env.baseUrl) throw new Error('no endpoint')
      return createAiClient({ baseUrl: env.baseUrl, apiKey: env.apiKey, allowPrivate: env.allowPrivate })
    },
    // A required row where the table sink exists (stateful modes); stateless mode keeps the stdout and file sinks only.
    audit: (event, fields) => {
      const flat = flatFields(fields)
      if (auditRegistered()) auditRequired(event, flat)
      else audit(event, flat)
    },
    approvals: createApprovalStore(),
    rateLimit: createRateLimiter(20, 10 * 60_000),
  })
  return service
}

/** The caller of a server function as the service sees it. */
export function assistantSessionFor(session: Parameters<typeof assistantSessionOf>[0] & LiveSession): AssistantSession {
  return assistantSessionOf(session, ownerKeyFor(session))
}
