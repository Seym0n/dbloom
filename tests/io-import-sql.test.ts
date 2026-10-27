import { beforeAll, describe, expect, it } from 'vitest'
import { splitStatements } from '../src/lib/sql/splitter'
import { initParser } from '../src/server/sql/parser'
import {
  SqlModeTracker,
  StatementStream,
  classifyImportStatement,
  type StreamStatement,
} from '../src/server/io/import-sql'
import { skipDecodedBytes } from '../src/server/io/import-source'

beforeAll(async () => {
  await initParser()
})

function splitAll(chunks: string[], opts: ConstructorParameters<typeof StatementStream>[0] = {}): StreamStatement[] {
  const s = new StatementStream(opts)
  const out: StreamStatement[] = []
  for (const c of chunks) {
    s.push(c)
    for (let st = s.next(false); st; st = s.next(false)) out.push(st)
  }
  for (let st = s.next(true); st; st = s.next(true)) out.push(st)
  return out
}

const SCRIPT = [
  '-- header comment',
  'SET NAMES utf8mb4;',
  "CREATE TABLE `t` (id INT, name VARCHAR(40));",
  "INSERT INTO `t` VALUES (1,'a;b'),(2,'it''s ä😀');",
  '/*!40101 SET @x = 1 */;',
  'DELIMITER $$',
  'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = 1; SET NEW.name = "x"; END$$',
  'DELIMITER ;',
  "INSERT INTO t VALUES (3, 'last');",
  '',
].join('\n')

describe('StatementStream', () => {
  it('gives the statements of the one-shot splitter', () => {
    const whole = splitStatements(SCRIPT).statements.filter((s) => !s.flags.empty)
    const got = splitAll([SCRIPT]).filter((s) => !s.flags.empty)
    expect(got.map((s) => s.text)).toEqual(whole.map((s) => s.text))
    expect(got).toHaveLength(6)
  })

  it('is the same at every chunk boundary', () => {
    const want = splitAll([SCRIPT]).map((s) => [s.text, s.startByte, s.endByte, s.line, s.delimiter])
    for (let cut = 0; cut <= SCRIPT.length; cut++) {
      const got = splitAll([SCRIPT.slice(0, cut), SCRIPT.slice(cut)]).map((s) => [s.text, s.startByte, s.endByte, s.line, s.delimiter])
      expect(got).toEqual(want)
    }
  })

  it('works one character at a time', () => {
    const want = splitAll([SCRIPT]).map((s) => s.text)
    expect(splitAll([...SCRIPT]).map((s) => s.text)).toEqual(want)
  })

  it('counts UTF-8 bytes and lines of the decoded text', () => {
    const text = "SELECT 'ä😀';\nSELECT 2;\n"
    const [a, b] = splitAll([text]).filter((s) => !s.flags.empty) as [StreamStatement, StreamStatement]
    expect(a.startByte).toBe(0)
    expect(a.endByte).toBe(Buffer.byteLength("SELECT 'ä😀';", 'utf8'))
    expect(b.line).toBe(2)
    expect(b.startByte).toBe(Buffer.byteLength("SELECT 'ä😀';\n", 'utf8'))
    expect(b.endByte).toBe(Buffer.byteLength("SELECT 'ä😀';\nSELECT 2;", 'utf8'))
  })

  it('resumes at a byte offset with the delimiter in force', () => {
    const all = splitAll([SCRIPT])
    const at = all.find((s) => s.text.startsWith('CREATE TRIGGER'))!
    const rest = Buffer.from(SCRIPT, 'utf8').subarray(at.endByte).toString('utf8')
    const again = splitAll([rest], { delimiter: at.delimiter, startByte: at.endByte })
    expect(again.filter((s) => !s.flags.empty).map((s) => s.text)).toEqual(
      all.filter((s) => !s.flags.empty && s.startByte >= at.endByte).map((s) => s.text),
    )
  })

  it('flags an unterminated string at the end of the file', () => {
    const [st] = splitAll(["INSERT INTO t VALUES ('abc"])
    expect(st?.unterminated).toBe(true)
  })

  it('follows a changed backslash mode between statements', () => {
    const s = new StatementStream()
    s.push("SET sql_mode = 'NO_BACKSLASH_ESCAPES'; INSERT INTO t VALUES ('a\\'); SELECT 2;")
    const first = s.next(false)
    expect(first?.text).toContain('NO_BACKSLASH_ESCAPES')
    s.setLex({ noBackslashEscapes: true })
    const second = s.next(false)
    expect(second?.text).toBe("INSERT INTO t VALUES ('a\\')")
    expect(s.next(true)?.text).toBe('SELECT 2')
  })
})

describe('SqlModeTracker', () => {
  it('follows a literal, a saved variable and an append', () => {
    const t = new SqlModeTracker('')
    expect(t.observe("SET sql_mode = 'NO_BACKSLASH_ESCAPES'")).toBe(true)
    expect(t.lexOptions().noBackslashEscapes).toBe(true)
    expect(t.observe("SET @old = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'")).toBe(true)
    expect(t.lexOptions().noBackslashEscapes).toBe(false)
    expect(t.observe('SET SQL_MODE=@old')).toBe(true)
    expect(t.lexOptions().noBackslashEscapes).toBe(true)
    expect(t.observe("SET sql_mode = CONCAT(@@sql_mode, ',ANSI_QUOTES')")).toBe(true)
    expect(t.lexOptions().ansiQuotes).toBe(true)
  })
})

