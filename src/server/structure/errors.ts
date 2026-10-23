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
  1064: 'The server could not parse the statement.',
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
    const hint = HINTS[e.errno]
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
  ) {
    super(message)
    this.name = 'StructureRefusal'
  }
}

/** The plain-Error form the client sees: `code: message`, same style as `session_ended`. */
export function toClientError(error: unknown): Error {
  if (error instanceof StructureRefusal) return new Error(`${error.code}: ${error.message}`)
  if (error instanceof Error && typeof (error as unknown as { code?: unknown }).code === 'string') {
    const { code } = error as unknown as { code: string }
    if (error.name === 'BuildRefusal' || error.name === 'WriteGuardError') {
      return new Error(`${code}: ${error.message}`)
    }
  }
  return error instanceof Error ? error : new Error('unexpected_error')
}
