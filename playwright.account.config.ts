import { defineConfig } from '@playwright/test'

/**
 * Account-mode specs (e2e/auth-live-*.spec.ts, SPEC/26 task 12). Each spec starts its own real server (a fresh SQLite
 * store, `DBLOOM_LOGIN_MODE=account`, see e2e/fixtures/auth-live.ts) from the build in `.output`, so there is no
 * `webServer` here; the global setup builds first unless `E2E_SKIP_BUILD=1`. Needs the Docker test databases
 * (`docker compose -f compose.test.yaml up -d`) for the connection specs. `npm run test:e2e:auth-live`.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: /auth-live-.*\.spec\.ts/,
  globalSetup: ['./e2e/fixtures/live-global-setup.ts'],
  outputDir: 'test-results/auth-live-output',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
