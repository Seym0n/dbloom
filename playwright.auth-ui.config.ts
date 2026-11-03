import { defineConfig } from '@playwright/test'

/**
 * Auth UI specs (e2e/auth-ui-*.spec.ts) run against the in-memory mock layer (src/lib/auth/mock-api.ts): no Docker,
 * no database, no global setup. `npm run test:e2e:auth-ui`. The main config ignores these specs.
 */
const PORT = 3110

export default defineConfig({
  testDir: 'e2e',
  testMatch: /auth-ui-.*\.spec\.ts/,
  // Not the default test-results/: the dev server keeps its data directory open under it.
  outputDir: 'test-results/auth-ui-output',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      VITE_DBLOOM_AUTH_MOCK: 'true',
      // The request gate matches Host including the port; the loopback default list uses PORT (SPEC/27 FR-SVR-003).
      PORT: String(PORT),
      DBLOOM_DATA_DIR: './test-results/auth-ui-data',
      DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
    },
  },
})
