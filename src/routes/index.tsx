import { createFileRoute, redirect } from '@tanstack/react-router'
import { AuthHome, type HomeData } from '~/components/auth/auth-home'
import { applyTheme } from '~/lib/auth/account-logic'
import { authApi } from '~/lib/auth/api'

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

/**
 * Decides between setup (redirect to /setup), direct login or shell, and account-mode sign-in with its session-state
 * guard. With the mock layer on the server render defers: the mock keeps its state in the browser.
 */
export async function loadHome(): Promise<HomeData> {
  if (typeof window === 'undefined' && import.meta.env.VITE_DBLOOM_AUTH_MOCK === 'true') return { kind: 'client' }
  const boot = await authApi().getAuthBoot()
  if (boot.kind === 'setup_pending') throw redirect({ to: '/setup' })
  // The saved theme is applied before the first paint of the app (FR-AUT-024); the head script covers the reload.
  const session = boot.session
  if (typeof document !== 'undefined' && session?.theme && (!('state' in session) || session.state === 'full')) applyTheme(session.theme)
  return boot
}

export const Route = createFileRoute('/')({
  validateSearch: parseOpenSearch,
  loader: () => loadHome(),
  component: Home,
})

function Home() {
  const boot = Route.useLoaderData()
  const open = Route.useSearch()
  return <AuthHome boot={boot} open={open} />
}