describe('skipDecodedBytes', () => {
  async function collect(chunks: string[], skip: number) {
    async function* gen() {
      yield* chunks
    }
    let out = ''
    for await (const c of skipDecodedBytes(gen(), skip)) out += c
    return out
  }
  it('cuts at a byte offset inside and across chunks', async () => {
    const text = 'aä😀bc'
    const bytes = Buffer.from(text, 'utf8')
    for (const boundary of [0, 1, 2, 3, 4]) {
      const chunks = [[...text].slice(0, boundary).join(''), [...text].slice(boundary).join('')]
      for (const skip of [0, 1, 3, 7, 8, 9]) {
        expect(await collect(chunks, skip)).toBe(bytes.subarray(skip).toString('utf8'))
      }
    }
  })
})

describe('statement policy (spec 5.7)', () => {
  const ctx = { product: 'mysql' as const }
  const v = (sql: string, firstKeyword = sql.trim().split(/\s+/)[0]!.toUpperCase()) =>
    classifyImportStatement({ text: sql, firstKeyword, flags: { executableComment: false } }, ctx)

  const refused = [
    ['SET GLOBAL max_connections = 5', 'SET GLOBAL'],
    ['SET PERSIST max_connections = 5', 'SET GLOBAL'],
    ['KILL 4', 'KILL'],
    ["LOAD DATA INFILE '/x' INTO TABLE t", 'LOAD DATA'],
    ["SELECT 1 INTO OUTFILE '/tmp/x'", 'SELECT INTO OUTFILE'],
    ["SELECT 1 INTO DUMPFILE '/tmp/x'", 'SELECT INTO OUTFILE'],
    ["INSTALL PLUGIN x SONAME 'x.so'", 'INSTALL PLUGIN'],
    ['UNINSTALL PLUGIN x', 'UNINSTALL PLUGIN'],
    ['FLUSH PRIVILEGES', 'FLUSH'],
    ['FLUSH TABLES', 'FLUSH'],
    ['RESET MASTER', 'RESET'],
    ["CHANGE MASTER TO MASTER_HOST='x'", 'CHANGE MASTER'],
    ['CHANGE REPLICATION SOURCE TO SOURCE_HOST="x"', 'CHANGE REPLICATION'],
    ['START REPLICA', 'START REPLICA'],
    ['STOP SLAVE', 'STOP SLAVE'],
    ['SHUTDOWN', 'SHUTDOWN'],
  ] as const
  it.each(refused)('refuses %s', (sql, label) => {
    const r = v(sql)
    expect(r.tier).toBe('refused')
    expect(r.label).toBe(label)
  })

  const hard = [
    ['DROP TABLE t', 'DROP TABLE'],
    ['DROP DATABASE d', 'DROP DATABASE'],
    ['TRUNCATE TABLE t', 'TRUNCATE'],
    ['DELETE FROM t', 'DELETE'],
    ["CREATE USER 'a'@'%' IDENTIFIED BY 'x'", 'CREATE USER'],
    ["ALTER USER 'a'@'%' IDENTIFIED BY 'x'", 'ALTER USER'],
    ["DROP USER 'a'@'%'", 'DROP USER'],
    ["GRANT ALL ON *.* TO 'a'@'%'", 'GRANT'],
    ["REVOKE ALL ON *.* FROM 'a'@'%'", 'REVOKE'],
    ["RENAME USER 'a'@'%' TO 'b'@'%'", 'RENAME USER'],
    ["SET PASSWORD FOR 'a'@'%' = 'x'", 'SET PASSWORD'],
  ] as const
  it.each(hard)('makes %s hard', (sql, label) => {
    const r = v(sql)
    expect(r.tier).toBe('hard')
    expect(r.label).toBe(label)
  })

  it.each([
    ['USE d', 'none'],
    ['SET NAMES utf8mb4', 'none'],
    ['SET FOREIGN_KEY_CHECKS = 0', 'none'],
    ["INSERT INTO t VALUES (1, 'a')", 'none'],
    ['CREATE TABLE t (id INT)', 'none'],
    ['DELETE FROM t WHERE id = 3', 'none'],
    ['REPLACE INTO t VALUES (1)', 'soft'],
    ['ALTER TABLE t ADD COLUMN c INT', 'soft'],
    ['LOCK TABLES t WRITE', 'soft'],
    ['SELECT 1', 'none'],
    ['SELECT 1 INTO @x', 'none'],
  ] as const)('runs %s as %s', (sql, tier) => {
    expect(v(sql).tier).toBe(tier)
  })

  it('treats an unparsable statement as hard', () => {
    expect(v('FROBNICATE the database').tier).toBe('hard')
  })

  it('treats an oversize statement as hard, a plain oversize INSERT by the lexer', () => {
    const pad = 'x'.repeat(300 * 1024)
    expect(v(`UPDATE t SET a = '${pad}' WHERE id = 1`).tier).toBe('hard')
    expect(v(`INSERT INTO t VALUES ('${pad}')`).tier).toBe('none')
    expect(v(`REPLACE INTO t VALUES ('${pad}')`).tier).toBe('soft')
    const exec = classifyImportStatement(
      { text: `INSERT INTO t VALUES ('${pad}') /*!50000 */`, firstKeyword: 'INSERT', flags: { executableComment: true } },
      ctx,
    )
    expect(exec.tier).toBe('hard')
  })

  it('sees a refused statement inside an executable comment', () => {
    const r = classifyImportStatement(
      { text: '/*!50000 SET GLOBAL x = 1 */', firstKeyword: 'SET', flags: { executableComment: true } },
      ctx,
    )
    expect(r.tier).toBe('refused')
  })
})
