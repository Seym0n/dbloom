/**
 * Suggestions for the PII markings (SPEC/34 FR-AST-019): columns of a connected target whose names look like personal data.
 * Nothing is applied by this: the administrator picks what to mark. Pure.
 */
import type { CompiledRules } from './pii/rules'
import type { OutlineTable } from './tools'

export const SUGGESTION_REASONS = ['email', 'phone', 'name', 'birth', 'identity', 'finance', 'address', 'network', 'secret'] as const
export type SuggestionReason = (typeof SUGGESTION_REASONS)[number]
export type Suggestion = { db: string; table: string; column: string; reason: SuggestionReason }

const PATTERNS: [SuggestionReason, RegExp][] = [
  ['email', /(^|_)e_?mail(_|$)|^mail$/i],
  ['phone', /(^|_)(phone|mobile|msisdn|telephone|tel|fax)(_|$)/i],
  ['name', /(^|_)(first|last|sur|given|family|middle|full|maiden|nick|user)_?name(_|$)|^(surname|forename|fullname)$/i],
  ['birth', /(^|_)(birth|dob|birthday|birthdate)(_|$)/i],
  ['identity', /(^|_)(ssn|passport|national_?id|tax_?id|vat_?id|id_?number|licen[cs]e_?(no|number)|social_?security)(_|$)/i],
  ['finance', /(^|_)(iban|bic|swift|card_?(no|number)|credit_?card|account_?(no|number)|salary|wage|income)(_|$)/i],
  ['network', /(^|_)(ip|ip_?address|ipv4|ipv6|mac_?address|user_?agent)(_|$)/i],
  ['address', /(^|_)(address|street|postcode|postal_?code|zip(_?code)?|city_?line)(_|$)/i],
  ['secret', /(^|_)(password|passwd|pwd|secret|token|api_?key)(_|$)/i],
]

export const SUGGESTION_LIMIT = 200

export function suggestFromOutline(tables: OutlineTable[], rules: CompiledRules, limit = SUGGESTION_LIMIT): { suggestions: Suggestion[]; more: boolean } {
  const out: Suggestion[] = []
  let more = false
  for (const t of tables) {
    for (const c of t.columns) {
      if (rules.isPiiColumn(t.db, t.table, c.name)) continue // already marked
      const hit = PATTERNS.find(([, re]) => re.test(c.name))
      if (!hit) continue
      if (out.length >= limit) {
        more = true
        continue
      }
      out.push({ db: t.db, table: t.table, column: c.name, reason: hit[0] })
    }
  }
  return { suggestions: out, more }
}
