/**
 * Statement splitter (FR-SQL-003, spec 5.2). Pure TypeScript, linear time, shared by browser and server.
 *
 * Statements are slices of the input from the first non-blank character (a leading comment counts) to the
 * last non-blank character before the delimiter. The mysql-client command `DELIMITER <token>` is honoured
 * at the start of a line when no statement text has started; it is not part of any statement.
 */
import type {
  SplitError,
  SplitOptions,
  SplitResult,
  SqlStatementText,
} from '../../server/sql/types'
import { codeTokens, scanToken, tokenError } from './lexer'

const DEFAULT_DELIMITER = ';'

function atLineStart(input: string, i: number): boolean {
  let p = i - 1
  while (p >= 0) {
    const c = input.charCodeAt(p)
    if (c === 10 || c === 13) return true
    if (c !== 32 && c !== 9) return false
    p--
  }
  return true
}

type DelimiterCommand = { delimiter: string; next: number }

/** Parse `DELIMITER <token>` whose keyword token ends at `from`; undefined when it is not a valid command. */
function parseDelimiterCommand(input: string, from: number): DelimiterCommand | undefined {
  const n = input.length
  let eol = from
  while (eol < n && input.charCodeAt(eol) !== 10 && input.charCodeAt(eol) !== 13) eol++
  const line = input.slice(from, eol)
  const m = /^[ \t]+(\S+)(.*)$/s.exec(line)
  if (!m) return undefined
  const arg = m[1] as string
  const rest = (m[2] as string).trim()
  if (/[\\'"`]/.test(arg)) return undefined
  if (arg.startsWith('--') || arg.startsWith('#') || arg.startsWith('/*')) return undefined
  if (rest !== '' && !/^(--[ \t]|#|\/\*)/.test(rest)) return undefined
  let next = eol
  if (input.charCodeAt(next) === 13 && input.charCodeAt(next + 1) === 10) next += 2
  else if (next < n) next++
  return { delimiter: arg, next }
}

export function splitStatements(input: string, options: SplitOptions = {}): SplitResult {
  const statements: SqlStatementText[] = []
  const errors: SplitError[] = []
  const lex = { noBackslashEscapes: options.noBackslashEscapes, ansiQuotes: options.ansiQuotes }
  let delimiter =
    options.delimiter && options.delimiter.length > 0 ? options.delimiter : DEFAULT_DELIMITER
  const n = input.length

  let start = -1
  let lastEnd = -1
  let codeSeen = false
  let firstKeyword = ''
  let exec = false

  const reset = (): void => {
    start = -1
    lastEnd = -1
    codeSeen = false
    firstKeyword = ''
    exec = false
  }
  const emit = (): void => {
    if (start < 0) return
    statements.push({
      text: input.slice(start, lastEnd),
      start,
      end: lastEnd,
      firstKeyword,
      flags: { executableComment: exec, empty: !codeSeen },
    })
    reset()
  }

  let i = 0
  while (i < n) {
    const t = scanToken(input, i, lex, delimiter)
    const err = tokenError(t)
    if (err) errors.push(err)
    i = t.end
    if (t.type === 'ws') continue
    if (t.type === 'delimiter') {
      emit()
      continue
    }
    if (
      t.type === 'word' &&
      !codeSeen &&
      t.end - t.start === 9 &&
      input.slice(t.start, t.end).toUpperCase() === 'DELIMITER' &&
      atLineStart(input, t.start)
    ) {
      const cmd = parseDelimiterCommand(input, t.end)
      if (cmd) {
        reset()
        delimiter = cmd.delimiter
        i = cmd.next
        continue
      }
    }
    if (start < 0) start = t.start
    lastEnd = t.end
    if (t.type === 'lineComment' || t.type === 'blockComment') continue
    if (t.type === 'execComment') {
      exec = true
      const inner = t.inner as { start: number; end: number }
      const ct = codeTokens(input.slice(inner.start, inner.end), lex).tokens
      const first = ct[0]
      if (first) {
        codeSeen = true
        if (firstKeyword === '') firstKeyword = first.upper.toUpperCase()
      }
      continue
    }
    codeSeen = true
    if (firstKeyword === '') firstKeyword = input.slice(t.start, t.end).toUpperCase()
  }
  emit()
  return { statements, errors }
}

/** The statement containing `offset`, or the last one that ended before it (editor "statement at cursor"). */
export function statementAt(
  statements: SqlStatementText[],
  offset: number,
): SqlStatementText | undefined {
  let found: SqlStatementText | undefined
  for (const s of statements) {
    if (s.start <= offset) found = s
    if (offset <= s.end) break
  }
  return found
}
