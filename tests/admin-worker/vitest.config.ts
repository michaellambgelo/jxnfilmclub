import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'
import fs from 'node:fs'

// Mirrors admin/worker/wrangler.toml module rules: .html/.css AND admin.js +
// lib.js import as Text (string modules). Keep in sync with `rules` there.
// Same suffix trick as tests/worker/vitest.config.ts so Vite's CSS pipeline
// never claims the .css imports.
const SUFFIX = '.wrangler-module'
const isText = (id: string) =>
  id.endsWith('.html') || id.endsWith('.css') ||
  id.endsWith('/admin.js') || id === 'admin.js' ||
  id.endsWith('/lib.js') || id === 'lib.js' ||
  id.endsWith('/contentgen.js') || id === 'contentgen.js'

const moduleRulesPlugin = {
  name: 'wrangler-module-rules',
  enforce: 'pre' as const,
  resolveId(id: string, importer?: string) {
    if (isText(id)) {
      const path = importer ? new URL(id, 'file://' + importer).pathname : id
      return { id: path + SUFFIX, moduleSideEffects: false }
    }
    return null
  },
  load(id: string) {
    if (!id.endsWith(SUFFIX)) return null
    const file = id.slice(0, -SUFFIX.length)
    const contents = fs.readFileSync(file, 'utf8')
    return `export default ${JSON.stringify(contents)};`
  },
}

export default defineWorkersProject({
  plugins: [moduleRulesPlugin],
  test: {
    name: 'admin-worker',
    include: ['**/*.test.js'],
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**'],
    poolOptions: {
      workers: {
        singleWorker: true,
        main: '../../admin/worker/src/index.js',
        miniflare: {
          compatibilityDate: '2026-04-14',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: [
            'MEMBERS_KV',
            'ATTENDANCE_KV',
            'MEMBERS_KV_STAGING',
            'ATTENDANCE_KV_STAGING',
          ],
          bindings: {
            ACCESS_TEAM_DOMAIN: 'testteam.cloudflareaccess.com',
            ACCESS_AUD: 'test-aud-tag',
            ADMIN_TOKEN: 'test-admin-token',
            ADMIN_TOKEN_STAGING: 'test-admin-token-staging',
          },
        },
      },
    },
  },
})
