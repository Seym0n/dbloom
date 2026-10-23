/**
 * MySQL / MariaDB lexer (FR-SQL-003, spec 5.2). Pure TypeScript, linear time, no Node imports: shared
 * by the browser (statement at cursor, highlighting) and the server (split, classify, redact).
 *
 * The token stream is lossless: concatenating the text of all tokens reproduces the input. Executable
 * comments (`/*!`, `/*M!`) are one token whose content is exposed by `execInner`, scanned like the
 * server does (strings and line comments inside it are honoured), so a `*` + `/` inside a string
 * does not end it.
 */

export type TokenType =
  | 'ws'
  | 'lineComment'
  | 'blockComment'
  | 'execComment'
  | 'string'
  | 'quotedIdent'
  | 'word'
  | 'variable'
  | 'number'
  | 'op'
  | 'delimiter'

export type Token = {
  type: TokenType
  start: number
  end: number
  /** Quoted or comment token that reached the end of input without its closing part. */
  unterminated?: boolean
  /** For `execComment`: range of the content between the opener (with version digits) and `*` + `/`. */
  inner?: { start: number; end: number }
}

export type LexOptions = {
  noBackslashEscapes?: boolean
  ansiQuotes?: boolean
}

export type LexError = { code: 'unterminated-string' | 'unterminated-comment'; at: number }

export type LexResult = { tokens: Token[]; errors: LexError[] }

function isWs(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13)
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/** Identifier characters as the server sees them: ASCII letters, digits, `_`, `$` and every non-ASCII code unit. */
export function isWordChar(c: number): boolean {
  return (
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || isDigit(c) || c === 95 || c === 36 || c >= 128
  )
}

/** `--` starts a comment only when followed by whitespace, a control character or the end of input. */
function dashComment(input: string, i: number): boolean {
  if (input.charCodeAt(i) !== 45 || input.charCodeAt(i + 1) !== 45) return false
  if (i + 2 >= input.length) return true
  const c = input.charCodeAt(i + 2)
  return isWs(c) || c < 32 || c === 127
}

