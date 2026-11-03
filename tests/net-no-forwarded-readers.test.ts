import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Backup for the ESLint rule (eslint.config.js): only src/server/net may read forwarded headers (FR-SVR-005).
const FORBIDDEN = /getRequestIP|getRequestHost|getRequestProtocol|getRequestUrl|['"`](x-forwarded-[a-z-]*|forwarded|x-real-ip|cf-connecting-ip|true-client-ip)['"`]/i

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('forwarded header readers', () => {
  it('none outside src/server/net', () => {
    const offenders: string[] = []
    for (const file of walk('src')) {
      const rel = relative('.', file).split(sep).join('/')
      if (rel.startsWith('src/server/net/')) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
          if (FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('the net module itself does read them (the test is not vacuous)', () => {
    expect(readFileSync('src/server/net/client-address.ts', 'utf8')).toMatch(/x-forwarded-for/)
  })
})
