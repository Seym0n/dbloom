import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Config } from '~/server/config'
import { openTargetPool } from '~/server/db/target-pool'
import { createTokenIssuer } from '~/server/guard/confirm-token'
import { runSqlText } from '~/server/sql/run'
import { memorySqlState } from '~/server/sql/state'
import { DEFAULT_SQL_LIMITS } from '~/server/sql/types'
import { SessionManager } from '~/server/sessions'
import { openSqliteStore } from '~/server/store/sqlite-store'

const config = { tls: 'off', connectTimeoutMs: 3000 } as Config
const sessionConfig = { sessionIdleMs: 60_000, sessionAbsoluteMs: 600_000 }
const target = { host: '127.0.0.1', port: 33064, username: 'root' }

let dir: string
let store: ReturnType<typeof openSqliteStore>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbloom-sess-'))
  store = openSqliteStore(join(dir, 'store.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('ending a session cancels its running SQL and drops its in-memory state', async () => {
  const sessions = new SessionManager(store, sessionConfig)
  const pool = await openTargetPool(target, '127.0.0.1', 'root', config)
  const { token } = sessions.create(target, pool)
  const live = sessions.resolve(token)!
  memorySqlState.addHistory(live.idHash, {
    createdAt: Date.now(),
    source: 'user',
    targetKey: 't',
    db: null,
    sql: 'SELECT 1',
    sqlOmitted: false,
    statements: 1,
    executed: 1,
    failedIndex: null,
    maxClass: 'none',
    outcome: 'ok',
    durationMs: 1,
  })
  expect(memorySqlState.listHistory(live.idHash, { limit: 5 }).entries).toHaveLength(1)

  const started = Date.now()
  const run = runSqlText(
    {
      session: { idHash: live.idHash, target, pool, readOnly: false },
      guard: { forcedReadOnly: false, sessionReadOnly: false },
      tokens: createTokenIssuer(),
      limits: { ...DEFAULT_SQL_LIMITS, timeoutMs: 30_000 },
    },
    {
      runId: 'run-sess-end-1',
      tabId: 't',
      text: 'SELECT SLEEP(20)',
      options: {
        continueOnError: false,
        singleTransaction: false,
        disableForeignKeyChecks: false,
        confirmSoft: false,
      },
    },
  )
  await new Promise((r) => setTimeout(r, 500))
  await sessions.destroy(token)
  const res = await run
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(res.kind).toBe('done')
  if (res.kind === 'done') expect(res.ok).toBe(false)
  expect(memorySqlState.listHistory(live.idHash, { limit: 5 }).entries).toEqual([])
})
