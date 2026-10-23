import { describe, expect, it } from 'vitest'
import { redactSql } from '../src/lib/sql/redact'

const R = "'***'"

describe('redactSql', () => {
  const table: [string, string][] = [
    ["CREATE USER u IDENTIFIED BY 'secret'", `CREATE USER u IDENTIFIED BY ${R}`],
    [
      "create user u identified by 'secret' password expire",
      `create user u identified by ${R} password expire`,
    ],
    [
      "ALTER USER u IDENTIFIED BY 'new' REPLACE 'old'",
      `ALTER USER u IDENTIFIED BY ${R} REPLACE ${R}`,
    ],
    [
      "CREATE USER u IDENTIFIED WITH mysql_native_password BY 'x'",
      `CREATE USER u IDENTIFIED WITH mysql_native_password BY ${R}`,
    ],
    [
      "CREATE USER u IDENTIFIED WITH caching_sha2_password AS 'hash'",
      `CREATE USER u IDENTIFIED WITH caching_sha2_password AS ${R}`,
    ],
    [
      "CREATE USER u IDENTIFIED VIA ed25519 USING PASSWORD('pw')",
      `CREATE USER u IDENTIFIED VIA ed25519 USING PASSWORD(${R})`,
    ],
    [
      "GRANT ALL ON *.* TO u IDENTIFIED BY PASSWORD '*ABC'",
      `GRANT ALL ON *.* TO u IDENTIFIED BY PASSWORD ${R}`,
    ],
    [
      "CREATE USER a IDENTIFIED BY 'x', b IDENTIFIED BY 'y'",
      `CREATE USER a IDENTIFIED BY ${R}, b IDENTIFIED BY ${R}`,
    ],
    [
      "CREATE USER u IDENTIFIED BY 'x' COMMENT 'keep'",
      `CREATE USER u IDENTIFIED BY ${R} COMMENT 'keep'`,
    ],
    ["SET PASSWORD = 'x'", `SET PASSWORD = ${R}`],
    ["SET PASSWORD FOR u@h = 'x'", `SET PASSWORD FOR u@h = ${R}`],
    ["SET PASSWORD FOR 'u'@'h' = PASSWORD('x')", `SET PASSWORD FOR 'u'@'h' = PASSWORD(${R})`],
    ['SELECT PASSWORD(\'x\'), OLD_PASSWORD("y")', `SELECT PASSWORD(${R}), OLD_PASSWORD(${R})`],
    [
      "CHANGE MASTER TO MASTER_PASSWORD = 'p', MASTER_USER = 'u'",
      `CHANGE MASTER TO MASTER_PASSWORD = ${R}, MASTER_USER = 'u'`,
    ],
    [
      "CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD='p'",
      `CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD=${R}`,
    ],
    ["SELECT AES_ENCRYPT('data', 'key')", `SELECT AES_ENCRYPT('data', ${R})`],
    [
      "SELECT AES_DECRYPT(c, CONCAT('a', 'b')) FROM t",
      `SELECT AES_DECRYPT(c, CONCAT(${R}, ${R})) FROM t`,
    ],
    [
      "INSERT INTO t VALUES (AES_ENCRYPT('v', 'k', 'iv'))",
      `INSERT INTO t VALUES (AES_ENCRYPT('v', ${R}, ${R}))`,
    ],
    ["SELECT 1 /*! , PASSWORD('x') */", `SELECT 1 /*! , PASSWORD(${R}) */`],
  ]
  it.each(table)('%s', (input, expected) => {
    expect(redactSql(input)).toBe(expected)
  })

  it('leaves statements without secrets byte-identical', () => {
    for (const s of [
      "SELECT 'identified by ''x'''",
      'SELECT 1',
      "INSERT INTO t VALUES ('a')",
      '',
    ]) {
      expect(redactSql(s)).toBe(s)
    }
  })

  it('does not treat keywords inside comments or strings as keywords', () => {
    const s = "SELECT 'IDENTIFIED BY ''x''' /* IDENTIFIED BY 'y' */ -- PASSWORD('z')\n"
    expect(redactSql(s)).toBe(s)
  })

  it('handles whole submissions with several statements and DELIMITER lines', () => {
    const s = "DELIMITER $$\nCREATE USER u IDENTIFIED BY 'a'$$\nDELIMITER ;\nSELECT 'b';"
    expect(redactSql(s)).toBe(
      `DELIMITER $$\nCREATE USER u IDENTIFIED BY ${R}$$\nDELIMITER ;\nSELECT 'b';`,
    )
  })

  it('escapes inside the secret do not leak the tail', () => {
    expect(redactSql("CREATE USER u IDENTIFIED BY 'a\\'b;c'")).toBe(
      `CREATE USER u IDENTIFIED BY ${R}`,
    )
    expect(redactSql("CREATE USER u IDENTIFIED BY 'a''b'")).toBe(`CREATE USER u IDENTIFIED BY ${R}`)
    expect(redactSql("CREATE USER u IDENTIFIED BY 'a\\'", { noBackslashEscapes: true })).toBe(
      `CREATE USER u IDENTIFIED BY ${R}`,
    )
  })

  it('an unterminated secret is redacted to the end (nothing leaks)', () => {
    const out = redactSql("CREATE USER u IDENTIFIED BY 'secret")
    expect(out).not.toContain('secret')
  })

  it('never contains the secret in any table output', () => {
    for (const [input] of table) {
      const out = redactSql(input) as string
      for (const secret of ['secret', "'pw'", "'p'", "'hash'", "'key'", "'new'", "'*ABC'"]) {
        if (input.includes(secret) && !input.includes(`COMMENT ${secret}`)) {
          expect(out).not.toContain(secret)
        }
      }
    }
  })

  it('returns null when it cannot be trusted', () => {
    const bad = {
      get noBackslashEscapes(): boolean {
        throw new Error('boom')
      },
    }
    expect(redactSql("IDENTIFIED BY 'x'", bad)).toBeNull()
  })
})
