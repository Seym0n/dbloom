import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise'
import { runWithTimeout } from '~/server/guard/statement-timeout'
import { WriteGuardError } from '~/server/guard/write-guard'

const servers = [
  { name: 'MySQL 8.4', port: 33064 },
  { name: 'MariaDB 10.11', port: 33061 },
]

describe.each(servers)('statement timeout on $name', ({ port }) => {
  let pool: Pool
  let conn: PoolConnection

  beforeAll(async () => {
    pool = createPool({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: 'root',
      connectionLimit: 4,
    })
    conn = await pool.getConnection()
  })
  afterAll(async () => {
    conn.release()
    await pool.end()
  })

  test('fast statement returns its result', async () => {
    const r = await runWithTimeout(pool, conn, 2000, 'SELECT 42 AS x')
    expect(r.usable).toBe(true)
    expect((r.result[0] as { x: number }[])[0]!.x).toBe(42)
  })

  test('SLEEP(5) with 500 ms is killed and the connection stays usable', async () => {
    const started = Date.now()
    let caught: unknown
    try {
      await runWithTimeout(pool, conn, 500, 'SELECT SLEEP(5)')
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - started
    expect(caught).toBeInstanceOf(WriteGuardError)
    expect((caught as WriteGuardError).code).toBe('timeout')
    expect(elapsed).toBeLessThan(1500)
    expect((caught as WriteGuardError).connectionUsable).toBe(true)
    const [rows] = await conn.query('SELECT 7 AS y')
    expect((rows as { y: number }[])[0]!.y).toBe(7)
  })

  test('other statement errors propagate unchanged', async () => {
    await expect(
      runWithTimeout(pool, conn, 2000, 'SELECT * FROM no_such_db.nope'),
    ).rejects.toMatchObject({
      errno: expect.any(Number),
    })
  })
})
