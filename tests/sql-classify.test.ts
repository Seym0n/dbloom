import { beforeAll, describe, expect, it } from 'vitest'
import { splitStatements } from '../src/lib/sql/splitter'
import { classifyBatch, classifyStatement, maxClass } from '../src/server/sql/classify'
import type { ClassifyContext } from '../src/server/sql/classify'
import { initParser } from '../src/server/sql/parser'
import type { SqlProduct } from '../src/server/sql/parser'
import type { ClassificationReason, SqlKind } from '../src/server/sql/types'
import type { StatementClass } from '../src/server/structure/types'

beforeAll(async () => {
  await initParser()
})

const NO_SPLIT = '\u0001'

function stmtOf(sql: string) {
  return (
    splitStatements(sql, { delimiter: NO_SPLIT }).statements[0] ?? {
      text: '',
      start: 0,
      end: 0,
      firstKeyword: '',
      flags: { executableComment: false, empty: true },
    }
  )
}

function one(sql: string, product: SqlProduct = 'mysql', extra: Partial<ClassifyContext> = {}) {
  return classifyStatement(stmtOf(sql), { product, ...extra })
}

type Row = {
  sql: string
  kind: SqlKind
  cls: StatementClass
  safe: boolean
  reasons?: ClassificationReason[]
  product?: SqlProduct
  commits?: boolean
}
const r = (
  sql: string,
  kind: SqlKind,
  cls: StatementClass,
  safe: boolean,
  reasons: ClassificationReason[] = [],
  more: Partial<Row> = {},
): Row => ({ sql, kind, cls, safe, reasons, ...more })

// ---- the classification table (spec 5.3) --------------------------------------------------------------

