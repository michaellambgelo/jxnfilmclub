import { defineConfig } from 'vitest/config'

// Root config — test discovery happens via vitest.workspace.ts
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**', 'model/**', 'worker/**'],
  },
})
