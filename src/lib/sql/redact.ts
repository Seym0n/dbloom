/**
 * Token-based redaction of secret literals (ST-128, FR-SQL-017, spec 5.10). Applied to history and
 * bookmark text and to any log field; fixed in code. It works on the lexer's tokens, so text inside
 * comments or longer strings is never mistaken for a keyword. It errs on the side of redacting too much
 * (`WHERE password = 'x'` loses the literal too).
 *
 * Redacted: string literals after `IDENTIFIED ...` (BY, WITH ... BY/AS, VIA ... USING/AS, BY PASSWORD),
 * `PASSWORD(...)`, `OLD_PASSWORD(...)`, `... PASSWORD = '...'` (also MASTER_PASSWORD, SOURCE_PASSWORD,
 * `SET PASSWORD [FOR u] = '...'`), `PASSWORD '...'`, and the key arguments of AES_ENCRYPT, AES_DECRYPT,
 * ENCODE, DECODE, DES_ENCRYPT, DES_DECRYPT.
 */
import { codeTokens, type CodeToken, type LexOptions } from './lexer'

export const REDACTED = "'***'"

const KEY_FUNCTIONS: ReadonlySet<string> = new Set([
  'AES_ENCRYPT',
  'AES_DECRYPT',
  'ENCODE',
  'DECODE',
  'DES_ENCRYPT',
  'DES_DECRYPT',
])

const IDENTIFIED_STOP: ReadonlySet<string> = new Set([
  'REQUIRE',
  'ACCOUNT',
  'COMMENT',
  'ATTRIBUTE',
  'DEFAULT',
  'FAILED_LOGIN_ATTEMPTS',
  'PASSWORD_LOCK_TIME',
])

function isOp(t: CodeToken | undefined, s: string): boolean {
  return t !== undefined && t.type === 'op' && t.text === s
}

function markIdentified(toks: CodeToken[], from: number, mark: Set<number>): void {
  for (let j = from + 1; j < toks.length; j++) {
    const t = toks[j] as CodeToken
    if (isOp(t, ',') || isOp(t, ';')) return
    if (t.type === 'word') {
      if (IDENTIFIED_STOP.has(t.upper)) return
      if (t.upper === 'PASSWORD' && toks[j + 1]?.type === 'word') return
      if (t.upper === 'IDENTIFIED' && j !== from) return
    }
    if (t.type === 'string') mark.add(j)
  }
}

function markParenArgs(toks: CodeToken[], open: number, firstArg: number, mark: Set<number>): void {
  let depth = 0
  let arg = 0
  for (let j = open; j < toks.length; j++) {
    const t = toks[j] as CodeToken
    if (isOp(t, '(')) depth++
    else if (isOp(t, ')')) {
      depth--
      if (depth <= 0) return
    } else if (depth === 1 && isOp(t, ',')) arg++
    else if (t.type === 'string' && arg >= firstArg) mark.add(j)
  }
}

function markPasswordWord(toks: CodeToken[], i: number, mark: Set<number>): void {
  const next = toks[i + 1]
  if (next === undefined) return
  if (isOp(next, '(')) {
    markParenArgs(toks, i + 1, 0, mark)
    return
  }
  if (next.type === 'string') {
    mark.add(i + 1)
    return
  }
  if (isOp(next, '=') || (next.type === 'op' && next.text === ':' && isOp(toks[i + 2], '='))) {
    const v = toks[isOp(next, '=') ? i + 2 : i + 3]
    if (v?.type === 'string') mark.add(isOp(next, '=') ? i + 2 : i + 3)
    return
  }
  // SET PASSWORD FOR user[@host] = ...
  if (next.type === 'word' && next.upper === 'FOR') {
    for (let j = i + 2; j < Math.min(toks.length, i + 14); j++) {
      const t = toks[j] as CodeToken
      if (isOp(t, ';')) return
      if (isOp(t, '=')) {
        if (toks[j + 1]?.type === 'string') mark.add(j + 1)
        return
      }
    }
  }
}

/** Replace secret literals by `'***'`. Returns null when redaction cannot be trusted (caller stores no text). */
export function redactSql(text: string, options: LexOptions = {}): string | null {
  try {
    const { tokens: toks } = codeTokens(text, options)
    const mark = new Set<number>()
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] as CodeToken
      if (t.type !== 'word') continue
      const u = t.upper
      if (u === 'IDENTIFIED') markIdentified(toks, i, mark)
      else if (u === 'PASSWORD' || u === 'OLD_PASSWORD' || u.endsWith('_PASSWORD'))
        markPasswordWord(toks, i, mark)
      else if (KEY_FUNCTIONS.has(u) && isOp(toks[i + 1], '(')) markParenArgs(toks, i + 1, 1, mark)
    }
    if (mark.size === 0) return text
    const ranges = [...mark].map((k) => toks[k] as CodeToken).sort((a, b) => a.start - b.start)
    let out = ''
    let pos = 0
    for (const r of ranges) {
      if (r.start < pos) continue
      out += text.slice(pos, r.start) + REDACTED
      pos = r.end
    }
    out += text.slice(pos)
    return out
  } catch {
    return null
  }
}
