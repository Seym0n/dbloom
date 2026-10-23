export class InvalidIdentifierError extends Error {
  constructor() {
    super('Invalid name')
    this.name = 'InvalidIdentifierError'
  }
}

/** The one place that quotes identifiers (SEC-TGT-117). Names should come from the server (SEC-TGT-116) first. */
export function quoteIdent(name: string): string {
  if (name === '' || name.length > 64 || name.includes('\u0000')) throw new InvalidIdentifierError()
  return '`' + name.replaceAll('`', '``') + '`'
}
