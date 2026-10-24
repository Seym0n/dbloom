// Usage: node scripts/check-traceability-ids.mjs SPEC/24-module-rows.md browse-edit
// Checks that every id of tasks/traceability/traceability.tsv with the given module appears exactly once in
// the requirement tables (sections 2.1 to 2.3) of the spec, and that no other id appears there.
import { readFileSync } from 'node:fs'

const [specPath = 'SPEC/24-module-rows.md', moduleName = 'browse-edit'] = process.argv.slice(2)
const tsvPath = 'tasks/traceability/traceability.tsv'

const lines = (path) => readFileSync(path, 'utf8').split(/\r?\n/)

const [header, ...rows] = lines(tsvPath).filter((l) => l.length > 0)
const cols = header.split('\t')
const idCol = cols.indexOf('id')
const moduleCol = cols.indexOf('module')
if (idCol < 0 || moduleCol < 0) {
  console.error(`${tsvPath}: columns id and module not found`)
  process.exit(2)
}
const expected = rows
  .map((r) => r.split('\t'))
  .filter((c) => c[moduleCol] === moduleName)
  .map((c) => c[idCol])

// Requirement tables: from "### 2.1" up to "### 2.4"; table rows whose first cell looks like an id.
const spec = lines(specPath)
const start = spec.findIndex((l) => l.startsWith('### 2.1'))
const end = spec.findIndex((l) => l.startsWith('### 2.4'))
if (start < 0 || end < 0) {
  console.error(`${specPath}: sections 2.1 and 2.4 not found`)
  process.exit(2)
}
const found = new Map()
for (const line of spec.slice(start, end)) {
  const m = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*\|/.exec(line)
  if (m && m[1] !== 'ID') found.set(m[1], (found.get(m[1]) ?? 0) + 1)
}

const missing = expected.filter((id) => !found.has(id))
const duplicate = [...found].filter(([, n]) => n > 1).map(([id]) => id)
const extra = [...found.keys()].filter((id) => !expected.includes(id))
const ok = expected.length - missing.length

console.log(`${ok} of ${expected.length} ids of module ${moduleName} found exactly once-or-more`)
if (missing.length) console.error(`missing: ${missing.join(', ')}`)
if (duplicate.length) console.error(`duplicate: ${duplicate.join(', ')}`)
if (extra.length) console.error(`extra (not module ${moduleName}): ${extra.join(', ')}`)
if (missing.length || duplicate.length || extra.length) process.exit(1)
console.log(`${expected.length} of ${expected.length}: each exactly once, none missing, none extra`)
