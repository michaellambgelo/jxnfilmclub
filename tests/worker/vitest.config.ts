import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'
import fs from 'node:fs'

// Inline .html imports as string modules (matches `rules = [{ type = "Text", globs = ["**/*.html"] }]` in wrangler.toml)
const htmlTextPlugin = {
  name: 'html-as-text',
  enforce: 'pre' as const,
  resolveId(id: string, importer?: string) {
    if (id.endsWith('.html')) {
      const path = importer ? new URL(id, 'file://' + importer).pathname : id
      return { id: path, moduleSideEffects: false }
    }
    return null
  },
  load(id: string) {
    if (id.endsWith('.html')) {
      const contents = fs.readFileSync(id, 'utf8')
      return `export default ${JSON.stringify(contents)};`
    }
    return null
  },
}

export default defineWorkersProject({
  plugins: [htmlTextPlugin],
  test: {
    name: 'worker',
    include: ['**/*.test.js'],
    exclude: ['**/node_modules/**', '**/.dist/**', '**/dist/**'],
    poolOptions: {
      workers: {
        singleWorker: true,
        main: '../../worker/src/index.js',
        miniflare: {
          compatibilityDate: '2026-04-14',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: ['MEMBERS_KV', 'ATTENDANCE_KV'],
          bindings: {
            SITE_ORIGIN: 'https://jxnfilm.club',
            GITHUB_OWNER: 'testowner',
            GITHUB_REPO: 'jxnfilmclub',
            GITHUB_TOKEN: 'test-gh-token',
            RESEND_API_KEY: 'test-resend-key',
            OTP_SIGNING_KEY: 'test-key',
          },
        },
      },
    },
  },
})
