import en from './en.json'
import authSetup from './auth-setup.json'
import authSignin from './auth-signin.json'
import authAccount from './auth-account.json'
import authConnections from './auth-connections.json'
import audit from './audit.json'
import exposure from './exposure.json'
import settings from './settings.json'

/** One flat catalogue from the base file and the per-module namespace files (auth-*.json). */
const messages = { ...en, ...authSetup, ...authSignin, ...authAccount, ...authConnections, ...audit, ...exposure, ...settings }

export type MessageKey = keyof typeof messages

/** UI strings go through here so a second language is a new file, not a code change (NFR-TGT-160). */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const template: string = messages[key]
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
}

/** For keys built at run time (error codes, strength levels); an unknown key shows the generic text of `fallback`. */
export function tDynamic(key: string, fallback: MessageKey, values?: Record<string, string | number>): string {
  return t(key in messages ? (key as MessageKey) : fallback, values)
}
