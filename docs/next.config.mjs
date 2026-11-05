import nextra from 'nextra'

const withNextra = nextra({
  contentDirBasePath: '/docs',
  search: { codeblocks: false },
})

// GitHub Pages serves a project site under /<repo>; the workflow sets NEXT_PUBLIC_BASE_PATH=/dbloom. Empty locally.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export default withNextra({
  reactStrictMode: true,
  agentRules: false,
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  ...(basePath ? { basePath } : {}),
})
