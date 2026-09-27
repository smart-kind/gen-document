import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Exact-match regexes rather than string aliases: string aliases are prefix
    // replacements, so `@genoffice/docx-engine` would also swallow a subpath like
    // `@genoffice/pptx-engine/custgeom` and rewrite it into a bogus file path.
    alias: [
      {
        find: /^@genoffice\/workspace-harness$/,
        replacement: resolve(__dirname, '../../packages/workspace-harness/src/index.ts'),
      },
      {
        find: /^@genoffice\/i18n$/,
        replacement: resolve(__dirname, '../../packages/i18n/src/index.ts'),
      },
      {
        find: /^@genoffice\/ai-provider$/,
        replacement: resolve(__dirname, '../../packages/ai-provider/src/index.ts'),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
