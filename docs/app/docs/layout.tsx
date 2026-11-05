import type { ReactNode } from 'react'
import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

const navbar = <Navbar logo={<b style={{ letterSpacing: '-0.03em' }}>DBLoom</b>} projectLink="https://github.com/Seym0n/dbloom" />
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
