import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Resolve sibling sources by path (not via node_modules) so a worktree
      // whose node_modules is linked to another checkout still tests local edits.
      '@genoffice/agent-core': resolve(here, '../agent-core/src/index.ts'),
      '@genoffice/ai-provider': resolve(here, '../ai-provider/src/index.ts'),
      '@genoffice/xlsx-gateway/gateway/csv-import': resolve(
        here,
        '../xlsx-gateway/src/gateway/csv-import.ts',
      ),
      // Subpath before the bare name: string aliases are prefix replacements.
      '@genoffice/pptx-engine/custgeom': resolve(here, '../pptx-engine/src/custgeom.ts'),
      '@genoffice/pptx-engine': resolve(here, '../pptx-engine/src/index.ts'),
      '@genoffice/docx-engine': resolve(here, '../docx-engine/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
