// FR-SVR-016 / DEP-TGT-126: every dependency in package.json is an exact version, and @tanstack/* matches the lock file.
// Run: node scripts/check-pinned-deps.mjs
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export function findUnpinned(pkg, lock) {
  const bad = []
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[group] ?? {})) {
      if (!EXACT.test(range)) bad.push(`${name}: ${range} is not an exact version`)
      else if (name.startsWith('@tanstack/')) {
        const locked = lock.packages?.[`node_modules/${name}`]?.version
        if (locked !== range) bad.push(`${name}: package.json ${range} differs from lock ${locked}`)
      }
    }
  }
  return bad
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const bad = findUnpinned(JSON.parse(readFileSync('package.json', 'utf8')), JSON.parse(readFileSync('package-lock.json', 'utf8')))
  if (bad.length) {
    console.error(bad.join('\n'))
    process.exit(1)
  }
  console.log('Dependencies: exact versions, lock matches')
}
