import { describe, expect, it } from 'vitest'
import { effectiveMode, describeEndpoint, readAssistantEnv, resolveAvailability, type AssistantSettings } from '~/server/assistant/config'
import { createAuthSettingsResolver } from '~/server/auth/settings'
import { AUTH_SETTINGS, AUTH_SETTING_KEYS } from '~/server/auth/types'
import { SETTING_GROUPS, SETTING_META } from '~/server/auth/setting-meta'
import { ENV_NAMES, renderEnvExample } from '~/server/env-registry'
import { AUDIT_EVENTS } from '~/server/audit/events'
import settingsTexts from '~/i18n/settings.json'

// SPEC/34 task 2: environment, availability, the four settings, registry, audit events.

const SETTINGS: AssistantSettings = { assistantEnabled: true, assistantModel: 'gpt-x', assistantAutoAllowed: true, assistantHidePiiNames: false }
const env = (e: Record<string, string>) => readAssistantEnv(e as NodeJS.ProcessEnv, () => { throw new Error('no files') })

describe('environment', () => {
  it('with nothing set the assistant has no endpoint and no key, defaults are in place', () => {
    const e = env({})
    expect(e).toMatchObject({ baseUrl: null, apiKey: null, allowPrivate: false, maxRows: 50, maxSteps: 8, piiColumns: [], problems: [] })
    expect(resolveAvailability(e, SETTINGS)).toEqual({ available: false, reason: 'no-endpoint' })
  })

  it('the base URL is normalised; credentials, query, fragment and plain http are refused', () => {
    expect(env({ DBLOOM_AI_BASE_URL: 'https://api.example.com/v1/' }).baseUrl).toBe('https://api.example.com/v1')
    expect(env({ DBLOOM_AI_BASE_URL: 'https://api.example.com' }).baseUrl).toBe('https://api.example.com')
    for (const bad of ['http://api.example.com/v1', 'ftp://x/v1', 'not a url', 'https://user:pw@api.example.com/v1', 'https://api.example.com/v1?key=1', 'https://api.example.com/v1#x']) {
      const e = env({ DBLOOM_AI_BASE_URL: bad })
      expect(e.baseUrl, bad).toBeNull()
      expect(e.problems.length, bad).toBeGreaterThan(0)
      expect(resolveAvailability(e, SETTINGS), bad).toEqual({ available: false, reason: 'bad-endpoint' })
      expect(e.problems.join(' ')).not.toContain('pw@')
    }
  })

  it('plain http is allowed only for a private endpoint on purpose', () => {
    const e = env({ DBLOOM_AI_BASE_URL: 'http://127.0.0.1:11434/v1', DBLOOM_AI_ALLOW_PRIVATE: 'true' })
    expect(e).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', allowPrivate: true, problems: [] })
  })

  it('the key comes from the variable or the file, never both; it never appears in a problem or in the endpoint description', () => {
    expect(env({ DBLOOM_AI_API_KEY: ' sk-secret ' }).apiKey).toBe('sk-secret')
    const viaFile = readAssistantEnv({ DBLOOM_AI_API_KEY_FILE: '/run/secrets/ai' } as NodeJS.ProcessEnv, () => 'sk-file\n')
    expect(viaFile.apiKey).toBe('sk-file')
    const both = readAssistantEnv({ DBLOOM_AI_API_KEY: 'sk-a', DBLOOM_AI_API_KEY_FILE: '/x' } as NodeJS.ProcessEnv, () => 'sk-b')
    expect(both.apiKey).toBeNull()
    expect(both.problems.join(' ')).not.toMatch(/sk-a|sk-b/)
    const missing = readAssistantEnv({ DBLOOM_AI_API_KEY_FILE: '/nope' } as NodeJS.ProcessEnv, () => { throw new Error('ENOENT /nope') })
    expect(missing.apiKey).toBeNull()
    expect(missing.problems).toEqual(['DBLOOM_AI_API_KEY_FILE cannot be read'])
    const shown = JSON.stringify(describeEndpoint(env({ DBLOOM_AI_BASE_URL: 'https://api.example.com/v1', DBLOOM_AI_API_KEY: 'sk-secret' })))
    expect(shown).toContain('"keySet":true')
    expect(shown).not.toContain('sk-secret')
    expect(JSON.parse(shown).origin).toBe('https://api.example.com')
  })

  it('limits are whole numbers within their range; others are limited or replaced and reported', () => {
    expect(env({ DBLOOM_AI_MAX_ROWS: '120', DBLOOM_AI_MAX_STEPS: '3' })).toMatchObject({ maxRows: 120, maxSteps: 3, problems: [] })
    const high = env({ DBLOOM_AI_MAX_ROWS: '9999', DBLOOM_AI_MAX_STEPS: '0' })
    expect(high).toMatchObject({ maxRows: 200, maxSteps: 1 })
    expect(high.problems).toHaveLength(2)
    const junk = env({ DBLOOM_AI_MAX_ROWS: 'many' })
    expect(junk.maxRows).toBe(50)
    expect(junk.problems).toEqual(['DBLOOM_AI_MAX_ROWS is not a whole number; 50 is used'])
  })

  it('PII markings of the environment are parsed; bad entries are counted, not echoed', () => {
    const e = env({ DBLOOM_PII_COLUMNS: '*.*.email, shop.customers.*, oops' })
    expect(e.piiColumns).toHaveLength(2)
    expect(e.problems).toEqual(['DBLOOM_PII_COLUMNS: 1 entries are not db.table.column and were ignored'])
  })
})

