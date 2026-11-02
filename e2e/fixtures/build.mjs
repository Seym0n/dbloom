// Builds the app for the e2e servers. On Windows the build sometimes fails with EBUSY while nitro copies the traced
// SQL parser package (a file scanner holds the fresh copy), so it is tried a few times before giving up.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

for (let attempt = 1; ; attempt += 1) {
  try {
    execSync('npm run build', { stdio: 'inherit' })
    if (existsSync('.output/server/index.mjs') && existsSync('.output/cli/dbloom.mjs')) break
    throw new Error('the build left no .output/server/index.mjs')
  } catch (error) {
    if (attempt >= 5) throw error
    console.warn(`build attempt ${attempt} failed, trying again`)
  }
}
