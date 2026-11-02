/** Package C task 5: the built CLI bundle against a store beside an open "server" handle. Skips when `.output/cli/dbloom.mjs` is not built
 *  (`npx vite build --config vite.cli.config.ts`). Needs no Docker. */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SETUP_TOKEN_FILE } from '~/server/auth/types'
import { openSqliteStore } from '~/server/store/sqlite-store'

const bundle = resolve('.output/cli/dbloom.mjs')
describe.skipIf(!existsSync(bundle))('built CLI (FR-AUT-030)', () => {
  it('prints the token, refuses unknown commands and audits on stderr only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbloom-cli-int-'))
    const server = openSqliteStore(join(dir, 'dbloom.db'))
    try {
      writeFileSync(join(dir, SETUP_TOKEN_FILE), `ABCD-EFGH\nexpires=${Date.now() + 60_000}\n`)
      const env = { ...process.env, DBLOOM_DATA_DIR: dir }
      const ok = spawnSync(process.execPath, [bundle, 'setup-token'], { env, encoding: 'utf8' })
      expect(ok.status).toBe(0)
      expect(ok.stdout).toBe('ABCD-EFGH\n')
      expect(ok.stderr).toContain('"actor":"cli"')
      expect(ok.stderr).not.toContain('ABCD')
      expect(spawnSync(process.execPath, [bundle, 'bogus'], { env, encoding: 'utf8' }).status).toBe(2)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
