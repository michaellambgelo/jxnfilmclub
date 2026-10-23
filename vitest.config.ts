import { defineConfig } from 'vitest/config'

// Root config — one entry per test project. Vitest 4 dropped
// vitest.workspace.ts; `test.projects` replaces it.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**', 'model/**', 'worker/**'],
    projects: [
      './tests/model/vitest.config.ts',
      './tests/worker/vitest.config.ts',
      './tests/admin-worker/vitest.config.ts',
      './tests/admin/vitest.config.ts',
      './tests/scripts/vitest.config.ts',
    ],
  },
})