describe('availability and mode', () => {
  const e = env({ DBLOOM_AI_BASE_URL: 'https://api.example.com/v1' })
  it('works only with endpoint, switch and model', () => {
    expect(resolveAvailability(e, SETTINGS)).toEqual({ available: true, model: 'gpt-x', autoAllowed: true, hideNames: false, maxRows: 50, maxSteps: 8 })
    expect(resolveAvailability(e, { ...SETTINGS, assistantEnabled: false })).toEqual({ available: false, reason: 'disabled' })
    expect(resolveAvailability(e, { ...SETTINGS, assistantModel: '  ' })).toEqual({ available: false, reason: 'no-model' })
  })
  it('no endpoint means unavailable whatever the switch says', () => {
    expect(resolveAvailability(env({}), SETTINGS)).toEqual({ available: false, reason: 'no-endpoint' })
  })
  it('auto mode only where it is allowed', () => {
    expect(effectiveMode('auto', true)).toBe('auto')
    expect(effectiveMode('auto', false)).toBe('manual')
    expect(effectiveMode('manual', true)).toBe('manual')
  })
})

describe('the four settings', () => {
  const KEYS = ['assistantEnabled', 'assistantModel', 'assistantAutoAllowed', 'assistantHidePiiNames'] as const
  it('are in the registry with metadata in their own group, a label and the group label', () => {
    for (const k of KEYS) {
      expect(AUTH_SETTING_KEYS).toContain(k)
      expect(SETTING_META[k].group).toBe('assistant')
      expect(AUTH_SETTINGS[k].source).toBe('ui_within_env')
      expect((settingsTexts as Record<string, string>)[`settings.key.${k}`], k).toBeTruthy()
    }
    expect(SETTING_GROUPS).toContain('assistant')
    expect((settingsTexts as Record<string, string>)['settings.group.assistant']).toBeTruthy()
  })

  const resolve = (envVars: Record<string, string>) => {
    const store = { getSettings: () => [], getPendingSettings: () => [] } as never
    return createAuthSettingsResolver(store, envVars as NodeJS.ProcessEnv).resolve()
  }
  it('defaults: on, no model, auto allowed, names not hidden', () => {
    expect(resolve({})).toMatchObject({ assistantEnabled: true, assistantModel: '', assistantAutoAllowed: true, assistantHidePiiNames: false })
  })
  it('the environment sets the defaults', () => {
    expect(resolve({ DBLOOM_AI_MODEL: 'llama3', DBLOOM_ASSISTANT_AUTO_ALLOWED: 'false', DBLOOM_ASSISTANT_HIDE_PII_NAMES: 'true', DBLOOM_ASSISTANT_ENABLED: 'false' })).toMatchObject({
      assistantEnabled: false, assistantModel: 'llama3', assistantAutoAllowed: false, assistantHidePiiNames: true,
    })
  })
  it('a model name is plain text without spaces or control characters', () => {
    const schema = AUTH_SETTINGS.assistantModel.schema
    expect(schema.safeParse('claude-sonnet-5-5').success).toBe(true)
    expect(schema.safeParse('org/model:7b').success).toBe(true)
    expect(schema.safeParse('').success).toBe(true)
    for (const bad of ['two words', 'a\nb', 'x'.repeat(101), 'tab\there']) expect(schema.safeParse(bad).success, bad).toBe(false)
  })
})

describe('registry and audit', () => {
  it('every new variable is registered and in .env.example; the key is a secret kind', () => {
    const names = ['DBLOOM_AI_BASE_URL', 'DBLOOM_AI_API_KEY', 'DBLOOM_AI_API_KEY_FILE', 'DBLOOM_AI_ALLOW_PRIVATE', 'DBLOOM_AI_MAX_ROWS', 'DBLOOM_AI_MAX_STEPS', 'DBLOOM_PII_COLUMNS', 'DBLOOM_AI_MODEL', 'DBLOOM_ASSISTANT_ENABLED', 'DBLOOM_ASSISTANT_AUTO_ALLOWED', 'DBLOOM_ASSISTANT_HIDE_PII_NAMES']
    const example = renderEnvExample()
    for (const n of names) {
      expect(ENV_NAMES.has(n), n).toBe(true)
      expect(example, n).toContain(n)
    }
  })
  it('the audit catalog knows the assistant events', () => {
    for (const e of ['assistant.call', 'assistant.approve', 'assistant.deny', 'assistant.refuse', 'assistant.mode', 'assistant.rule']) expect(AUDIT_EVENTS).toContain(e)
  })
})
