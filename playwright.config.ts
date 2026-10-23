import { defineConfig } from '@playwright/test'

const PORT = 3100

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run build && node .output/server/index.mjs',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      DBLOOM_DATA_DIR: './test-results/data',
      DBLOOM_DIRECT_FREE_FORM_ACK: 'true',
      DBLOOM_ALLOW_LOOPBACK: 'true',
      DBLOOM_TARGET_TLS: 'off',
    },
  },
})
