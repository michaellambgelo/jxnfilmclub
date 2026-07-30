import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config'
import fs from 'node:fs'

// Mirrors the wrangler.toml module rules: .html/.css imports as Text (string
// modules), .ico as Data (ArrayBuffer). Keep in sync with `rules` there.
// Resolved ids get a `.wrangler-module` suffix so Vite's built-in CSS
// pipeline never claims the .css imports (it would replace our string module
// with an empty one).
const SUFFIX = '.wrangler-module'
const isText = (id: string) => id.endsWith('.html') || id.endsWith('.css')
const isData = (id: string) => id.endsWith('.ico')

const moduleRulesPlugin = {
  name: 'wrangler-module-rules',
  enforce: 'pre' as const,
  resolveId(id: string, importer?: string) {
    if (isText(id) || isData(id)) {
      const path = importer ? new URL(id, 'file://' + importer).pathname : id
      return { id: path + SUFFIX, moduleSideEffects: false }
    }
    return null
  },
  load(id: string) {
    if (!id.endsWith(SUFFIX)) return null
    const file = id.slice(0, -SUFFIX.length)
    if (isText(file)) {
      const contents = fs.readFileSync(file, 'utf8')
      return `export default ${JSON.stringify(contents)};`
    }
    if (isData(file)) {
      const bytes = Array.from(fs.readFileSync(file))
      return `export default new Uint8Array([${bytes.join(',')}]).buffer;`
    }
    return null
  },
}

export default defineWorkersProject({
  plugins: [moduleRulesPlugin],
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
            ADMIN_TOKEN: 'test-admin-token',
            TMDB_API_KEY: 'test-tmdb-key',
            NEWSLETTER_FROM: 'Jackson Film Club <noreply@join.jxnfilm.club>',
            NEWSLETTER_POSTAL_ADDRESS: 'Jackson Film Club, PO Box 1, Jackson, MS 39201',
          },
        },
      },
    },
  },
})
