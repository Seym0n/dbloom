import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { sessionMiddleware } from './middleware'
import {
  cancelSqlImpl,
  confirmSqlImpl,
  deleteBookmarkImpl,
  deleteHistoryImpl,
  envOf,
  estimateAffectedImpl,
  explainSqlImpl,
  getCompletionSchemaImpl,
  getSqlLimitsImpl,
  listBookmarksImpl,
  listHistoryImpl,
  planAnalyseImpl,
  parseCancelInput,
  parseCompletionInput,
  parseConfirmInput,
  parseDeleteBookmarkInput,
  parseDeleteHistoryInput,
  parseEstimateInput,
  parseExplainInput,
  parseListHistoryInput,
  parsePlanAnalyseInput,
  parseRenameBookmarkInput,
  parseRunInput,
  parseSaveBookmarkInput,
  renameBookmarkImpl,
  runSqlImpl,
  saveBookmarkImpl,
} from './sql/service'
import type {
  Bookmark,
  CancelSqlInput,
  CompletionSchema,
  CompletionSchemaInput,
  ConfirmSqlInput,
  DeleteHistoryInput,
  EstimateAffectedInput,
  ExplainSqlInput,
  HistoryEntry,
  ListHistoryInput,
  PlanAnalyseInput,
  RunSqlInput,
  SaveBookmarkInput,
  SqlEstimateResponse,
  SqlExplainResponse,
  SqlLimitsResponse,
  SqlRunResponse,
} from './sql/types'

// Only server functions live here; logic is in sql/service.ts. Every export calls createServerFn directly: the TanStack compiler
// only strips handlers (and their node-only imports) from the client bundle when it can see that call.

export const runSql = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: RunSqlInput) => parseRunInput(raw))
  .handler(({ context, data }): Promise<SqlRunResponse> =>
    runSqlImpl(envOf(context.session, getRequest().signal), data),
  )

export const confirmSql = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ConfirmSqlInput) => parseConfirmInput(raw))
  .handler(({ context, data }): Promise<SqlRunResponse> =>
    confirmSqlImpl(envOf(context.session, getRequest().signal), data),
  )

export const cancelSql = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: CancelSqlInput) => parseCancelInput(raw))
  .handler(({ context, data }): Promise<{ ok: true }> =>
    cancelSqlImpl(envOf(context.session), data),
  )

export const explainSql = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ExplainSqlInput) => parseExplainInput(raw))
  .handler(({ context, data }): Promise<SqlExplainResponse> =>
    explainSqlImpl(envOf(context.session, getRequest().signal), data),
  )

export const planAnalyseSql = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: PlanAnalyseInput) => parsePlanAnalyseInput(raw))
  .handler(({ context, data }): Promise<Extract<SqlRunResponse, { kind: 'confirm' }>> =>
    planAnalyseImpl(envOf(context.session), data),
  )

export const estimateAffected = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: EstimateAffectedInput) => parseEstimateInput(raw))
  .handler(({ context, data }): Promise<SqlEstimateResponse> =>
    estimateAffectedImpl(envOf(context.session), data),
  )

export const listHistory = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: ListHistoryInput) => parseListHistoryInput(raw))
  .handler(
    ({
      context,
      data,
    }): Promise<{ entries: HistoryEntry[]; nextCursor: number | null; stateless: boolean }> =>
      listHistoryImpl(envOf(context.session), data),
  )

export const deleteHistory = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: DeleteHistoryInput) => parseDeleteHistoryInput(raw))
  .handler(({ context, data }): Promise<{ deleted: number }> =>
    deleteHistoryImpl(envOf(context.session), data),
  )

export const saveBookmark = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: SaveBookmarkInput) => parseSaveBookmarkInput(raw))
  .handler(({ context, data }): Promise<Bookmark> => saveBookmarkImpl(envOf(context.session), data))

export const listBookmarks = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): Promise<{ bookmarks: Bookmark[]; stateless: boolean }> =>
    listBookmarksImpl(envOf(context.session)),
  )

export const renameBookmark = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: { id: string; name: string }) => parseRenameBookmarkInput(raw))
  .handler(({ context, data }): Promise<Bookmark> =>
    renameBookmarkImpl(envOf(context.session), data),
  )

export const deleteBookmark = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: { id: string }) => parseDeleteBookmarkInput(raw))
  .handler(({ context, data }): Promise<{ ok: true }> =>
    deleteBookmarkImpl(envOf(context.session), data),
  )

export const getCompletionSchema = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .validator((raw: CompletionSchemaInput) => parseCompletionInput(raw))
  .handler(({ context, data }): Promise<CompletionSchema> =>
    getCompletionSchemaImpl(envOf(context.session), data),
  )

export const getSqlLimits = createServerFn({ method: 'POST' })
  .middleware([sessionMiddleware])
  .handler(({ context }): SqlLimitsResponse => getSqlLimitsImpl(envOf(context.session)))
