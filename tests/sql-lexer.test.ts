import { describe, expect, it } from 'vitest'
import { codeTokens, tokenize } from '../src/lib/sql/lexer'
import { splitStatements, statementAt } from '../src/lib/sql/splitter'

const texts = (s: string, o = {}) => splitStatements(s, o).statements.map((x) => x.text)

function rng(seed: number): () => number {
  let s = seed
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

describe('splitter basics', () => {
  it('splits on the delimiter and trims', () => {
    expect(texts('SELECT 1; SELECT 2 ;\n\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })
  it('keeps comments in the statement and gives offsets', () => {
    const input = '-- a\nSELECT 1 -- foobar\n; /* x */ SELECT 2'
    const r = splitStatements(input)
    expect(r.statements.map((s) => s.text)).toEqual([
      '-- a\nSELECT 1 -- foobar',
      '/* x */ SELECT 2',
    ])
    for (const s of r.statements) expect(input.slice(s.start, s.end)).toBe(s.text)
  })
  it('does not split inside quotes and comments', () => {
    expect(texts('SELECT \'a;b\', "c;d", `e;f`; SELECT 2')).toHaveLength(2)
    expect(texts('SELECT 1 /* ; */; SELECT 2 # ;\n; SELECT 3 -- ;\n')).toHaveLength(3)
  })
  it('backslash escapes and NO_BACKSLASH_ESCAPES', () => {
    expect(texts("SELECT 'a\\';b'; SELECT 2")).toHaveLength(2)
    expect(texts("SELECT 'a\\'; SELECT 2", { noBackslashEscapes: true })).toEqual([
      "SELECT 'a\\'",
      'SELECT 2',
    ])
    expect(texts("SELECT 'it''s;'; SELECT 2")).toHaveLength(2)
  })
  it('ANSI_QUOTES makes double quotes identifiers (still no split inside)', () => {
    expect(texts('SELECT "a;b"; SELECT 2', { ansiQuotes: true })).toHaveLength(2)
    expect(tokenize('"x"', { ansiQuotes: true }).tokens[0]?.type).toBe('quotedIdent')
    expect(tokenize('"x"').tokens[0]?.type).toBe('string')
  })
  it('-- needs whitespace, # always comments', () => {
    expect(texts('SELECT 1--1; SELECT 2')).toEqual(['SELECT 1--1', 'SELECT 2'])
    expect(texts('SELECT 1 --\n; SELECT 2')).toHaveLength(2)
    expect(texts('SELECT 1 -- x; y\n; SELECT 2')).toHaveLength(2)
    // NBSP is not whitespace for the server: not a comment, the semicolon splits
    expect(texts('SELECT 1 -- ; SELECT 2')).toHaveLength(2)
  })
  it('skips empty statements, keeps a comment-only tail as empty', () => {
    const r = splitStatements(';; SELECT 1;; -- bye')
    expect(r.statements.map((s) => [s.text, s.flags.empty])).toEqual([
      ['SELECT 1', false],
      ['-- bye', true],
    ])
  })
  it('firstKeyword is upper case after comments', () => {
    const r = splitStatements('/* c */ -- x\n  select 1; (select 2); /*!50000 drop table x*/')
    expect(r.statements.map((s) => s.firstKeyword)).toEqual(['SELECT', '(', 'DROP'])
  })
  it('statementAt finds the statement under the cursor', () => {
    const r = splitStatements('SELECT 1; SELECT 2')
    expect(statementAt(r.statements, 3)?.text).toBe('SELECT 1')
    expect(statementAt(r.statements, 14)?.text).toBe('SELECT 2')
  })
})

describe('executable comments', () => {
  it('are kept and never split', () => {
    const r = splitStatements('SELECT /*! STRAIGHT_JOIN */ 1 /*M! , 2 */; SELECT 2')
    expect(r.statements).toHaveLength(2)
    expect(r.statements[0]?.flags.executableComment).toBe(true)
    expect(r.statements[0]?.text).toBe('SELECT /*! STRAIGHT_JOIN */ 1 /*M! , 2 */')
    expect(r.statements[1]?.flags.executableComment).toBe(false)
  })
  it('a delimiter inside one does not split; a string with a comment end does not end it', () => {
    expect(texts('SELECT /*!50000 1; */ 2; SELECT 3')).toHaveLength(2)
    expect(texts("SELECT /*! '*/' */ 1; SELECT 2")).toHaveLength(2)
  })
  it('content is flattened by codeTokens', () => {
    const c = codeTokens('SELECT /*!40001 SQL_NO_CACHE */ 1')
    expect(c.hasExec).toBe(true)
    expect(c.tokens.map((t) => t.upper)).toEqual(['SELECT', 'SQL_NO_CACHE', '1'])
    expect(codeTokens('SELECT /*! 1 /* n */ */ 2').execNested).toBe(true)
  })
  it('an executable comment as first token sets the first keyword', () => {
    expect(splitStatements('/*!50000 DROP TABLE x */').statements[0]?.firstKeyword).toBe('DROP')
    expect(splitStatements('/*! */').statements[0]?.flags.empty).toBe(true)
  })
})

describe('DELIMITER', () => {
  it('changes the delimiter and is not part of any statement', () => {
    const sql =
      'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END $$\nDELIMITER ;\nSELECT 3;'
    const r = splitStatements(sql)
    expect(r.statements.map((s) => s.text)).toEqual([
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
      'SELECT 3',
    ])
    expect(r.errors).toEqual([])
  })
  it('is case-insensitive, allows multi-character delimiters, indentation and CRLF', () => {
    expect(texts('  delimiter //\r\nSELECT 1; SELECT 2//\r\nDELIMITER ;\r\nSELECT 3;')).toEqual([
      'SELECT 1; SELECT 2',
      'SELECT 3',
    ])
    expect(texts('DELIMITER $$ -- note\nSELECT 1$$ SELECT 2$$')).toEqual(['SELECT 1', 'SELECT 2'])
  })
  it('splits mid-word like the mysql client', () => {
    expect(texts('DELIMITER $$\nSELECT END$$')).toEqual(['SELECT END'])
  })
  it('only at the start of a line and with no statement started', () => {
    expect(texts('SELECT 1 DELIMITER $$\n; SELECT 2')).toEqual([
      'SELECT 1 DELIMITER $$',
      'SELECT 2',
    ])
    expect(texts('SELECT 1\nDELIMITER $$\n; SELECT 2')).toEqual([
      'SELECT 1\nDELIMITER $$',
      'SELECT 2',
    ])
  })
  it('a leading comment does not hide the command', () => {
    expect(texts('-- hi\nDELIMITER $$\nSELECT 1$$')).toEqual(['SELECT 1'])
  })
  it('invalid commands are left to the server', () => {
    expect(texts('DELIMITER\nSELECT 1;')).toEqual(['DELIMITER\nSELECT 1'])
    expect(texts("DELIMITER 'x'\nSELECT 1;")[0]).toContain('DELIMITER')
    expect(texts('DELIMITER $$ junk\nSELECT 1;')[0]).toContain('DELIMITER')
  })
  it('options.delimiter sets the initial delimiter', () => {
    expect(texts('SELECT 1; SELECT 2//SELECT 3', { delimiter: '//' })).toEqual([
      'SELECT 1; SELECT 2',
      'SELECT 3',
    ])
  })
})

describe('lexical errors', () => {
  it('reports unterminated strings and comments with their position', () => {
    expect(splitStatements("SELECT 1; SELECT 'abc").errors).toEqual([
      { code: 'unterminated-string', at: 17 },
    ])
    expect(splitStatements('SELECT 1 /* open').errors).toEqual([
      { code: 'unterminated-comment', at: 9 },
    ])
    expect(splitStatements('SELECT `abc').errors[0]?.code).toBe('unterminated-string')
    expect(splitStatements('SELECT /*! open').errors[0]?.code).toBe('unterminated-comment')
  })
})

describe('round trip and performance', () => {
  const parts = [
    "'",
    '"',
    '`',
    '\\',
    '-',
    '--',
    '# ',
    '/*',
    '*/',
    '/*!',
    ';',
    ' ',
    '\n',
    'a',
    'SELECT',
    '@',
    '1',
    '.',
    '$$',
    '(',
    ')',
  ]

  it('tokenize is lossless (fuzz)', () => {
    const rnd = rng(12345)
    for (let n = 0; n < 500; n++) {
      let s = ''
      const len = Math.floor(rnd() * 40)
      for (let i = 0; i < len; i++) s += parts[Math.floor(rnd() * parts.length)]
      const { tokens } = tokenize(s, { noBackslashEscapes: rnd() < 0.5, ansiQuotes: rnd() < 0.5 })
      expect(tokens.map((t) => s.slice(t.start, t.end)).join('')).toBe(s)
    }
  })

  it('statements plus the gaps between them reproduce the input (fuzz)', () => {
    const rnd = rng(777)
    for (let n = 0; n < 500; n++) {
      let s = ''
      const len = Math.floor(rnd() * 40)
      for (let i = 0; i < len; i++) s += parts[Math.floor(rnd() * parts.length)]
      const r = splitStatements(s)
      let pos = 0
      let rebuilt = ''
      for (const st of r.statements) {
        expect(st.start).toBeGreaterThanOrEqual(pos)
        expect(s.slice(st.start, st.end)).toBe(st.text)
        const gap = s.slice(pos, st.start)
        expect(gap.replace(/[\s;]/g, '')).toBe('') // only blanks and delimiters between statements
        rebuilt += gap + st.text
        pos = st.end
      }
      expect(rebuilt + s.slice(pos)).toBe(s)
    }
  })

  it('1 MiB splits in well under a second', () => {
    const unit =
      'INSERT INTO t VALUES (1, \'a;b\', "c"); -- note; here\n/* block; */ SELECT `x;y` FROM t;\n'
    const big = unit.repeat(Math.ceil(1_048_576 / unit.length))
    const t0 = performance.now()
    const r = splitStatements(big)
    const ms = performance.now() - t0
    expect(r.errors).toEqual([])
    expect(r.statements.length).toBeGreaterThan(10_000)
    expect(ms).toBeLessThan(1000)
  })
})
