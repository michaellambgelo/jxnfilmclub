// Per-test storage isolation for the worker suite.
//
// @cloudflare/vitest-pool-workers <0.13 rolled every test's KV/R2/D1 writes
// back on its own (`isolatedStorage`, default on). Its Vitest 4 successors
// (pool-workers 0.13+, now @cloudflare/vitest-plugin) dropped that: storage is
// shared by every test in a file. The suite was written against per-test
// isolation — throttle keys, seeded rows and audit records from one test
// would otherwise leak into the next — so restore it explicitly: wipe every
// binding before each test, then re-apply worker/migrations to the now-empty
// D1 (reset() drops the schema and the migrations record along with the rows).
import { applyD1Migrations, env, reset } from 'cloudflare:test'
import { beforeEach } from 'vitest'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.GIVEAWAYS_DB, env.TEST_MIGRATIONS)
})
