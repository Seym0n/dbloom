import { createFileRoute } from '@tanstack/react-router'
import { LoginPage } from '~/components/login-page'
import { AppShell } from '~/components/shell/app-shell'
import { getSessionInfo } from '~/server/session.functions'

export const Route = createFileRoute('/')({
  loader: () => getSessionInfo(),
  component: Home,
})

function Home() {
  const session = Route.useLoaderData()
  return session ? <AppShell session={session} /> : <LoginPage />
}