const TABLE: Row[] = [
  // reads
  r('SELECT 1', 'select', 'none', true),
  r('select * from t where id = 1', 'select', 'none', true),
  r('(SELECT 1) UNION (SELECT 2)', 'select', 'none', true),
  r('SELECT SLEEP(10)', 'select', 'none', true),
  r('SELECT BENCHMARK(1000000, MD5(1))', 'select', 'none', true),
  r('SELECT SHA2("a", 256)', 'select', 'none', true),
  r('SELECT /*! STRAIGHT_JOIN */ 1 /*M! , 2 */', 'select', 'none', true),
  r('SELECT * FROM t PARTITION (p0)', 'select', 'none', true),
  r(
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 5) SELECT * FROM c',
    'select',
    'none',
    true,
  ),
  r('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b', 'select', 'none', true),
  r('SELECT ROW_NUMBER() OVER (ORDER BY id) FROM t', 'select', 'none', true),
  r(
    'SELECT * FROM JSON_TABLE(\'[1]\', "$[*]" COLUMNS (a INT PATH "$")) jt',
    'select',
    'none',
    true,
  ),
  r('TABLE t', 'select', 'none', true),
  r('VALUES ROW(1, 2)', 'select', 'none', true),
  r('SHOW TABLES', 'show', 'none', true),
  r('SHOW FULL PROCESSLIST', 'show', 'none', true),
  r('show create table t', 'show', 'none', true),
  r('DESCRIBE t', 'describe', 'none', true),
  r('DESC t', 'describe', 'none', true),
  r('EXPLAIN t', 'describe', 'none', true),
  r('EXPLAIN SELECT * FROM t', 'explain', 'none', true),
  r('EXPLAIN FORMAT=JSON SELECT * FROM t', 'explain', 'none', true),
  r('EXPLAIN DELETE FROM t', 'explain', 'none', true),
  r('EXPLAIN UPDATE t SET a = 1', 'explain', 'none', true),
  r('EXPLAIN ANALYZE SELECT * FROM t', 'explain', 'none', true),
  r('USE shop', 'use', 'none', true),
  r('USE `my db`', 'use', 'none', true),
  // SELECT variants that are not plain reads
  r("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'selectInto', 'hard', false, ['into-outfile']),
  r("SELECT * FROM t INTO DUMPFILE '/tmp/x'", 'selectInto', 'hard', false, ['into-outfile']),
  r("SELECT 1 INTO OUTFILE '/tmp/x'", 'selectInto', 'hard', false, ['into-outfile']),
  r("SELECT /*!50000 1 INTO OUTFILE '/tmp/x' */", 'selectInto', 'hard', false, ['into-outfile']),
  r('SELECT 1 INTO @a', 'selectInto', 'none', false),
  r('SELECT a, b INTO @a, @b FROM t', 'selectInto', 'none', false),
  r('SELECT * FROM t FOR UPDATE', 'select', 'soft', false),
  r('SELECT * FROM t FOR SHARE', 'select', 'soft', false),
  r('SELECT * FROM t LOCK IN SHARE MODE', 'select', 'soft', false),
  r('SELECT * FROM t FOR UPDATE SKIP LOCKED', 'select', 'soft', false),
  r('WITH x AS (SELECT 1) SELECT * FROM t FOR UPDATE', 'select', 'soft', false),
  r("WITH x AS (SELECT 1) SELECT 1 INTO OUTFILE '/x'", 'selectInto', 'hard', false, [
    'into-outfile',
  ]),
  // DML
  r('INSERT INTO t VALUES (1)', 'insert', 'none', false),
  r('INSERT INTO a SELECT * FROM b', 'insert', 'none', false),
  r('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = VALUES(a)', 'insert', 'none', false),
  r('INSERT INTO t (a) VALUES (1) RETURNING a', 'insert', 'none', false, [], {
    product: 'mariadb',
  }),
  r('REPLACE INTO t VALUES (1)', 'replace', 'soft', false),
  r('DELETE FROM t', 'delete', 'hard', false, ['no-where']),
  r('DELETE FROM t WHERE id = 5', 'delete', 'none', false),
  r('DELETE FROM t WHERE id IN (1, 2, 3)', 'delete', 'none', false),
  r('DELETE FROM t WHERE 1 = 1', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE 1', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE TRUE', 'delete', 'hard', false, ['constant-where']),
  r("DELETE FROM t WHERE 'a' = 'a'", 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE id = id', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE ID = id', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE (id = id)', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE id = 5 OR 1 = 1', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE 1 = 1 OR id = 5', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE id >= id', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE id IS NULL OR id IS NOT NULL', 'delete', 'hard', false, [
    'constant-where',
  ]),
  r('DELETE FROM t WHERE NOT (id <> id)', 'delete', 'hard', false, ['constant-where']),
  r('DELETE FROM t WHERE id = 1 AND 1 = 1', 'delete', 'none', false),
  r('DELETE FROM t LIMIT 5', 'delete', 'hard', false, ['limit-only']),
  r('DELETE FROM t ORDER BY id LIMIT 5', 'delete', 'hard', false, ['limit-only']),
  r('DELETE FROM t WHERE id = 1 LIMIT 5', 'delete', 'none', false),
  r('DELETE a FROM a JOIN b ON a.id = b.id WHERE b.x = 1', 'delete', 'none', false),
  r('DELETE a FROM a JOIN b ON a.id = b.id', 'delete', 'hard', false, ['no-where']),
  r('DELETE FROM t RETURNING *', 'delete', 'hard', false, ['no-where'], { product: 'mariadb' }),
  r('UPDATE t SET a = 1', 'update', 'hard', false, ['no-where']),
  r('UPDATE t SET a = 1 LIMIT 10', 'update', 'hard', false, ['limit-only']),
  r("UPDATE customer SET name = 'x' WHERE 1 = 1", 'update', 'hard', false, ['constant-where']),
  r('UPDATE t SET a = 1 WHERE a = a', 'update', 'hard', false, ['constant-where']),
  r('UPDATE t SET a = 1 WHERE id = 5', 'update', 'none', false),
  r('UPDATE a JOIN b ON a.i = b.i SET a.x = 1 WHERE a.i = 3', 'update', 'none', false),
  r('WITH x AS (SELECT 1) UPDATE t SET a = 1', 'update', 'hard', false, ['no-where']),
  r('WITH x AS (SELECT 1) UPDATE t SET a = 1 WHERE a = 1', 'update', 'none', false),
  r('WITH x AS (SELECT 1) UPDATE t SET a = 1 WHERE 1 = 1', 'update', 'hard', false, [
    'constant-where',
  ]),
  r('WITH x AS (SELECT 1) DELETE FROM t', 'delete', 'hard', false, ['no-where']),
  r('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'insert', 'none', false),
  // DDL
  r('CREATE TABLE t (id INT)', 'createObject', 'none', false, [], { commits: true }),
  r('CREATE TABLE a AS SELECT 1', 'createObject', 'none', false),
  r('CREATE TEMPORARY TABLE t (id INT)', 'createObject', 'none', false, [], { commits: false }),
  r('CREATE DATABASE d', 'createObject', 'none', false),
  r('CREATE INDEX i ON t (a)', 'createObject', 'none', false),
  r('CREATE OR REPLACE VIEW v AS SELECT 1', 'createObject', 'soft', false),
  r('CREATE OR REPLACE TABLE t (id INT)', 'createObject', 'soft', false, [], {
    product: 'mariadb',
  }),
  r("CREATE USER u IDENTIFIED BY 'x'", 'account', 'hard', false, ['account']),
  r('CREATE ROLE ro', 'account', 'hard', false, ['account']),
  r('ALTER TABLE t ADD COLUMN c INT', 'alterObject', 'soft', false, [], { commits: true }),
  r('ALTER TABLE t ADD INDEX i (a)', 'alterObject', 'soft', false),
  r('ALTER TABLE t DROP COLUMN c', 'alterObject', 'hard', false, ['alter-drop']),
  r('ALTER TABLE t DROP INDEX i', 'alterObject', 'hard', false, ['alter-drop']),
  r('ALTER TABLE t DROP FOREIGN KEY fk', 'alterObject', 'hard', false, ['alter-drop']),
  r('ALTER TABLE t TRUNCATE PARTITION p0', 'alterObject', 'hard', false, ['alter-drop']),
  r('ALTER TABLE t DISCARD TABLESPACE', 'alterObject', 'hard', false, ['alter-drop']),
  r('ALTER TABLE t MODIFY c INT NOT NULL', 'alterObject', 'hard', false, ['narrowing']),
  r('ALTER TABLE t CHANGE c d VARCHAR(2)', 'alterObject', 'hard', false, ['narrowing']),
  r("ALTER USER u IDENTIFIED BY 'x'", 'account', 'hard', false, ['account']),
  r('RENAME TABLE a TO b', 'renameObject', 'soft', false),
  r('RENAME USER a TO b', 'account', 'hard', false, ['account']),
  r('DROP TABLE x', 'dropObject', 'hard', false, ['drop']),
  r('DROP DATABASE d', 'dropObject', 'hard', false, ['drop']),
  r('DROP TABLE IF EXISTS a, b', 'dropObject', 'hard', false, ['drop']),
  r('DROP TEMPORARY TABLE t', 'dropObject', 'hard', false, ['drop'], { commits: false }),
  r('DROP USER u', 'dropObject', 'hard', false, ['drop', 'account']),
  r('DROP VIEW v', 'dropObject', 'hard', false, ['drop']),
  r('TRUNCATE TABLE t', 'truncate', 'hard', false, ['truncate']),
  r('TRUNCATE t', 'truncate', 'hard', false, ['truncate']),
  // accounts, admin
  r('GRANT ALL ON *.* TO u', 'account', 'hard', false, ['account']),
  r('REVOKE ALL ON *.* FROM u', 'account', 'hard', false, ['account']),
  r("SET PASSWORD = 'x'", 'account', 'hard', false, ['account']),
  r("SET PASSWORD FOR u@h = 'x'", 'account', 'hard', false, ['account']),
  r('SET DEFAULT ROLE ALL TO u', 'account', 'hard', false, ['account']),
  r("LOAD DATA INFILE '/x' INTO TABLE t", 'loadData', 'hard', false, ['load-data']),
  r("LOAD DATA LOCAL INFILE '/x' INTO TABLE t", 'loadData', 'hard', false, ['load-data']),
  r("LOAD XML INFILE '/x' INTO TABLE t", 'loadData', 'hard', false, ['load-data']),
  r("INSTALL PLUGIN p SONAME 'x.so'", 'admin', 'hard', false, ['admin']),
  r('SHUTDOWN', 'admin', 'hard', false, ['admin']),
  r('RESET MASTER', 'admin', 'hard', false, ['admin']),
  r("CHANGE MASTER TO MASTER_HOST='h'", 'admin', 'hard', false, ['admin']),
  r('PURGE BINARY LOGS BEFORE NOW()', 'admin', 'hard', false, ['admin']),
  r('START REPLICA', 'admin', 'hard', false, ['admin']),
  r("CLONE LOCAL DATA DIRECTORY = '/x'", 'admin', 'hard', false, ['admin'], { product: 'mysql' }),
  r(
    "CLONE LOCAL DATA DIRECTORY = '/x'",
    'unknown',
    'hard',
    false,
    ['unknown-keyword', 'unparsed'],
    { product: 'mariadb' },
  ),
  r('BACKUP STAGE START', 'admin', 'hard', false, ['admin'], { product: 'mariadb' }),
  r('BACKUP STAGE START', 'unknown', 'hard', false, ['unknown-keyword'], { product: 'mysql' }),
  r('FLUSH TABLES', 'admin', 'soft', false),
  r('FLUSH LOGS', 'admin', 'soft', false),
  r('FLUSH TABLES t1, t2', 'admin', 'soft', false),
  r('FLUSH TABLES WITH READ LOCK', 'admin', 'hard', false, ['admin']),
  r('FLUSH PRIVILEGES', 'admin', 'hard', false, ['admin']),
  r('ANALYZE TABLE t', 'admin', 'soft', false),
  r('OPTIMIZE TABLE t', 'admin', 'soft', false),
  r('REPAIR TABLE t', 'admin', 'soft', false),
  r('CHECK TABLE t', 'admin', 'soft', false),
  r('KILL 5', 'kill', 'soft', false),
  r('KILL QUERY 5', 'kill', 'soft', false),
  r('CALL p()', 'call', 'soft', false),
  r('CALL db.p(1, "a")', 'call', 'soft', false),
  r('LOCK TABLES a READ', 'lock', 'soft', false, [], { commits: true }),
  r('LOCK TABLES a WRITE, b READ', 'lock', 'soft', false),
  r('UNLOCK TABLES', 'lock', 'soft', false),
  // prepared statements: the literal is classified
  r("PREPARE s FROM 'SELECT 1'", 'prepare', 'soft', false),
  r("PREPARE s FROM 'DROP TABLE x'", 'prepare', 'hard', false, ['drop']),
  r("PREPARE s FROM 'DELETE FROM t'", 'prepare', 'hard', false, ['no-where']),
  r("PREPARE s FROM 'DEL' 'ETE FROM t'", 'prepare', 'hard', false, ['unparsed']),
  r('PREPARE s FROM @q', 'prepare', 'hard', false, ['unparsed']),
  r("PREPARE s FROM 'SELECT 1; DROP TABLE x'", 'prepare', 'hard', false, ['unparsed']),
  r('EXECUTE s', 'prepare', 'soft', false),
  r('EXECUTE s USING @a', 'prepare', 'soft', false),
  r("EXECUTE IMMEDIATE 'DROP TABLE x'", 'prepare', 'hard', false, ['drop'], { product: 'mariadb' }),
  r('EXECUTE IMMEDIATE @q', 'prepare', 'hard', false, ['unparsed'], { product: 'mariadb' }),
  r('DEALLOCATE PREPARE s', 'prepare', 'none', false),
  // SET
  r('SET @a = 1', 'setSession', 'none', true),
  r('SET @a := 1, @b = 2', 'setSession', 'none', true),
  r('SET NAMES utf8mb4', 'setSession', 'none', true),
  r("SET SESSION sql_mode = 'ANSI'", 'setSession', 'none', true),
  r('SET @@session.sql_mode = ""', 'setSession', 'none', true),
  r('SET foreign_key_checks = 0', 'setSession', 'none', true),
  r('SET autocommit = 0', 'setSession', 'none', true, [], { commits: true }),
  r('SET GLOBAL max_connections = 10', 'setGlobal', 'hard', false, ['global-set']),
  r('SET PERSIST max_connections = 10', 'setGlobal', 'hard', false, ['global-set']),
  r('SET PERSIST_ONLY max_connections = 10', 'setGlobal', 'hard', false, ['global-set']),
  r('SET @@global.max_connections = 10', 'setGlobal', 'hard', false, ['global-set']),
  r('SET @a = 1, GLOBAL x = 2', 'setGlobal', 'hard', false, ['global-set']),
  r('SET GLOBAL TRANSACTION READ WRITE', 'setGlobal', 'hard', false, ['global-set']),
  r(
    'SET STATEMENT max_statement_time=1 FOR DELETE FROM t',
    'setSession',
    'hard',
    false,
    ['unparsed'],
    { product: 'mariadb' },
  ),
  r('SET SESSION TRANSACTION READ ONLY', 'setSession', 'none', true),
  r('SET SESSION TRANSACTION READ WRITE', 'setSession', 'none', false),
  r('SET TRANSACTION READ WRITE', 'setSession', 'none', false),
  r('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE', 'setSession', 'none', false),
  r('SET @@session.tx_read_only = 0', 'setSession', 'none', false),
  r('SET SESSION transaction_read_only = OFF', 'setSession', 'none', false),
  r('SET tx_read_only = 0', 'setSession', 'none', false),
  r('SET @@SESSION.TRANSACTION_READ_ONLY = 0', 'setSession', 'none', false),
  r('SET @a = 1, tx_read_only = 0', 'setSession', 'none', false),
  r('SET @@`session`.tx_read_only = 0', 'setSession', 'hard', false, ['unparsed']),
  // transactions
  r('START TRANSACTION', 'txControl', 'none', true, [], { commits: true }),
  r('START TRANSACTION READ ONLY', 'txControl', 'none', true),
  r('START TRANSACTION READ WRITE', 'txControl', 'none', false),
  r('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ WRITE', 'txControl', 'none', false),
  r('BEGIN', 'txControl', 'none', true, [], { commits: true }),
  r('COMMIT', 'txControl', 'none', true, [], { commits: false }),
  r('ROLLBACK', 'txControl', 'none', true),
  r('ROLLBACK TO SAVEPOINT sp', 'txControl', 'none', true),
  r('SAVEPOINT sp', 'txControl', 'none', true),
  r('RELEASE SAVEPOINT sp', 'txControl', 'none', true),
  // unknown or unparsed
  r('DO SLEEP(10)', 'unknown', 'hard', false, ['unknown-keyword', 'unparsed']),
  r('HANDLER t OPEN', 'unknown', 'hard', false, ['unknown-keyword', 'unparsed']),
  r('HANDLER t READ FIRST', 'unknown', 'hard', false, ['unknown-keyword', 'unparsed']),
  r("XA START 'a'", 'unknown', 'hard', false, ['unknown-keyword', 'unparsed']),
  r('FOO BAR', 'unknown', 'hard', false, ['unknown-keyword', 'unparsed']),
  r("SIGNAL SQLSTATE '45000'", 'unknown', 'hard', false, ['unknown-keyword']),
  r('CREATE PROCEDURE p() BEGIN SELECT 1; END', 'createObject', 'hard', false, ['unparsed']),
  r('ALTER TABLE t ADD INDEX i (a) INVISIBLE', 'alterObject', 'hard', false, ['unparsed']),
  r('USE a b', 'use', 'hard', false, ['unparsed']),
  r('', 'unknown', 'none', true),
  r('-- only a comment', 'unknown', 'none', true),
]

