import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // The SQL parser loads its WASM file relative to its own module, so it stays an external package.
  ssr: { external: ['@guanmingchiu/sqlparser-ts'] },
  plugins: [
    tanstackStart(),
    nitro({
      plugins: ['./src/server/startup-plugin.ts'],
      traceDeps: ['@guanmingchiu/sqlparser-ts*'],
    }),
    viteReact(),
    tailwindcss(),
  ],
})
