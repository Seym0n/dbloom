// FR-SVR-019: the variable table of docs/deploy.md is generated from src/server/env-registry.ts.
//   node scripts/gen-env-docs.mjs          rewrite the table between the markers
//   node scripts/gen-env-docs.mjs --check  exit 1 when docs/deploy.md is out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const START = '<!-- env-table:start -->'
const END = '<!-- env-table:end -->'
const DOC = 'docs/deploy.md'

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderTable(vars) {
  const rows = ['| Variable | Type | Default | Description |', '|---|---|---|---|']
  let group = ''
  for (const e of vars) {
    if (e.group !== group) {
      group = e.group
      rows.push(`| **${cell(group)}** | | | |`)
    }
    const range = e.min !== undefined && e.max !== undefined ? ` (${e.min} to ${e.max})` : e.values ? ` (${e.values.join(', ')})` : ''
    rows.push(`| \`${e.name}\` | ${e.kind}${range} | ${e.default ? `\`${cell(e.default)}\`` : ''} | ${cell(e.doc)} |`)
  }
  return rows.join('\n')
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
  const next = replaceTable(current.replace(/\r\n/g, '\n'), renderTable(ENV_VARS)).replace(/\n/g, eol)
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error(`${DOC}: variable table is out of date; run node scripts/gen-env-docs.mjs`)
      process.exit(1)
    }
    console.log(`${DOC}: variable table is current`)
  } else {
    writeFileSync(DOC, next)
    console.log(`${DOC}: variable table written (${ENV_VARS.length} variables)`)
  }
}
