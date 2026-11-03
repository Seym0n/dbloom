import { describe, expect, it } from 'vitest'
import { exposureCommand } from '../src/server/exposure'

const run = (env: Record<string, string>) => exposureCommand(env as NodeJS.ProcessEnv)

const topologies: Record<string, Record<string, string>> = {
  'local default': { DBLOOM_DIRECT_TARGETS: 'db:3306' },
  'behind proxy': {
    DBLOOM_HOST: '0.0.0.0',
    DBLOOM_PUBLIC_ORIGIN: 'https://db.example.com',
    DBLOOM_TRUST_PROXY: '172.18.0.0/16',
    DBLOOM_LOGIN_MODE: 'account',
  },
  'risky stateless': {
    DBLOOM_STORE: 'none',
    DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
    DBLOOM_TARGET_TLS: 'skip-verify',
    DBLOOM_ALLOW_PRIVATE: 'true',
  },
}

describe('exposure report', () => {
  for (const [name, env] of Object.entries(topologies)) {
    it(`snapshot: ${name}`, () => {
      const r = run(env)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toMatchSnapshot()
    })
  }

  it('warns for risky settings only', () => {
    expect(run(topologies['local default']!).stdout).toContain('Warnings: none')
    const risky = run(topologies['risky stateless']!).stdout
    expect(risky).toContain('free-form')
    expect(risky).toContain('Target TLS is skip-verify')
  })

  it('never prints secret values', () => {
    const r = run({ ...topologies['local default']!, DBLOOM_SECRET_KEY: 'sUpErSeCrEt123', DBLOOM_SETUP_TOKEN: 'tok-abc' })
    expect(r.stdout).not.toMatch(/sUpErSeCrEt123|tok-abc/)
  })

  it('reports a refused configuration', () => {
    const r = run({ DBLOOM_HOST: '0.0.0.0' })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('DBLOOM_PUBLIC_ORIGIN is required')
  })
})