describe('classification table', () => {
  it.each(TABLE.map((row) => [`${row.product ?? 'mysql'}: ${row.sql || '(empty)'}`, row] as const))(
    '%s',
    (_name, row) => {
      const c = one(row.sql, row.product ?? 'mysql')
      expect(c.kind, 'kind').toBe(row.kind)
      expect(c.class, 'class').toBe(row.cls)
      expect(c.readOnlySafe, 'readOnlySafe').toBe(row.safe)
      for (const reason of row.reasons ?? []) expect(c.reasons).toContain(reason)
      if (row.commits !== undefined) expect(c.commitsImplicitly, 'commits').toBe(row.commits)
    },
  )

  it('has at least 150 rows', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(150)
  })
})

describe('invariants over the table', () => {
  it('readOnlySafe implies class none; every non-none verdict that is not a plain read has a reason or is soft', () => {
    for (const row of TABLE) {
      const c = one(row.sql || '-- x', row.product ?? 'mysql')
      if (c.readOnlySafe) expect(c.class).toBe('none')
      if (c.class === 'hard') expect(c.reasons.length, row.sql).toBeGreaterThan(0)
    }
  })
  it('reasons are only from the closed set', () => {
    const closed = new Set([
      'no-where',
      'constant-where',
      'limit-only',
      'drop',
      'truncate',
      'alter-drop',
      'narrowing',
      'account',
      'global-set',
      'load-data',
      'into-outfile',
      'admin',
      'unparsed',
      'unknown-keyword',
      'multi-statement-explain',
      'parser-off',
      'budget',
    ])
    for (const row of TABLE) {
      for (const x of one(row.sql || '-- x', row.product ?? 'mysql').reasons)
        expect(closed.has(x)).toBe(true)
    }
  })
  it('tables facts for DML and DDL', () => {
    expect(one('DELETE FROM shop.t WHERE id = 1').tables).toEqual([{ db: 'shop', table: 't' }])
    expect(one('UPDATE t SET a = 1 WHERE id = 1').tables).toEqual([{ table: 't' }])
    expect(one('DROP TABLE a.b').tables).toEqual([{ db: 'a', table: 'b' }])
    expect(one('CREATE TABLE x (id INT)').tables).toEqual([{ table: 'x' }])
    expect(one('ALTER TABLE x ADD c INT').tables).toEqual([{ table: 'x' }])
    expect(one('RENAME TABLE a TO b').tables).toEqual([{ table: 'a' }, { table: 'b' }])
  })
})

