// Per-test storage isolation, matching the pre-Vitest-4 `isolatedStorage`
// behaviour the suite was written against: @cloudflare/vitest-plugin shares
// KV/R2 across every test in a file, so wipe all bindings before each test.
import { reset } from 'cloudflare:test'
import { beforeEach } from 'vitest'

beforeEach(async () => {
  await reset()
})
