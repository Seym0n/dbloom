// FR-SVR-016 / DEP-TGT-126: every package with an install script in package-lock.json must be on the allow-list.
// Run: node scripts/check-lifecycle-scripts.mjs
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** name -> reason. fsevents is a macOS-only optional dependency; it never installs on Linux. */
const ALLOWED = { fsevents: 'macOS only, optional' }

export function findViolations(lock, allowed = ALLOWED) {
  const bad = []
  for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
    if (!pkg.hasInstallScript) continue
    const name = path.split('node_modules/').pop()
    if (!(name in allowed)) bad.push(`${name}@${pkg.version}`)
  }
  return bad
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const bad = findViolations(JSON.parse(readFileSync('package-lock.json', 'utf8')))
  if (bad.length) {
    console.error(`Packages with install scripts not on the allow-list: ${bad.join(', ')}`)
    process.exit(1)
  }
  console.log('Lifecycle scripts: allow-list holds')
}