describe('parser failure, kill switch, budget', () => {
  it('parser null: reads stay none, everything that needs the parser is hard parser-off', () => {
    const ctx = { parser: null }
    expect(one('SELECT 1', 'mysql', ctx)).toMatchObject({ class: 'none', readOnlySafe: true })
    expect(one('SHOW TABLES', 'mysql', ctx)).toMatchObject({ class: 'none' })
    expect(one('SET @a = 1', 'mysql', ctx)).toMatchObject({ class: 'none', readOnlySafe: true })
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'DELETE FROM t WHERE id = 1',
      'UPDATE t SET a = 1 WHERE id = 1',
      'CREATE TABLE t (id INT)',
      'ALTER TABLE t ADD c INT',
      'CALL p()',
      'REPLACE INTO t VALUES (1)',
    ]) {
      const c = one(sql, 'mysql', ctx)
      expect(c.class, sql).toBe('hard')
      expect(c.reasons, sql).toContain('parser-off')
    }
    // floor verdicts do not depend on the parser
    expect(one('DROP TABLE x', 'mysql', ctx).reasons).toContain('drop')
    expect(one('DELETE FROM t', 'mysql', ctx).class).toBe('hard')
  })

  it('DBLOOM_SQL_PARSER=off behaves like no parser', () => {
    const old = process.env.DBLOOM_SQL_PARSER
    process.env.DBLOOM_SQL_PARSER = 'off'
    try {
      const c = one('DELETE FROM t WHERE id = 1')
      expect(c.class).toBe('hard')
      expect(c.reasons).toContain('parser-off')
      expect(one('SELECT 1').class).toBe('none')
    } finally {
      if (old === undefined) delete process.env.DBLOOM_SQL_PARSER
      else process.env.DBLOOM_SQL_PARSER = old
    }
  })

  it('a rejected statement is unparsed, not silently allowed', () => {
    const c = one('INSERT INTO t SET a = 1, b = 2 /* mysql form */ FOO BAR')
    expect(c.class).toBe('hard')
    expect(c.reasons).toContain('unparsed')
  })

  it('statements over the size budget are hard with reason budget', () => {
    const big = `INSERT INTO t VALUES ('${'a'.repeat(300_000)}')`
    const c = one(big)
    expect(c.class).toBe('hard')
    expect(c.reasons).toContain('budget')
    // a big plain read stays none
    expect(one(`SELECT '${'a'.repeat(300_000)}'`).class).toBe('none')
  })

  it('classifyBatch stops parsing when the total budget is spent', () => {
    const stmts = splitStatements(
      'INSERT INTO t VALUES (1); DELETE FROM t WHERE id = 1; SELECT 1',
    ).statements
    const out = classifyBatch(stmts, { product: 'mysql', budgetMs: -1 })
    expect(out[0]?.classification).toMatchObject({ class: 'hard' })
    expect(out[0]?.classification.reasons).toContain('budget')
    expect(out[1]?.classification.reasons).toContain('budget')
    expect(out[2]?.classification.class).toBe('none')
  })

  it('classifyBatch keeps the statement fields and maxClass takes the maximum', () => {
    const stmts = splitStatements('SELECT 1; DROP TABLE x; INSERT INTO t VALUES (1)').statements
    const out = classifyBatch(stmts, { product: 'mysql' })
    expect(out.map((o) => o.classification.class)).toEqual(['none', 'hard', 'none'])
    expect(out[0]?.text).toBe('SELECT 1')
    expect(maxClass(out.map((o) => o.classification.class))).toBe('hard')
    expect(maxClass([])).toBe('none')
  })
})

