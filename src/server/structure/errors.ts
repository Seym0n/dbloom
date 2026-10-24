import type { StructureError } from './types'

/** Closed hint table keyed by errno (FR-STR-013). Text is English; i18n keys come later. */
const HINTS: Record<number, string> = {
  1044: 'Your account lacks a privilege for this action.',
  1142: 'Your account lacks a privilege for this action.',
  1143: 'Your account lacks a privilege for this action.',
  1227: 'Your account lacks a privilege for this action.',
  1050: 'A table with this name already exists.',
  1051: 'The table does not exist.',
  1146: 'The table does not exist.',
  1054: 'A column named in the statement does not exist.',
  1062: 'A duplicate value violates a unique key.',
  1064: 'The server could not parse the statement. A procedure, trigger or event with several statements needs a DELIMITER command around it.',
  1091: 'The column, key or constraint to drop does not exist.',
  1215: 'The foreign key could not be created; check that the columns and types match and that the referenced columns are indexed.',
  1216: 'A foreign key constraint blocks this change (a referenced row is missing).',
  1217: 'A foreign key constraint blocks this change (rows still reference this one).',
  1451: 'Other rows still reference this table or row through a foreign key.',
  1452: 'A foreign key constraint blocks this change (a referenced row is missing).',
  1553: 'This index is needed by a foreign key; drop the foreign key first.',
  1822: 'The foreign key needs an index on the referenced columns.',
  1825: 'The foreign key could not be created; check that the columns and types match and that the referenced columns are indexed.',
  1826: 'A foreign key with this name already exists in the database.',
  1828: 'This column is used by a foreign key; drop the foreign key first.',
  1829: 'This column is used by a foreign key; drop the foreign key first.',
  1830: 'This column cannot be NOT NULL because a foreign key sets it to NULL.',
  1832: 'This column is used by a foreign key; its type cannot be changed this way.',
  1833: 'This column is used by a foreign key; its type cannot be changed this way.',
  1834: 'Other tables reference this one through a foreign key; rows cannot be removed this way.',
  3730: 'Other tables reference this table through a foreign key; drop those foreign keys first or ignore foreign key checks for this statement.',
  3734: 'The foreign key could not be created; a column it names is missing.',
  3780: 'The foreign key columns and the referenced columns have incompatible types.',
  1005: 'The table could not be created; see the server message for the reason.',
  3819: 'A CHECK constraint is violated.',
  4025: 'A CHECK constraint is violated.',
  1205: 'The statement waited too long for a lock held by another connection.',
  1213: 'The server rolled the statement back because of a deadlock; try again.',
  3024: 'The statement ran longer than the time limit and was stopped.',
  1317: 'The statement was stopped before it finished.',
  1235: 'This version of the server does not support this statement or option.',
  1290: 'The server runs with an option (such as read-only) that forbids this statement.',
  1792: 'The connection is read-only; the statement would change data.',
  1969: 'The statement ran longer than the time limit and was stopped.',
  1699: 'The statement needs a privilege or option that this server does not give.',
}

/**
 * Slot for the hints of module rows (FR-ROW-025: 1048, 1264, 1292, 1366, 1406, 3105, 3140 and wording for
 * 1062, 1216, 1217, 1451, 1452, 1054). Empty after task 0; work package B fills it. `HINTS` wins on a clash.
 */
export const ROW_HINTS: Record<number, string> = {
  1048: 'This column cannot be empty (NULL); enter a value.',
  1264: 'The value is outside the range of the column type.',
  1292: 'The value is not valid for the column type.',
  1366: 'The value is not valid for the column type or its character set.',
  1406: 'The value is longer than the column allows.',
  3105: 'This column is generated; its value cannot be written.',
  3140: 'The text is not valid JSON.',
}

/** The uniform text for everything that is not a server reply (connection, TLS, driver). */
export const CONNECTION_MESSAGE = 'Could not connect to the server'

type DriverError = {
  errno?: unknown
  code?: unknown
  sqlMessage?: unknown
  message?: unknown
}

