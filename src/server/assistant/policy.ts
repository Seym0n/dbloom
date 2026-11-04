/**
 * What may run, what must ask and what is refused (SPEC/34 FR-AST-004, FR-AST-009, FR-AST-011). Pure.
 *
 * - Not a read, INSERT or UPDATE the guard accepts: refused, the user can open it in an SQL tab (`user-only`).
 * - An inference violation: refused in both modes (`inference`).
 * - A write: always asks, also in auto mode.
 * - A read: asks in manual mode, runs in auto mode (when auto is allowed and the user chose it).
 * - A read the parser could not analyse: asks in manual mode (the model then gets metadata only), refused in auto mode.
 */
import type { AssistantInspect } from '../sql/assistant'
import { effectiveMode } from './config'
import type { Analysis } from './pii/taint'

export type RefusalCode = 'user-only' | 'inference' | 'unanalysable' | 'token' | 'audit' | 'limit' | 'unknown-tool' | 'bad-arguments'

export type Decision =
  | { action: 'run' }
  | { action: 'ask'; metadataOnly?: boolean }
  | { action: 'refuse'; code: RefusalCode; detail?: string }

export function decide(input: { inspect: AssistantInspect; analysis: Analysis; mode: 'manual' | 'auto'; autoAllowed: boolean }): Decision {
  const { inspect, analysis } = input
  if (!inspect.ok) return { action: 'refuse', code: 'user-only', detail: inspect.reason }
  if (analysis.kind !== 'unsupported' && analysis.violations.length > 0) return { action: 'refuse', code: 'inference', detail: analysis.violations[0]!.detail }
  const auto = effectiveMode(input.mode, input.autoAllowed) === 'auto'
  if (inspect.access === 'write') {
    if (analysis.kind !== 'write') return { action: 'refuse', code: 'unanalysable', detail: analysis.kind === 'unsupported' ? analysis.reason : 'not a write' }
    return { action: 'ask' }
  }
  if (analysis.kind === 'unsupported') {
    if (auto) return { action: 'refuse', code: 'unanalysable', detail: analysis.reason }
    return { action: 'ask', metadataOnly: true }
  }
  if (analysis.kind !== 'query') return { action: 'refuse', code: 'unanalysable', detail: 'not a query' }
  return auto ? { action: 'run' } : { action: 'ask' }
}

/** Fixed texts for the model and the user; the model's own text and the database's text are never echoed. */
export const REFUSAL_TEXT: Record<RefusalCode, string> = {
  'user-only': 'This statement cannot be run by the assistant. Only one SELECT, INSERT or UPDATE (with a restricting WHERE) per call is allowed; the user can run anything else in an SQL tab.',
  inference: 'This statement uses a column with personal data in a way that could reveal its values (a comparison other than equality with a token, a function or a range). Rewrite it without that, or ask the user to run it in an SQL tab.',
  unanalysable: 'This statement could not be checked against the privacy rules, so it was not run. Use a simpler statement.',
  token: 'The statement contains a value token that does not belong to this conversation or is not a whole value. Use tokens exactly as given, as a complete string literal.',
  audit: 'The action could not be recorded, so it was not run.',
  limit: 'A limit of this conversation was reached.',
  'unknown-tool': 'There is no such tool.',
  'bad-arguments': 'The tool arguments are not valid.',
}
