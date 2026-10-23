/**
 * Narrow validator for user-typed SQL expressions (FR-STR-011, SEC-TGT-151, spec Q1 default).
 *
 * Used for generated-column, CHECK and default expressions until a real SQL parser is chosen. It is a
 * tokenizer plus an operand/operator alternation check, not a parser: it accepts only identifiers,
 * literals, parentheses, arithmetic / comparison / logical operators and an allow-list of functions.
 * Everything else (semicolons, comments, subqueries, variables, double quotes, bitwise operators,
 * unknown functions, unbalanced quotes or parentheses) is rejected with the offending part named.
 * The server stays the final judge of the syntax; this is a gate against injection and side effects.
 */

export type ExpressionResult = { ok: true } | { ok: false; reason: string }

export type ExpressionOptions = {
  /** Columns of the table; when given, every identifier must be one of them (case-insensitive). */
  columns?: readonly string[]
}

export const MAX_EXPRESSION_LENGTH = 2000

/** Deterministic, side-effect-free functions only (no SLEEP, LOAD_FILE, GET_LOCK, RAND, UUID ...). */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'ABS',
  'CEIL',
  'CEILING',
  'FLOOR',
  'ROUND',
  'MOD',
  'POW',
  'POWER',
  'SQRT',
  'SIGN',
  'LEAST',
  'GREATEST',
  'COALESCE',
  'IFNULL',
  'NULLIF',
  'IF',
  'CONCAT',
  'CONCAT_WS',
  'LENGTH',
  'CHAR_LENGTH',
  'LOWER',
  'UPPER',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'SUBSTRING',
  'SUBSTR',
  'LEFT',
  'RIGHT',
  'REPLACE',
  'REVERSE',
  'LPAD',
  'RPAD',
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'HOUR',
  'MINUTE',
  'SECOND',
  'DATEDIFF',
  'NOW',
  'CURRENT_TIMESTAMP',
  'UNIX_TIMESTAMP',
  'JSON_EXTRACT',
  'JSON_UNQUOTE',
  'JSON_VALID',
  'MD5',
  'SHA1',
  'SHA2',
])

/** Words that act as binary (infix) operators. */
const BINARY_WORDS = new Set([
  'AND',
  'OR',
  'XOR',
  'DIV',
  'MOD',
  'IS',
  'IN',
  'LIKE',
  'REGEXP',
  'RLIKE',
  'BETWEEN',
])
const STRUCTURAL_WORDS = new Set(['NOT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'])
/** Constants that stand for a value without parentheses. */
const CONSTANT_WORDS = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'UNKNOWN',
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
])
/** Bare words that can never be a column in an expression and signal a statement or subquery. */
const FORBIDDEN_WORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'UNION',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'GRANT',
  'REVOKE',
  'TRUNCATE',
  'WITH',
  'INTO',
  'EXISTS',
  'ANY',
  'ALL',
  'SOME',
  'SET',
  'CALL',
  'DO',
  'HANDLER',
  'LOAD',
  'SHOW',
  'EXEC',
  'EXECUTE',
  'PREPARE',
  'USE',
  'LOCK',
  'OUTFILE',
  'DUMPFILE',
  'PROCEDURE',
  'INTERVAL',
  'DEFAULT',
  'VALUES',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'JOIN',
  'ON',
])

type Tok =
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string; quoted: boolean }
  | { t: 'word'; v: string } // keyword-like bare word, upper-cased
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' }

const fail = (reason: string): ExpressionResult => ({ ok: false, reason })

function show(s: string): string {
  return JSON.stringify(s.length > 24 ? s.slice(0, 24) + '...' : s)
}

