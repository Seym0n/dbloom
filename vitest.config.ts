import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // The integration tests talk to the Docker databases and run beside 80 other files; the default 5 s limit made nine of
  // them time out in one full run on Windows (they pass alone). The limit is a safety net, not a performance check.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 20_000 },
})
