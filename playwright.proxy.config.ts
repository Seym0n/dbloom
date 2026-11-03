import { defineConfig } from '@playwright/test'

// Browser check through Traefik (FR-SVR-018: `__Host-` cookie behind the proxy). `npm run test:e2e:proxy-browser`.
// Chromium maps dbloom.test (port 443) to the published Traefik port, so the page origin is https://dbloom.test.
export default defineConfig({
  testDir: 'e2e-proxy',
  globalSetup: './e2e-proxy/global-setup.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'https://dbloom.test',
    ignoreHTTPSErrors: true,
    launchOptions: { args: ['--host-resolver-rules=MAP dbloom.test 127.0.0.1:18443'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
