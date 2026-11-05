// FR-SVR-019: the variable table of docs-temp/deploy.md is generated from src/server/env-registry.ts.
//   node scripts/gen-env-docs.mjs          rewrite the table between the markers
//   node scripts/gen-env-docs.mjs --check  exit 1 when docs-temp/deploy.md is out of date (CI)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const START = '<!-- env-table:start -->'
const END = '<!-- env-table:end -->'
const DOC = 'docs-temp/deploy.md'
const PAGE = 'docs/content/reference/environment.mdx'

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderTable(vars) {
  const rows = ['| Variable | Need | Type | Default | Description |', '|---|---|---|---|---|']
  const need = (e) => {
    if (e.need === 'required') return `**required**${e.needWhen ? ` (${cell(e.needWhen)})` : ''}`
    if (e.need === 'conditional') return `conditional${e.needWhen ? ` (${cell(e.needWhen)})` : ''}`
    return 'optional'
  }
  let group = ''
  for (const e of vars) {
    if (e.group !== group) {
      group = e.group
      rows.push(`| **${cell(group)}** | | | | |`)
    }
    const range =
      e.min !== undefined && e.max !== undefined
        ? ` (${e.min} to ${e.max})`
        : e.values
          ? ` (${e.values.join(', ')})`
          : ''
    rows.push(
      `| \`${e.name}\` | ${need(e)} | ${e.kind}${range} | ${e.default ? `\`${cell(e.default)}\`` : ''} | ${cell(e.doc)} |`,
    )
  }
  return rows.join('\n')
}

const mdx = (text) =>
  String(text)
    .replace(/[{}]/g, (c) => '\\' + c)
    .replace(/</g, '&lt;')

/** The same table as a Nextra page (MDX: braces and angle brackets in prose are escaped). */
export function renderPage(vars) {
  const table = renderTable(
    vars.map((e) => ({ ...e, doc: mdx(e.doc), needWhen: e.needWhen && mdx(e.needWhen) })),
  )
  return `# Environment variables

Every setting DBLoom reads from the environment. Only two are needed to start the Docker image: \`DBLOOM_PUBLIC_ORIGIN\` and \`DBLOOM_TRUST_PROXY\`. Use the [setup guide](/docs/setup) to build a \`.env\` for your case.

The **Need** column: **required** means startup is refused without it (under the condition named); **conditional** means it is needed only in the mode named, often one of two variables; **optional** means there is a default or the feature stays off.

This page is generated from the program's own variable registry. Do not edit it by hand.

${table}
`
}

export function replaceTable(doc, table) {
  const a = doc.indexOf(START)
  const b = doc.indexOf(END)
  if (a < 0 || b < a) throw new Error(`${DOC} needs ${START} and ${END}`)
  return `${doc.slice(0, a + START.length)}\n${table}\n${doc.slice(b)}`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { ENV_VARS } = await import('../src/server/env-registry.ts')
  const current = readFileSync(DOC, 'utf8')
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const next = replaceTable(current.replace(/\r\n/g, '\n'), renderTable(ENV_VARS)).replace(
    /\n/g,
    eol,
  )
  const page = renderPage(ENV_VARS)
  const pageCurrent = existsSync(PAGE) ? readFileSync(PAGE, 'utf8') : ''
  if (process.argv.includes('--check')) {
    if (next !== current || page !== pageCurrent) {
      console.error(
        `${DOC} or ${PAGE}: variable table is out of date; run node scripts/gen-env-docs.mjs`,
      )
      process.exit(1)
    }
    console.log(`${DOC}: variable table is current`)
  } else {
    writeFileSync(DOC, next)
    writeFileSync(PAGE, page)
    console.log(`${DOC}: variable table written (${ENV_VARS.length} variables)`)
  }
}