// ---- adversarial corpus: every read-only or confirmation bypass attempt ---------------------------------

type Adv = [sql: string, cls: StatementClass, safe: boolean, product?: SqlProduct]

const ADVERSARIAL: Adv[] = [
  // comments and strings hide keywords from the reader, not from the classifier
  ['/* DROP TABLE x */ SELECT 1', 'none', true],
  ['SELECT 1 -- DROP TABLE x', 'none', true],
  ['SELECT 1 # DROP TABLE x', 'none', true],
  ["SELECT 'DROP TABLE x; --'", 'none', true],
  ["SELECT 'into outfile', 'for update'", 'none', true],
  ['SELECT `into`, `drop` FROM t', 'none', true],
  // comments and case do not hide keywords from the classifier
  ['drop/**/table x', 'hard', false],
  ['DROP/* c */TABLE x', 'hard', false],
  ['DrOp TaBlE x', 'hard', false],
  ['\n\t DROP\n TABLE\r\n x', 'hard', false],
  ['-- c\nDROP TABLE x', 'hard', false],
  ['/* a */ /* b */ TRUNCATE t', 'hard', false],
  ['/*!50000 DROP TABLE x*/', 'hard', false],
  ['/*!99999 DROP TABLE x*/', 'hard', false],
  ['/*!DROP TABLE x*/', 'hard', false],
  ['/*M!100000 DROP TABLE x*/', 'hard', false, 'mariadb'],
  ['/*M!100000 DROP TABLE x*/', 'hard', false, 'mysql'],
  ['SELECT 1 /*!50000 ; DROP TABLE x */', 'hard', false],
  ['SELECT 1 /*! /* x */ DROP TABLE y */', 'hard', false],
  ["/*!50000 SELECT */ 1 /*!50000 INTO OUTFILE '/x' */", 'hard', false],
  ["SELECT 1 INTO/**/OUTFILE '/x'", 'hard', false],
  ["SELECT 1 INTO /*!50000 OUTFILE */ '/x'", 'hard', false],
  ["select 1 into outfile '/x'", 'hard', false],
  ["SELECT * FROM t WHERE a IN (SELECT b FROM u) INTO OUTFILE '/x'", 'hard', false],
  ["SELECT 1 INTO\n\tDUMPFILE '/x'", 'hard', false],
  ['SELECT 1 FOR/**/UPDATE', 'soft', false],
  ['SELECT 1 LOCK/*c*/IN/*c*/SHARE MODE', 'soft', false],
  ['SELECT * FROM t /*!50000 FOR UPDATE */', 'soft', false],
  ['SELECT * FROM t WHERE (SELECT 1 FOR UPDATE)', 'soft', false],
  // unicode and whitespace variants: the server reads them as identifier characters, so they are unknown
  ['DROP\u00a0TABLE x', 'hard', false],
  ['\u00a0DROP TABLE x', 'hard', false],
  ['\ufeffDROP TABLE x', 'hard', false],
  ['DROP\u2003TABLE x', 'hard', false],
  ['DROP\u200bTABLE x', 'hard', false],
  ['\uff24\uff32\uff2f\uff30 TABLE x', 'hard', false],
  ['SELEC\u200bT 1', 'hard', false],
  ['SELECT\u00a01', 'hard', false],
  ['SELECT\t1', 'none', true],
  ['SELECT\n1', 'none', true],
  ['SELECT\u000b1', 'none', true],
  ['SELECT\f1', 'none', true],
  ['`DROP` TABLE x', 'hard', false],
  ["'SELECT' 1", 'hard', false],
  // statements that look harmless
  ['EXPLAIN DELETE FROM t', 'none', true],
  ['EXPLAIN ANALYZE DELETE FROM t', 'hard', false],
  ['EXPLAIN /*!50000 ANALYZE */ DELETE FROM t', 'hard', false],
  ['EXPLAIN ANALYZE DELETE FROM t WHERE id = 1', 'none', false],
  ['EXPLAIN FORMAT=TREE ANALYZE UPDATE t SET a = 1', 'hard', false],
  ['ANALYZE DELETE FROM t', 'hard', false, 'mariadb'],
  ['ANALYZE FORMAT=JSON DELETE FROM t', 'hard', false, 'mariadb'],
  ['ANALYZE FORMAT=JSON UPDATE t SET a = 1 WHERE id = 1', 'none', false, 'mariadb'],
  ['ANALYZE DELETE FROM t', 'hard', false, 'mysql'],
  ['WITH x AS (SELECT 1) UPDATE t SET a = 1', 'hard', false],
  ['WITH x AS (SELECT 1) DELETE FROM t WHERE 1 = 1', 'hard', false],
  ['WITH x (a) AS (SELECT 1), y AS (SELECT 2) DELETE FROM t', 'hard', false],
  ['WITH RECURSIVE x AS (SELECT 1) UPDATE t SET a = 1 LIMIT 5', 'hard', false],
  ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'none', false],
  ['WITH', 'hard', false],
  ['WITH x AS SELECT 1', 'hard', false],
  ['INSERT INTO t SELECT * FROM u', 'none', false],
  ['CREATE TABLE t AS SELECT * FROM u', 'none', false],
  ['CREATE TABLE t LIKE u', 'none', false],
  ['CREATE TABLE IF NOT EXISTS t (id INT)', 'none', false],
  // stored routines, prepared statements, dynamic SQL
  ['CALL p()', 'soft', false],
  ['CREATE FUNCTION f() RETURNS INT RETURN 1', 'hard', false],
  ['CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1', 'hard', false],
  ['CREATE EVENT ev ON SCHEDULE EVERY 1 DAY DO DELETE FROM t', 'hard', false],
  ['DROP PROCEDURE p', 'hard', false],
  ["PREPARE s FROM 'DROP TABLE x'", 'hard', false],
  ["PREPARE s FROM 'SELECT 1 INTO OUTFILE \\'/x\\''", 'hard', false],
  ["PREPARE s FROM 'select 1; drop table x'", 'hard', false],
  ["PREPARE s FROM 'SET GLOBAL a = 1'", 'hard', false],
  ["PREPARE s FROM 'PREPARE t FROM \\'DROP TABLE x\\''", 'hard', false],
  ["PREPARE s FROM 'SET SESSION TRANSACTION READ WRITE'", 'soft', false],
  ["PREPARE s FROM CONCAT('DROP ', 'TABLE x')", 'hard', false],
  ["SET @q = 'DROP TABLE x'", 'none', true],
  ['EXECUTE s', 'soft', false],
  ['DO SLEEP(1)', 'hard', false],
  ['DO (SELECT GET_LOCK("a", 1))', 'hard', false],
  ['HANDLER t OPEN', 'hard', false],
  ['HANDLER t READ FIRST', 'hard', false],
  ["LOAD DATA INFILE '/etc/passwd' INTO TABLE t", 'hard', false],
  ["LOAD/**/DATA LOCAL INFILE 'x' INTO TABLE t", 'hard', false],
  ['SET GLOBAL read_only = 0', 'hard', false],
  ['SET/**/GLOBAL x = 1', 'hard', false],
  ['SET /*!50000 GLOBAL */ x = 1', 'hard', false],
  ['SET @@global . x = 1', 'hard', false],
  ['FLUSH/**/PRIVILEGES', 'hard', false],
  ['GRANT/**/ALL ON *.* TO u', 'hard', false],
  ['GRANT PROXY ON root TO u', 'hard', false],
  ['REVOKE ALL PRIVILEGES, GRANT OPTION FROM u', 'hard', false],
  ['SHUTDOWN', 'hard', false],
  ["XA BEGIN 'x'", 'hard', false],
  ["SIGNAL SQLSTATE '45000'", 'hard', false],
  // read-only bypass attempts: nothing here may be readOnlySafe
  ['SET SESSION TRANSACTION READ WRITE', 'none', false],
  ['set session transaction read/**/write', 'none', false],
  ['SET /*!50000 SESSION */ TRANSACTION /*!50000 READ WRITE */', 'none', false],
  ['SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE', 'none', false],
  ['SET @@session.tx_read_only = 0', 'none', false],
  ['SET @@SESSION . TX_READ_ONLY = OFF', 'none', false],
  ['SET @@session.transaction_read_only = false', 'none', false],
  ['SET SESSION TX_READ_ONLY = 0', 'none', false],
  ['SET @@session.`tx_read_only` = 0', 'hard', false],
  ['SET @@`session`.tx_read_only = 0', 'hard', false],
  ['START TRANSACTION READ WRITE', 'none', false],
  ['START TRANSACTION/**/READ/**/WRITE', 'none', false],
  ['START TRANSACTION READ ONLY, READ WRITE', 'none', false],
  ['BEGIN READ WRITE', 'none', false],
  ['INSERT INTO t VALUES (1)', 'none', false],
  ['UPDATE t SET a = 1 WHERE id = 1', 'none', false],
  ['CALL p()', 'soft', false],
  ['LOCK TABLES t WRITE', 'soft', false],
  ['HANDLER t CLOSE', 'hard', false],
  ['SELECT 1 INTO @a', 'none', false],
  ['SELECT * FROM t FOR UPDATE', 'soft', false],
  ['KILL 1', 'soft', false],
  ['CREATE TEMPORARY TABLE t (id INT)', 'none', false],
  ['SELECT 1 FROM t PROCEDURE ANALYSE()', 'none', true],
  // destructive without a restricting condition
  ['DELETE FROM t WHERE /* x */ 1=1', 'hard', false],
  ['DELETE FROM t -- WHERE id = 1\n', 'hard', false],
  ['DELETE FROM t /* WHERE id = 1 */', 'hard', false],
  ["DELETE FROM t WHERE 'WHERE id = 1' = 'WHERE id = 1'", 'hard', false],
  ['DELETE FROM t WHERE id = 1 OR TRUE', 'hard', false],
  ['DELETE FROM t WHERE 0 = 0', 'hard', false],
  ["DELETE FROM t WHERE 'x'", 'hard', false],
  ['DELETE FROM t WHERE NULL IS NULL', 'hard', false],
  ['DELETE FROM t WHERE (1)', 'hard', false],
  ['DELETE FROM t WHERE 1 < 2', 'hard', false],
  ['DELETE FROM t WHERE NOT FALSE', 'hard', false],
  ['DELETE FROM t WHERE id = 1 OR NOT FALSE', 'hard', false],
  ['DELETE FROM t WHERE TRUE AND TRUE', 'hard', false],
  ['DELETE FROM t WHERE (SELECT 1)', 'hard', false],
  ['DELETE FROM t WHERE id = (id)', 'hard', false],
  ['DELETE FROM t WHERE id <=> id', 'hard', false],
  ['DELETE FROM t WHERE id + 0 = id + 0', 'hard', false],
  ['DELETE FROM t WHERE (id = id) OR (name = 1)', 'hard', false],
  ['UPDATE t SET a = 1 WHERE (SELECT 1)', 'hard', false],
  ['UPDATE t SET a = 1 WHERE b = b AND c = c', 'hard', false],
  ['UPDATE t SET a = 1 ORDER BY id LIMIT 1', 'hard', false],
  ['DELETE QUICK FROM t', 'hard', false],
  ['DELETE LOW_PRIORITY FROM t', 'hard', false],
  ['DELETE IGNORE FROM t', 'hard', false],
  ['UPDATE LOW_PRIORITY IGNORE t SET a = 1', 'hard', false],
  ['DELETE FROM t PARTITION (p0)', 'hard', false],
  ['DELETE FROM t WHERE id = 1 AND 1 = 1', 'none', false],
  ['ALTER TABLE t DROP COLUMN c, ADD d INT', 'hard', false],
  ['ALTER TABLE t ADD d INT, DROP c', 'hard', false],
  ['ALTER TABLE t /* DROP */ ADD d INT', 'soft', false],
  ['ALTER TABLE t DROP PRIMARY KEY', 'hard', false],
  ['ALTER TABLE t DROP/**/COLUMN c', 'hard', false],
  ['ALTER IGNORE TABLE t DROP c', 'hard', false],
  ['ALTER ONLINE TABLE t DROP c', 'hard', false],
  ['ALTER TABLE t REMOVE PARTITIONING', 'hard', false],
  ['ALTER TABLE t ALTER COLUMN c DROP DEFAULT', 'hard', false],
  ['ALTER TABLE t MODIFY c TINYINT', 'hard', false],
  ['TRUNCATE/**/t', 'hard', false],
  ['RENAME TABLE a TO b, c TO d', 'soft', false],
  ['ALTER DEFINER=root@localhost EVENT e DISABLE', 'hard', false],
  ['CREATE DEFINER=root@localhost PROCEDURE p() SELECT 1', 'hard', false],
  ['CREATE USER u', 'hard', false],
  ['CREATE /*!50000 USER */ u', 'hard', false],
  ['CREATE OR REPLACE USER u', 'hard', false, 'mariadb'],
  ["ALTER USER u IDENTIFIED BY 'x'", 'hard', false],
  ['DROP USER u', 'hard', false],
  ["SET PASSWORD FOR u = 'x'", 'hard', false],
  ["SET /*!50000 PASSWORD */ = 'x'", 'hard', false],
  // stacked statements inside one text (custom DELIMITER or fuzzing)
  ['SELECT 1; DROP TABLE x', 'hard', false],
  ['SELECT 1;DROP TABLE x', 'hard', false],
  ['SELECT 1\n;\nTRUNCATE t', 'hard', false],
]