/**
 * Maps a driver error to the shape the client may see. Never serialises the raw object: no stack,
 * no `sql` field, no connection details (SEC-TGT-023, SEC-TGT-112).
 */
export function mapMysqlError(error: unknown, statementIndex?: number): StructureError {
  void statementIndex
  const e: DriverError = typeof error === 'object' && error !== null ? (error as DriverError) : {}
  const code = typeof e.code === 'string' ? e.code : 'UNKNOWN'
  if (typeof e.sqlMessage === 'string' && typeof e.errno === 'number' && e.errno > 0) {
    const hint = HINTS[e.errno] ?? ROW_HINTS[e.errno]
    return { errno: e.errno, code, message: e.sqlMessage, ...(hint ? { hint } : {}) }
  }
  // Timeouts raised by the guard carry their own code; everything else is a connection-level failure.
  if (code === 'timeout' || code === 'STATEMENT_TIMEOUT') {
    return { errno: 3024, code, message: 'Statement timed out', hint: HINTS[3024] }
  }
  return { errno: null, code, message: CONNECTION_MESSAGE }
}

/** Refusals raised by this module before or around execution (stable `code`, safe message). */
export class StructureRefusal extends Error {
  constructor(
    public code: string,
    message: string,
    /** Offset into the submitted text (lexical refusals of the SQL tab); sent as `code@offset`. */
    public at?: number,
  ) {
    super(message)
    this.name = 'StructureRefusal'
  }
}

/** The plain-Error form the client sees: `code: message`, same style as `session_ended`. */
export function toClientError(error: unknown): Error {
  if (error instanceof StructureRefusal) {
    const at = error.at !== undefined ? `@${error.at}` : ''
    return new Error(`${error.code}${at}: ${error.message}`)
  }
  if (error instanceof Error && typeof (error as unknown as { code?: unknown }).code === 'string') {
    const { code } = error as unknown as { code: string }
    if (error.name === 'BuildRefusal' || error.name === 'WriteGuardError') {
      return new Error(`${code}: ${error.message}`)
    }
  }
  return error instanceof Error ? error : new Error('unexpected_error')
}

/**
 * Position of a server syntax error in the user's text (FR-SQL-012). The server reports `near '...' at line N`
 * (MySQL and MariaDB); the result is the absolute line and column in `fullText` (1-based) and the absolute
 * `offset`, computed from `statementStart`. Without a recognisable position it is the first character of
 * the statement. The SQL runner converts it with `relativePosition` before it reaches the client.
 */
export function positionOf(
  sqlMessage: string,
  statementStart: number,
  fullText: string,
): { line: number; column: number; offset: number } {
  const m = /at line (\d+)\s*$/.exec(sqlMessage)
  const rel = m ? Math.max(1, Number(m[1])) : 1
  // Offset of the first character of line `rel` of the statement.
  let offset = statementStart
  for (let seen = 1; seen < rel; offset++) {
    if (offset >= fullText.length) break
    if (fullText[offset] === '\n') seen++
  }
  // `near '...'`: the quoted text starts at the error; find it on that line when possible.
  const near = /near '([\s\S]*?)' at line/.exec(sqlMessage)
  if (near && near[1]) {
    const lineEnd = fullText.indexOf('\n', offset)
    const hay = fullText.slice(offset, lineEnd < 0 ? undefined : lineEnd)
    const first = near[1].split('\n')[0]!
    const at = hay.indexOf(first)
    if (at >= 0) offset += at
  }
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset && i < fullText.length; i++) {
    if (fullText[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: offset - lineStart + 1, offset }
}

/** Line and column of `offset` relative to the statement that starts at `statementStart` (both 1-based). */
export function relativePosition(
  fullText: string,
  statementStart: number,
  offset: number,
): { line: number; column: number } {
  const before = fullText.slice(statementStart, Math.max(statementStart, offset))
  const lastNl = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: before.length - (lastNl + 1) + 1,
  }
}
