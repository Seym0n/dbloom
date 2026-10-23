/**
 * Dialect corpus of spec 5.1: valid MySQL 8.4 / MariaDB 10.11 statements, whether the parser accepts them
 * and what the classifier makes of them with and without the parser. The classifier must never relax a
 * class because the parser failed (FR-SQL-006); the corpus also decides a replacement parser.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { classifyStatement } from '../src/server/sql/classify'
import { initParser, parseStatement } from '../src/server/sql/parser'
import type { SqlProduct } from '../src/server/sql/parser'
import { splitStatements } from '../src/lib/sql/splitter'
import type { StatementClass } from '../src/server/structure/types'

type Entry = { sql: string; product?: SqlProduct; parses: boolean; cls: StatementClass }

const E = (sql: string, parses: boolean, cls: StatementClass, product?: SqlProduct): Entry => ({
  sql,
  parses,
  cls,
  ...(product ? { product } : {}),
})

export const CORPUS: Entry[] = [
  E('SELECT 1', true, 'none'),
  E('SELECT id, name FROM customer WHERE id = 5 ORDER BY name LIMIT 10 OFFSET 5', true, 'none'),
  E(
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT * FROM c',
    true,
    'none',
  ),
  E('SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) FROM t', true, 'none'),
  E("SELECT * FROM JSON_TABLE('[1,2]', '$[*]' COLUMNS (a INT PATH '$')) AS jt", true, 'none'),
  E("SELECT j->'$.a', j->>'$.b' FROM t", true, 'none'),
  E('SELECT * FROM t PARTITION (p0)', true, 'none'),
  E('SELECT /*! STRAIGHT_JOIN */ 1 /*M! , 2 */', true, 'none'),
  E('SELECT * FROM t FOR UPDATE SKIP LOCKED', true, 'soft'),
  E('SELECT * FROM t LOCK IN SHARE MODE', false, 'soft'),
  E("SELECT SHA2('a', 256)", true, 'none'),
  E('SELECT SLEEP(1)', true, 'none'),
  E("SELECT * FROM t INTO OUTFILE '/tmp/x'", false, 'hard'),
  E('SELECT 1 INTO @a', true, 'none'),
  E('SHOW FULL PROCESSLIST', true, 'none'),
  E('SHOW CREATE TABLE t', true, 'none'),
  E('SHOW TABLES', true, 'none'),
  E('DESCRIBE t', true, 'none'),
  E('EXPLAIN SELECT * FROM t', true, 'none'),
  E('EXPLAIN FORMAT=JSON SELECT * FROM t', true, 'none'),
  E('EXPLAIN ANALYZE SELECT * FROM t', true, 'none'),
  E('USE shop', true, 'none'),
  E('SET @a := 1', false, 'none'),
  E("SET SESSION sql_mode = 'ANSI'", true, 'none'),
  E('INSERT INTO t (a, b) VALUES (1, 2), (3, 4)', true, 'none'),
  E('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = VALUES(a)', true, 'none'),
  E('INSERT INTO t (a) VALUES (1) RETURNING a', true, 'none', 'mariadb'),
  E('INSERT INTO a SELECT * FROM b', true, 'none'),
  E('REPLACE INTO t VALUES (1)', true, 'soft'),
  E('UPDATE t SET a = 1 WHERE id = 5', true, 'none'),
  E('UPDATE a JOIN b ON a.i = b.i SET a.x = 1 WHERE a.i = 3', true, 'none'),
  E('DELETE FROM t WHERE id = 5', true, 'none'),
  E('DELETE FROM t WHERE id = 5 RETURNING *', true, 'none', 'mariadb'),
  E('CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL)', true, 'none'),
  E('CREATE TABLE a AS SELECT 1', true, 'none'),
  E('CREATE INDEX i ON t (a)', true, 'none'),
  E('CREATE OR REPLACE VIEW v AS SELECT 1', true, 'soft'),
  E('CREATE PROCEDURE p() BEGIN SELECT 1; END', false, 'hard'),
  E('ALTER TABLE t ADD COLUMN c INT', true, 'soft'),
  E('ALTER TABLE t ADD INDEX i (a) INVISIBLE', false, 'hard'),
  E('ALTER TABLE t DROP COLUMN c', true, 'hard'),
  E('RENAME TABLE a TO b', true, 'soft'),
  E('DROP TABLE x', true, 'hard'),
  E('TRUNCATE TABLE t', true, 'hard'),
  E('CALL p(1)', true, 'soft'),
  E('LOCK TABLES a READ', true, 'soft'),
  E('UNLOCK TABLES', true, 'soft'),
  E('KILL 5', true, 'soft'),
  E('FLUSH TABLES', true, 'soft'),
  E('GRANT ALL ON *.* TO u', true, 'hard'),
  E("LOAD DATA INFILE '/x' INTO TABLE t", false, 'hard'),
  E('DO SLEEP(1)', false, 'hard'),
  E('HANDLER t OPEN', false, 'hard'),
  E("PREPARE s FROM 'SELECT 1'", false, 'soft'),
  E('ANALYZE FORMAT=JSON SELECT 1', false, 'none', 'mariadb'),
  E('START TRANSACTION', true, 'none'),
  E('COMMIT', true, 'none'),
  E('SET GLOBAL max_connections = 10', true, 'hard'),
]

beforeAll(async () => {
  await initParser()
})

function stmt(sql: string) {
  const s = splitStatements(sql, { delimiter: '\u0001' }).statements[0]
  if (!s) throw new Error('empty')
  return s
}

describe('parser corpus', () => {
  it.each(CORPUS.map((e) => [`${e.product ?? 'mysql'}: ${e.sql}`, e] as const))('%s', (_n, e) => {
    const product = e.product ?? 'mysql'
    const p = parseStatement(e.sql, product)
    expect(p.ok, `parser verdict (${p.ok ? 'ok' : p.reason})`).toBe(e.parses)
    const withParser = classifyStatement(stmt(e.sql), { product })
    expect(withParser.class).toBe(e.cls)
    // the fallback never relaxes: without the parser the class is never lower
    const without = classifyStatement(stmt(e.sql), { product, parser: null })
    const rank = { none: 0, soft: 1, hard: 2 }
    expect(rank[without.class]).toBeGreaterThanOrEqual(rank[withParser.class])
  })

  it('reports the pass rate', () => {
    const ok = CORPUS.filter((e) => parseStatement(e.sql, e.product ?? 'mysql').ok).length
    expect(ok).toBe(CORPUS.filter((e) => e.parses).length)
    expect(CORPUS.length).toBeGreaterThanOrEqual(44)
  })

  it('whatever the parser rejects is either an allow-listed read or hard/soft by the floor, never lower than the floor', () => {
    for (const e of CORPUS.filter((x) => !x.parses)) {
      const c = classifyStatement(stmt(e.sql), { product: e.product ?? 'mysql' })
      const isRead = [
        'select',
        'selectInto',
        'show',
        'describe',
        'explain',
        'use',
        'setSession',
        'txControl',
      ].includes(c.kind)
      if (!isRead) expect(c.class, e.sql).not.toBe('none')
    }
  })

  it('a pathological script stays within the batch budget', () => {
    const t0 = performance.now()
    for (let i = 0; i < 300; i++)
      classifyStatement(stmt(`DELETE FROM t WHERE ${'(a = 1) AND '.repeat(40)} b = ${i}`), {
        product: 'mysql',
      })
    expect(performance.now() - t0).toBeLessThan(5000)
  })
})
