import { defineConfig } from 'vitest/config'

// Proxy suite (FR-SVR-015): `npm run test:e2e:proxy`. Plain HTTP clients against Compose; no browser.
export default defineConfig({
  test: {
    include: ['e2e/proxy/**/*.proxy.test.ts'],
    environment: 'node',
    globalSetup: ['e2e/proxy/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