/** Index after the closing quote, or -1 when unterminated. Doubled quotes stay inside the token. */
function scanQuoted(input: string, from: number, quote: number, backslash: boolean): number {
  let i = from + 1
  const n = input.length
  while (i < n) {
    const c = input.charCodeAt(i)
    if (c === 92 && backslash && quote !== 96) {
      i += 2
      continue
    }
    if (c === quote) {
      if (input.charCodeAt(i + 1) === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return -1
}

/** End (exclusive) of a line comment starting at `from`: before the newline. */
function scanLine(input: string, from: number): number {
  const n = input.length
  let i = from
  while (i < n) {
    const c = input.charCodeAt(i)
    if (c === 10 || c === 13) break
    i++
  }
  return i
}

/**
 * Scan the content of an executable comment from `from`; returns the index of the closing `*` + `/` or -1.
 * Strings, quoted identifiers, line comments and plain block comments inside are skipped like the server does.
 */
function scanExecEnd(input: string, from: number, o: LexOptions): number {
  const n = input.length
  const bs = !o.noBackslashEscapes
  let i = from
  while (i < n) {
    const c = input.charCodeAt(i)
    if (c === 42 && input.charCodeAt(i + 1) === 47) return i
    if (c === 39 || c === 96 || c === 34) {
      const e = scanQuoted(input, i, c, bs)
      if (e < 0) return -1
      i = e
    } else if (c === 35 || dashComment(input, i)) {
      i = scanLine(input, i)
    } else if (c === 47 && input.charCodeAt(i + 1) === 42) {
      const e = input.indexOf('*/', i + 2)
      if (e < 0) return -1
      i = e + 2
    } else {
      i++
    }
  }
  return -1
}

/** Scan one token at `i` (`i < input.length`). A `delimiter` is recognised before everything else. */
export function scanToken(input: string, i: number, o: LexOptions = {}, delimiter?: string): Token {
  const n = input.length
  const bs = !o.noBackslashEscapes
  const c = input.charCodeAt(i)
  const start = i
  const atDelim = (p: number): boolean => delimiter !== undefined && input.startsWith(delimiter, p)
  if (delimiter !== undefined && atDelim(i)) {
    return { type: 'delimiter', start, end: i + delimiter.length }
  }
  if (isWs(c)) {
    i++
    while (i < n && isWs(input.charCodeAt(i))) i++
    return { type: 'ws', start, end: i }
  }
  if (c === 35 || dashComment(input, i)) {
    return { type: 'lineComment', start, end: scanLine(input, i) }
  }
  if (c === 47 && input.charCodeAt(i + 1) === 42) {
    const c2 = input.charCodeAt(i + 2)
    if (c2 === 33 || (c2 === 77 && input.charCodeAt(i + 3) === 33)) {
      let p = i + (c2 === 33 ? 3 : 4)
      while (p < n && isDigit(input.charCodeAt(p))) p++
      const e = scanExecEnd(input, p, o)
      if (e < 0) {
        return {
          type: 'execComment',
          start,
          end: n,
          unterminated: true,
          inner: { start: p, end: n },
        }
      }
      return { type: 'execComment', start, end: e + 2, inner: { start: p, end: e } }
    }
    const e = input.indexOf('*/', i + 2)
    if (e < 0) return { type: 'blockComment', start, end: n, unterminated: true }
    return { type: 'blockComment', start, end: e + 2 }
  }
  if (c === 39 || c === 34 || c === 96) {
    const e = scanQuoted(input, i, c, bs)
    const type: TokenType = c === 96 || (c === 34 && o.ansiQuotes) ? 'quotedIdent' : 'string'
    if (e < 0) return { type, start, end: n, unterminated: true }
    return { type, start, end: e }
  }
  if (c === 64) {
    i++
    while (i < n && input.charCodeAt(i) === 64) i++
    while (
      i < n &&
      !atDelim(i) &&
      (isWordChar(input.charCodeAt(i)) || input.charCodeAt(i) === 46)
    ) {
      i++
    }
    return { type: 'variable', start, end: i }
  }
  if (isDigit(c) || (c === 46 && isDigit(input.charCodeAt(i + 1)))) {
    i++
    while (
      i < n &&
      !atDelim(i) &&
      (isWordChar(input.charCodeAt(i)) || input.charCodeAt(i) === 46)
    ) {
      i++
    }
    return { type: 'number', start, end: i }
  }
  if (isWordChar(c)) {
    i++
    while (i < n && !atDelim(i) && isWordChar(input.charCodeAt(i))) i++
    return { type: 'word', start, end: i }
  }
  return { type: 'op', start, end: i + 1 }
}

/** Error of an unterminated token, if any. */
export function tokenError(t: Token): LexError | undefined {
  if (!t.unterminated) return undefined
  const str = t.type === 'string' || t.type === 'quotedIdent'
  return { code: str ? 'unterminated-string' : 'unterminated-comment', at: t.start }
}

/** Lossless tokenisation. Unterminated constructs end at the end of input and are reported in `errors`. */
export function tokenize(input: string, o: LexOptions = {}): LexResult {
  const tokens: Token[] = []
  const errors: LexError[] = []
  let i = 0
  while (i < input.length) {
    const t = scanToken(input, i, o)
    const e = tokenError(t)
    if (e) errors.push(e)
    tokens.push(t)
    i = t.end
  }
  return { tokens, errors }
}

/** A significant token with executable comments flattened into their content. */
export type CodeToken = {
  type: 'word' | 'variable' | 'number' | 'string' | 'quotedIdent' | 'op'
  text: string
  /** Upper-case text for words, variables; the raw text otherwise. */
  upper: string
  start: number
  end: number
  /** The token came from inside an executable comment. */
  fromExec: boolean
}

export type CodeTokens = {
  tokens: CodeToken[]
  /** The text contained an executable comment. */
  hasExec: boolean
  /** An executable comment contains a nested comment opener: the server and this lexer may disagree. */
  execNested: boolean
  errors: LexError[]
}

/**
 * Significant tokens of one statement: whitespace and comments dropped, executable comments inlined
 * (also `/*M!` on MySQL, where the server ignores it: reading it as code only asks more often).
 */
export function codeTokens(text: string, o: LexOptions = {}): CodeTokens {
  const out: CodeToken[] = []
  const errors: LexError[] = []
  let hasExec = false
  let execNested = false
  const walk = (src: string, offset: number, fromExec: boolean): void => {
    const r = tokenize(src, o)
    for (const e of r.errors) errors.push({ code: e.code, at: e.at + offset })
    for (const t of r.tokens) {
      if (t.type === 'ws' || t.type === 'lineComment' || t.type === 'blockComment') continue
      if (t.type === 'delimiter') continue
      if (t.type === 'execComment') {
        hasExec = true
        const inner = t.inner as { start: number; end: number }
        const content = src.slice(inner.start, inner.end)
        if (content.includes('/*')) execNested = true
        walk(content, offset + inner.start, true)
        continue
      }
      const raw = src.slice(t.start, t.end)
      out.push({
        type: t.type,
        text: raw,
        upper: t.type === 'word' || t.type === 'variable' ? raw.toUpperCase() : raw,
        start: offset + t.start,
        end: offset + t.end,
        fromExec,
      })
    }
  }
  walk(text, 0, false)
  return { tokens: out, hasExec, execNested, errors }
}
