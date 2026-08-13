import { defineProject } from 'vitest/config'

// Plain-node project for the scripts/ CLIs' pure helpers
// (scripts/lib/audiogram.mjs) — no workers pool, no DOM, and crucially no
// ffmpeg/Chromium: only the logic that feeds them is tested here.
export default defineProject({
  test: {
    name: 'scripts',
    include: ['**/*.test.js'],
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**'],
    environment: 'node',
  },
})
