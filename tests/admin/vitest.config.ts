import { defineProject } from 'vitest/config'

// Plain-node project for the admin SPA's pure helpers (admin/lib.js) — no
// workers pool, no DOM. The SPA itself (admin/admin.js) is exercised by the
// admin e2e spec instead.
export default defineProject({
  test: {
    name: 'admin',
    include: ['**/*.test.js'],
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**'],
    environment: 'node',
  },
})
