import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  // Bundle everything into the main process (same policy as apps/shell): the
  // imported docs/sheets/slides/pdf/markdown/html main modules and the harness
  // are TS source with no build artifacts, so externalizing them would break
  // Node ESM resolution at runtime.
  main: {
    build: { rollupOptions: { external: ['node:sqlite'] } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.WORKSPACE_SHELL_DEV_PORT) || 5179,
      strictPort: Boolean(process.env.WORKSPACE_SHELL_DEV_PORT),
    },
  },
})