function tokenize(sql: string): Tok[] | string {
  const out: Tok[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === ';') return 'semicolon (stacked statements) is not allowed'
    if (c === '#') return 'comment "#" is not allowed'
    if (c === '-' && sql[i + 1] === '-') return 'comment "--" is not allowed'
    if (c === '/' && (sql[i + 1] === '*' || sql[i + 1] === '/')) {
      return sql[i + 1] === '*' ? 'comment "/*" is not allowed' : 'operator "//" is not allowed'
    }
    if (c === '*' && sql[i + 1] === '/') return 'comment terminator "*/" is not allowed'
    if (c === '@') return 'variables ("@") are not allowed'
    if (c === '"') return 'double-quoted text is not allowed; use single quotes for strings'
    if (c === '\u0000') return 'NUL byte is not allowed'
    if (c === "'") {
      let j = i + 1
      let v = ''
      let closed = false
      while (j < n) {
        const d = sql[j]!
        if (d === '\\') {
          if (j + 1 >= n) break
          v += sql[j + 1]
          j += 2
          continue
        }
        if (d === "'") {
          if (sql[j + 1] === "'") {
            v += "'"
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        v += d
        j++
      }
      if (!closed) return 'unbalanced single quote'
      out.push({ t: 'str', v })
      i = j
      continue
    }
    if (c === '`') {
      let j = i + 1
      let v = ''
      let closed = false
      while (j < n) {
        const d = sql[j]!
        if (d === '`') {
          if (sql[j + 1] === '`') {
            v += '`'
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        v += d
        j++
      }
      if (!closed) return 'unbalanced backtick'
      if (v === '') return 'empty quoted identifier'
      out.push({ t: 'id', v, quoted: true })
      i = j
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i))!
      if (/[A-Za-z_$]/.test(sql[i + m[0].length] ?? '')) {
        return `malformed number near ${show(sql.slice(i, i + m[0].length + 1))}`
      }
      out.push({ t: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      const m = /^[A-Za-z0-9_$\u0080-￿]+/.exec(sql.slice(i))![0]
      const up = m.toUpperCase()
      // a function call is an identifier directly followed by "("
      let k = i + m.length
      while (k < n && /\s/.test(sql[k]!)) k++
      const isCall = sql[k] === '('
      if (isCall) out.push({ t: 'word', v: up })
      else if (
        BINARY_WORDS.has(up) ||
        CONSTANT_WORDS.has(up) ||
        ['NOT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'].includes(up)
      ) {
        out.push({ t: 'word', v: up })
      } else {
        out.push({ t: 'id', v: m, quoted: false })
      }
      i += m.length
      continue
    }
    const two = sql.slice(i, i + 3) === '<=>' ? '<=>' : sql.slice(i, i + 2)
    if (['<=>', '<=', '>=', '<>', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two })
      i += two.length
      continue
    }
    if ('+-*/%=<>!'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if (c === '(') {
      out.push({ t: 'lp' })
      i++
      continue
    }
    if (c === ')') {
      out.push({ t: 'rp' })
      i++
      continue
    }
    if (c === ',') {
      out.push({ t: 'comma' })
      i++
      continue
    }
    return `character ${show(c)} is not allowed`
  }
  return out
}

/**
 * Validate one scalar SQL expression. Returns `{ ok: true }` or `{ ok: false, reason }` where the
 * reason names the offending part.
 */
export function validateExpression(sql: string, options: ExpressionOptions = {}): ExpressionResult {
  if (typeof sql !== 'string' || sql.trim() === '') return fail('expression is empty')
  if (sql.length > MAX_EXPRESSION_LENGTH) return fail('expression is too long')
  const toks = tokenize(sql)
  if (typeof toks === 'string') return fail(toks)
  const known = options.columns ? new Set(options.columns.map((c) => c.toLowerCase())) : null

  // expectOperand: we need a value, a prefix operator or "(" next; otherwise an operator or ")" / ","
  let expectOperand = true
  // stack of open parentheses: true when it is a function call (commas allowed), false for grouping
  const stack: boolean[] = []
  let prevWasCase = false

  for (let idx = 0; idx < toks.length; idx++) {
    const tok = toks[idx]!
    const wasCase = prevWasCase
    prevWasCase = false
    switch (tok.t) {
      case 'num':
      case 'str':
        if (!expectOperand) return fail(`unexpected value ${show(tok.v)}`)
        expectOperand = false
        break
      case 'id': {
        if (!expectOperand) return fail(`unexpected identifier ${show(tok.v)}`)
        if (!tok.quoted && FORBIDDEN_WORDS.has(tok.v.toUpperCase())) {
          return fail(`"${tok.v.toUpperCase()}" is not allowed in an expression`)
        }
        if (known && !known.has(tok.v.toLowerCase())) {
          return fail(`unknown column ${show(tok.v)}`)
        }
        expectOperand = false
        break
      }
      case 'word': {
        const next = toks[idx + 1]
        const structural = BINARY_WORDS.has(tok.v) || STRUCTURAL_WORDS.has(tok.v)
        // MOD(a, b) is a function when an operand is expected, `a MOD b` an operator otherwise
        if (next && next.t === 'lp' && (!structural || (tok.v === 'MOD' && expectOperand))) {
          // function call
          if (!expectOperand) return fail(`unexpected function ${tok.v}`)
          if (!ALLOWED_FUNCTIONS.has(tok.v)) return fail(`function ${tok.v} is not allowed`)
          stack.push(true)
          idx++ // consume "("
          expectOperand = true
          // allow empty argument list: NOW()
          if (toks[idx + 1]?.t === 'rp') {
            stack.pop()
            idx++
            expectOperand = false
          }
          break
        }
        if (CONSTANT_WORDS.has(tok.v)) {
          // IS NULL / IS NOT NULL / IS TRUE: the operand after IS is a constant
          if (!expectOperand) return fail(`unexpected ${tok.v}`)
          expectOperand = false
          break
        }
        if (tok.v === 'NOT') {
          // prefix NOT, or modifier after an operand (a NOT IN / IS NOT NULL): state unchanged
          break
        }
        if (tok.v === 'CASE') {
          if (!expectOperand) return fail('unexpected CASE')
          prevWasCase = true
          break
        }
        if (tok.v === 'WHEN') {
          if (!wasCase && expectOperand) return fail('unexpected WHEN')
          expectOperand = true
          break
        }
        if (tok.v === 'THEN' || tok.v === 'ELSE') {
          if (expectOperand) return fail(`unexpected ${tok.v}`)
          expectOperand = true
          break
        }
        if (tok.v === 'END') {
          if (expectOperand) return fail('unexpected END')
          expectOperand = false
          break
        }
        if (BINARY_WORDS.has(tok.v)) {
          if (expectOperand) return fail(`unexpected ${tok.v}`)
          expectOperand = true
          break
        }
        return fail(`unexpected ${tok.v}`)
      }
      case 'op': {
        const prefix = tok.v === '-' || tok.v === '+' || tok.v === '!'
        if (expectOperand) {
          if (!prefix) return fail(`unexpected operator ${show(tok.v)}`)
        } else {
          if (tok.v === '!') return fail('unexpected operator "!"')
          expectOperand = true
        }
        break
      }
      case 'lp':
        if (!expectOperand) return fail('unexpected "("')
        stack.push(false)
        break
      case 'rp': {
        if (expectOperand) return fail('unexpected ")"')
        if (stack.length === 0) return fail('unbalanced ")"')
        stack.pop()
        expectOperand = false
        break
      }
      case 'comma': {
        if (expectOperand) return fail('unexpected ","')
        // commas are valid inside function calls and IN (a, b) lists
        if (stack.length === 0) return fail('unexpected ","')
        expectOperand = true
        break
      }
    }
  }
  if (stack.length > 0) return fail('unbalanced "("')
  if (expectOperand) return fail('expression ends unexpectedly')
  return { ok: true }
}
