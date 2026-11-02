import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/** Second build entry (FR-AUT-030, spike 0): `vite build && vite build --config vite.cli.config.ts`. */
export default defineConfig({
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
  ssr: { noExternal: true },
  build: {
    ssr: 'src/cli/dbloom.ts',
    outDir: '.output/cli',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { entryFileNames: 'dbloom.mjs', format: 'es' } },
  },
})
