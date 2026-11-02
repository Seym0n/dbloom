import { execSync } from 'node:child_process'

/** The live account-mode specs run the built server (`.output`); build it (with retries, see build.mjs) unless told not to. */
export default function globalSetup() {
  if (process.env.E2E_SKIP_BUILD === '1') return
  execSync('node e2e/fixtures/build.mjs', { stdio: 'inherit' })
}
