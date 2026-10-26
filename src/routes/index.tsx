import { createFileRoute } from '@tanstack/react-router'
import { LoginPage } from '~/components/login-page'
import { AppShell } from '~/components/shell/app-shell'
import { getSessionInfo } from '~/server/session.functions'

/**
 * Link into a table (FR-ROW-014): database, table and an optional key filter as [column, value] pairs.
 * The router encodes every name once; nothing here is a filter expression, only equalities.
 */
export type OpenSearch = { db?: string; table?: string; key?: [string, string][] }

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

export function parseOpenSearch(search: Record<string, unknown>): OpenSearch {
  const db = text(search.db)
  const table = text(search.table)
  const key = Array.isArray(search.key)
    ? search.key
        .filter(
          (pair): pair is [string, string] =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            typeof pair[0] === 'string' &&
            typeof pair[1] === 'string',
        )
        .slice(0, 16)
    : undefined
  return {
    ...(db && table ? { db, table } : {}),
    ...(db && table && key && key.length > 0 ? { key } : {}),
  }
}

export const Route = createFileRoute('/')({
  validateSearch: parseOpenSearch,
  loader: () => getSessionInfo(),
  component: Home,
})

function Home() {
  const session = Route.useLoaderData()
  const open = Route.useSearch()
  return session ? <AppShell session={session} open={open} /> : <LoginPage />
}
