import { useState, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Outlet, createRootRoute, HeadContent, Scripts } from '@tanstack/react-router'
import { createQueryClient } from '~/lib/session-state'
import { THEME_STORAGE_KEY } from '~/lib/auth/account-logic'
import appCss from '~/styles.css?url'

const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'DBLoom' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
    // Last chosen theme, set before the first paint (the session info corrects it once it arrives).
    scripts: [{ children: THEME_BOOT_SCRIPT }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const [queryClient] = useState(createQueryClient)
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}
