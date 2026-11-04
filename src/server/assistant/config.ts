/**
 * Configuration of the assistant (SPEC/34 FR-AST-001, FR-AST-017). The endpoint, the key and the limits come from the
 * environment only (ST-223, ST-224); the switch, the model and the two options are settings (ST-225, FR-AST-004,
 * FR-AST-016). Without an endpoint the assistant is unavailable and nothing is sent anywhere. Messages in `problems` name
 * a variable, never a value, and never the key.
 */
import { readFileSync } from 'node:fs'
import type { ResolvedAuthSettings } from '../auth/types'
import { parseRuleList, type PiiRule } from './pii/rules'

export const AI_MAX_ROWS = { min: 1, max: 200, default: 50 } as const
export const AI_MAX_STEPS = { min: 1, max: 20, default: 8 } as const

export type AssistantEnv = {
  /** Normalised base URL without a trailing slash; null when unset or refused. */
  baseUrl: string | null
  apiKey: string | null
  allowPrivate: boolean
  maxRows: number
  maxSteps: number
  piiColumns: PiiRule[]
  problems: string[]
}

export type AssistantSettings = Pick<ResolvedAuthSettings, 'assistantEnabled' | 'assistantModel' | 'assistantAutoAllowed' | 'assistantHidePiiNames'>

export type Availability =
  | { available: true; model: string; autoAllowed: boolean; hideNames: boolean; maxRows: number; maxSteps: number }
  | { available: false; reason: 'no-endpoint' | 'bad-endpoint' | 'disabled' | 'no-model' }

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? '').trim())

function clampInt(raw: string | undefined, spec: { min: number; max: number; default: number }, name: string, problems: string[]): number {
  if (raw === undefined || raw.trim() === '') return spec.default
  const n = Number(raw.trim())
  if (!Number.isInteger(n)) {
    problems.push(`${name} is not a whole number; ${spec.default} is used`)
    return spec.default
  }
  if (n < spec.min || n > spec.max) {
    problems.push(`${name} is outside ${spec.min} to ${spec.max}; it was limited`)
    return Math.min(spec.max, Math.max(spec.min, n))
  }
  return n
}

function readKey(env: NodeJS.ProcessEnv, read: (path: string) => string, problems: string[]): string | null {
  const direct = env.DBLOOM_AI_API_KEY?.trim()
  const file = env.DBLOOM_AI_API_KEY_FILE?.trim()
  if (direct && file) {
    problems.push('DBLOOM_AI_API_KEY and DBLOOM_AI_API_KEY_FILE are both set; the key file is not read and the key is ignored')
    return null
  }
  if (direct) return direct
  if (!file) return null
  try {
    const text = read(file).trim()
    return text === '' ? null : text
  } catch {
    problems.push('DBLOOM_AI_API_KEY_FILE cannot be read')
    return null
  }
}

function readUrl(raw: string | undefined, allowPrivate: boolean, problems: string[]): string | null {
  const text = raw?.trim()
  if (!text) return null
  let u: URL
  try {
    u = new URL(text)
  } catch {
    problems.push('DBLOOM_AI_BASE_URL is not a URL')
    return null
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowPrivate)) {
    problems.push(u.protocol === 'http:' ? 'DBLOOM_AI_BASE_URL must start with https:// (http:// only with DBLOOM_AI_ALLOW_PRIVATE=true)' : 'DBLOOM_AI_BASE_URL must start with https://')
    return null
  }
  if (u.username || u.password) {
    problems.push('DBLOOM_AI_BASE_URL must not carry a user name or password; use DBLOOM_AI_API_KEY')
    return null
  }
  if (u.search || u.hash) {
    problems.push('DBLOOM_AI_BASE_URL must have no query or fragment')
    return null
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

export function readAssistantEnv(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): AssistantEnv {
  const problems: string[] = []
  const allowPrivate = truthy(env.DBLOOM_AI_ALLOW_PRIVATE)
  const markings = parseRuleList(env.DBLOOM_PII_COLUMNS)
  if (markings.errors.length > 0) problems.push(`DBLOOM_PII_COLUMNS: ${markings.errors.length} entries are not db.table.column and were ignored`)
  return {
    baseUrl: readUrl(env.DBLOOM_AI_BASE_URL, allowPrivate, problems),
    apiKey: readKey(env, read, problems),
    allowPrivate,
    maxRows: clampInt(env.DBLOOM_AI_MAX_ROWS, AI_MAX_ROWS, 'DBLOOM_AI_MAX_ROWS', problems),
    maxSteps: clampInt(env.DBLOOM_AI_MAX_STEPS, AI_MAX_STEPS, 'DBLOOM_AI_MAX_STEPS', problems),
    piiColumns: markings.rules,
    problems,
  }
}

/** Whether the assistant works now. A refused URL is reported as such, not as "no endpoint". */
export function resolveAvailability(e: AssistantEnv, s: AssistantSettings): Availability {
  if (e.baseUrl === null) return { available: false, reason: e.problems.some((p) => p.startsWith('DBLOOM_AI_BASE_URL')) ? 'bad-endpoint' : 'no-endpoint' }
  if (!s.assistantEnabled) return { available: false, reason: 'disabled' }
  if (s.assistantModel.trim() === '') return { available: false, reason: 'no-model' }
  return { available: true, model: s.assistantModel, autoAllowed: s.assistantAutoAllowed, hideNames: s.assistantHidePiiNames, maxRows: e.maxRows, maxSteps: e.maxSteps }
}

/** Auto mode only where the administrators allow it; the server never trusts the mode a request names. */
export const effectiveMode = (requested: 'manual' | 'auto', autoAllowed: boolean): 'manual' | 'auto' => (requested === 'auto' && autoAllowed ? 'auto' : 'manual')

/** What the administrator page may show about the endpoint: the origin and flags, never the key and never a path with secrets. */
export function describeEndpoint(e: AssistantEnv): { configured: boolean; origin: string | null; keySet: boolean; allowPrivate: boolean; problems: string[] } {
  return { configured: e.baseUrl !== null, origin: e.baseUrl ? new URL(e.baseUrl).origin : null, keySet: e.apiKey !== null, allowPrivate: e.allowPrivate, problems: e.problems }
}
