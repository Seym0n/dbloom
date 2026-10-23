import { defineConfig } from '@playwright/test'
import type { StructureOptions } from './e2e/fixtures/scratch-db'

const PORT = 3100
// Second instance with DBLOOM_READ_ONLY=true, for the read-only scenario (SCN-020).
const READ_ONLY_PORT = 3101

// Run once per product (SCN-022, SCN-024 to SCN-036): `--project=mysql` or `--project=mariadb`.
// sql-smoke stays with the walking-skeleton specs in the chromium project.
const perProductSpecs = /(structure-.*|sql-(?!smoke).*)\.spec\.ts/
// Fourth server: low limits (2 s statement timeout, 1 000 row cap) for the timeout and cap scenarios.
const LIMITS_PORT = 3102

const env = {
  DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
  DBLOOM_ALLOW_LOOPBACK: 'true',
  DBLOOM_TARGET_TLS: 'off',
}

export default defineConfig<StructureOptions>({
  testDir: 'e2e',
  // Seeds the shop database, then removes scratch databases and users left by an aborted run.
  globalSetup: ['./e2e/global-setup.ts', './e2e/fixtures/scratch-db.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    // The walking-skeleton specs run against the seeded MySQL 8.4 only.
    { name: 'chromium', testIgnore: perProductSpecs, use: { browserName: 'chromium' } },
    // The structure specs run once per product (SCN-022): `--project=mysql` or `--project=mariadb`.
    {
      name: 'mysql',
      testMatch: perProductSpecs,
      use: { browserName: 'chromium', product: 'mysql' },
    },
    {
      name: 'mariadb',
      testMatch: perProductSpecs,
      use: { browserName: 'chromium', product: 'mariadb' },
    },
  ],
  webServer: [
    {
      command: 'npm run build && node .output/server/index.mjs',
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      timeout: 180_000,
      env: { ...env, PORT: String(PORT), DBLOOM_DATA_DIR: './test-results/data' },
    },
    {
      // Waits for the build of the first server, then starts the same build read-only.
      command: 'node e2e/fixtures/start-read-only.mjs',
      url: `http://localhost:${READ_ONLY_PORT}/api/health`,
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      timeout: 240_000,
      env: {
        ...env,
        PORT: String(READ_ONLY_PORT),
        DBLOOM_DATA_DIR: './test-results/data-read-only',
        DBLOOM_READ_ONLY: 'true',
        WAIT_FOR_URL: `http://localhost:${PORT}/api/health`,
      },
    },
    {
      command: 'node e2e/fixtures/start-read-only.mjs',
      url: `http://localhost:${LIMITS_PORT}/api/health`,
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      timeout: 240_000,
      env: {
        ...env,
        PORT: String(LIMITS_PORT),
        DBLOOM_DATA_DIR: './test-results/data-limits',
        DBLOOM_STATEMENT_TIMEOUT_SECONDS: '2',
        DBLOOM_SQL_ROW_CAP: '1000',
        WAIT_FOR_URL: `http://localhost:${PORT}/api/health`,
      },
    },
  ],
})