describe('adversarial corpus', () => {
  it.each(ADVERSARIAL.map((a) => [`${a[3] ?? 'mysql'}: ${JSON.stringify(a[0])}`, a] as const))(
    '%s',
    (_n, a) => {
      const [sql, cls, safe, product] = a
      const c = one(sql, product ?? 'mysql')
      expect(c.class, `class (${c.kind}, ${c.reasons.join(',')})`).toBe(cls)
      expect(c.readOnlySafe, 'readOnlySafe').toBe(safe)
    },
  )

  it('is large enough', () => {
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(100)
  })

  it('without the parser nothing becomes lower than with it, and nothing hard becomes safe', () => {
    const rank = { none: 0, soft: 1, hard: 2 }
    for (const [sql, , , product] of ADVERSARIAL) {
      const a = one(sql, product ?? 'mysql')
      const b = one(sql, product ?? 'mysql', { parser: null })
      expect(rank[b.class], sql).toBeGreaterThanOrEqual(rank[a.class])
      if (b.readOnlySafe) expect(a.readOnlySafe, sql).toBe(true)
    }
  })

  it('a stray delimiter from DELIMITER is never relaxed', () => {
    const r = splitStatements('DELIMITER $$\nSELECT 1; DROP TABLE x$$\nDELIMITER ;\n')
    const out = classifyBatch(r.statements, { product: 'mysql' })
    expect(out).toHaveLength(1)
    expect(out[0]?.classification).toMatchObject({ class: 'hard', readOnlySafe: false })
    expect(out[0]?.classification.reasons).toContain('unparsed')
  })

  it('NO_BACKSLASH_ESCAPES: a quote that looks escaped cannot hide a statement', () => {
    const sql = "SELECT 'a\\' ; DROP TABLE x; --'"
    const normal = splitStatements(sql)
    expect(normal.statements).toHaveLength(1)
    const nb = splitStatements(sql, { noBackslashEscapes: true })
    expect(nb.statements.length).toBeGreaterThan(1)
    const out = classifyBatch(nb.statements, {
      product: 'mysql',
      lex: { noBackslashEscapes: true },
    })
    expect(maxClass(out.map((o) => o.classification.class))).toBe('hard')
  })

  it('lexer options reach the classifier (ANSI_QUOTES: "x" is an identifier, not a string)', () => {
    const c = one('SET SESSION "tx_read_only" = 0', 'mysql', { lex: { ansiQuotes: true } })
    expect(c.readOnlySafe).toBe(false)
  })

  it('a text with several statements is refused read-only as a whole: one unsafe statement is enough', () => {
    const out = classifyBatch(
      splitStatements('SELECT 1; SET SESSION TRANSACTION READ WRITE; SELECT 2').statements,
      {
        product: 'mysql',
      },
    )
    expect(out.map((o) => o.classification.readOnlySafe)).toEqual([true, false, true])
  })

  it('never contradicts the classes of the structure module builder output', () => {
    const generated: [string, StatementClass][] = [
      ['CREATE TABLE `d`.`t` (`id` INT NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB', 'none'],
      ['ALTER TABLE `d`.`t` ADD COLUMN `c` INT NULL', 'soft'],
      ['ALTER TABLE `d`.`t` DROP COLUMN `c`', 'hard'],
      ['DROP TABLE `d`.`t`', 'hard'],
      ['DROP DATABASE `d`', 'hard'],
      ['RENAME TABLE `d`.`a` TO `d`.`b`', 'soft'],
      ['CREATE DATABASE `d`', 'none'],
    ]
    for (const [sql, cls] of generated) {
      const c = one(sql)
      expect(c.class, sql).toBe(cls)
    }
  })
})

describe('database names of CREATE and DROP DATABASE (FR-SQL-025)', () => {
  it.each([
    ['CREATE DATABASE x', ['x']],
    ['CREATE SCHEMA s2', ['s2']],
    ['CREATE DATABASE IF NOT EXISTS `a b`', ['a b']],
    ['create database `we``ird` character set utf8mb4', ['we`ird']],
    ['DROP DATABASE IF EXISTS y', ['y']],
    ['DROP SCHEMA z', ['z']],
    ['CREATE TABLE d.t (id int)', undefined],
    ['DROP TABLE a, d.b', undefined],
  ] as const)('%s', (sql, databases) => {
    for (const product of ['mysql', 'mariadb'] as const) {
      const c = one(sql, product)
      expect(c.databases).toEqual(databases)
      if (databases) expect(c.tables).toBeUndefined()
    }
  })
  it('keeps the table facts of table DDL', () => {
    expect(one('CREATE TABLE d.t (id int)', 'mysql').tables).toEqual([{ db: 'd', table: 't' }])
    expect(one('DROP TABLE a, d.b', 'mysql').tables).toEqual([
      { table: 'a' },
      { db: 'd', table: 'b' },
    ])
  })
})
