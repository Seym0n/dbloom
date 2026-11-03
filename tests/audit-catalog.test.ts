import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT_EVENTS, isAuditEvent } from '~/server/audit/events'
import { AUTH_AUDIT_EVENTS } from '~/server/auth/types'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const files = sources('src')

describe('audit event catalog', () => {
  it('has unique names', () => {
    expect(new Set(AUDIT_EVENTS).size).toBe(AUDIT_EVENTS.length)
  })

  it('contains every auth-account event', () => {
    for (const e of AUTH_AUDIT_EVENTS) expect(isAuditEvent(e), e).toBe(true)
  })

  it('contains every event name written with a literal in the source', () => {
    const found = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\baudit(?:Io)?\(\s*'([a-z_]+(?:\.[a-z_]+)+|logout)'/g)) found.add(m[1]!)
      for (const m of text.matchAll(/\bevent: '([a-z_]+\.[a-z_.]+)'/g)) found.add(m[1]!)
    }
    const missing = [...found].filter((e) => !isAuditEvent(e))
    expect(missing).toEqual([])
    expect(found.size).toBeGreaterThan(30)
  })

  it('has no audit line written outside src/server/audit', () => {
    const offenders = files.filter((f) => {
      if (f.includes(`server${sep}audit`)) return false
      return /JSON\.stringify\(\{[^}]*\baudit:/.test(readFileSync(f, 'utf8'))
    })
    expect(offenders).toEqual([])
  })
})
