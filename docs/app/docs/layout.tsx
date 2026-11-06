import type { ReactNode } from 'react'
import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
const logo = (
  <>
    <img className="logo-on-light" src={`${BASE}/logo-dark-text.svg`} alt="DBLoom" height="22" width="100" />
    <img className="logo-on-dark" src={`${BASE}/logo.svg`} alt="DBLoom" height="22" width="100" />
  </>
)
const navbar = <Navbar logo={logo} projectLink="https://github.com/Seym0n/dbloom" />
const footer = <Footer>DBLoom documentation. Self-hosted, on your own infrastructure.</Footer>

export default async function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Head />
      <Layout
        navbar={navbar}
        footer={footer}
        pageMap={await getPageMap('/docs')}
        docsRepositoryBase="https://github.com/Seym0n/dbloom/tree/main/docs/content"
        editLink="Edit this page on GitHub"
        sidebar={{ defaultMenuCollapseLevel: 1 }}
      >
        {children}
      </Layout>
    </>
  )
}
