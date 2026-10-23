/**
 * Seam to package A (lexer, splitter, classifier) for package B. Integrated: adapters over
 * src/lib/sql/splitter.ts (`splitStatements`) and src/server/sql/classify.ts (`classifyBatch`), keeping the
 * names and shapes that run.ts uses. The classifier needs `initParser()` once (WASM); `readyClassifier`
 * does it and falls back to "no parser" (every verdict that needs one becomes `parser-off`, never relaxed).
 */
import { splitStatements } from '../../lib/sql/splitter'
import type { ServerInfo } from '../structure/types'
import { classifyBatch as classifyBatchA } from './classify'
import { initParser } from './parser'
import type { ClassifiedStatement, SplitOptions, SplitResult, SqlStatementText } from './types'

export type ClassifyContext = { server: ServerInfo; lex?: SplitOptions }

let parserOk: Promise<boolean> | undefined

/** Initialises the parser once; resolves false when it cannot be loaded. */
export function readyClassifier(): Promise<boolean> {
  parserOk ??= initParser().then(
    () => true,
    () => false,
  )
  return parserOk
}

export function splitSql(text: string, opts: SplitOptions = {}): SplitResult {
  return splitStatements(text, opts)
}

export function classifyBatch(
  statements: SqlStatementText[],
  ctx: ClassifyContext,
  parserAvailable = true,
): ClassifiedStatement[] {
  return classifyBatchA(statements, {
    product: ctx.server.product,
    ...(ctx.lex ? { lex: ctx.lex } : {}),
    ...(parserAvailable ? {} : { parser: null }),
  })
}
