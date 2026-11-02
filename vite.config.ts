import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // The SQL parser loads its WASM file relative to its own module, so it stays an external package. reflect-metadata must
  // run before the bundled tsyringe (see server/auth/webauthn.ts); inside the bundle the chunk order puts it after.
  ssr: { external: ['@guanmingchiu/sqlparser-ts', 'reflect-metadata'] },
  // "use client" directives in react-router, react-query and lucide are meaningless here (no RSC); drop the warnings.
  build: {
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (log.code === 'MODULE_LEVEL_DIRECTIVE') return
        defaultHandler(level, log)
      },
    },
  },
  plugins: [
    tanstackStart(),
    nitro({
      plugins: ['./src/server/startup-plugin.ts'],
      traceDeps: ['@guanmingchiu/sqlparser-ts*', 'reflect-metadata'],
    }),
    viteReact(),
    tailwindcss(),
  ],
})
