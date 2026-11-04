/** SPEC/33 task 1: every step-up purpose in `src/server` is declared in STEP_UP_SET, and every entry has a caller. */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isStepUpPurpose, STEP_UP_SET } from '~/server/auth/step-up-set'

const ROOT = join(__dirname, '..', 'src', 'server')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

/** Literal purposes in `requireRecentFactor(<expr>, '<purpose>')` and `sensitive(ctx, '<purpose>')`, plus the settings constant. */
function usedPurposes(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  const add = (purpose: string, file: string) => used.set(purpose, [...(used.get(purpose) ?? []), file])
  for (const file of files(ROOT)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/requireRecentFactor\(\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*'([^']+)'\s*\)/g)) add(m[1]!, file)
    for (const m of text.matchAll(/\bsensitive\(\s*ctx,\s*'([^']+)'\s*\)/g)) add(m[1]!, file)
    for (const m of text.matchAll(/\bSETTINGS_STEP_UP_PURPOSE\s*=\s*'([^']+)'/g)) add(m[1]!, file)
  }
  return used
}

describe('step-up set (FR-APR-001)', () => {
  const used = usedPurposes()

  it('finds the callers the scan is meant to find', () => {
    expect(used.size).toBeGreaterThanOrEqual(10)
  })

  it('declares every purpose that is used', () => {
    const undeclared = [...used.keys()].filter((p) => !isStepUpPurpose(p))
    expect(undeclared).toEqual([])
  })

  it('has a caller for every entry', () => {
    const unused = Object.keys(STEP_UP_SET).filter((p) => !used.has(p))
    expect(unused).toEqual([])
  })

  it('has no call with a non-literal purpose outside the known pass-through sites', () => {
    const allowed = new Set(['settings-service.ts', 'stepup.ts', 'types.ts', 'runtime.ts', 'settings-admin-runtime.ts', 'account-security.ts'])
    const offenders: string[] = []
    for (const file of files(ROOT)) {
      if ([...allowed].some((a) => file.endsWith(a))) continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/requireRecentFactor\(([^\n]*)\)/g)) {
        if (!/,\s*'[^']+'\s*\)?$/.test(m[0]) && !/=>/.test(m[0])) offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
