import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'model',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**'],
    environment: 'node',
  },
})
