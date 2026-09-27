// Apply worker/migrations to this test file's isolated D1 before its tests
// run. applyD1Migrations records what it applied, so re-running is a no-op.
import { applyD1Migrations, env } from 'cloudflare:test'

await applyD1Migrations(env.GIVEAWAYS_DB, env.TEST_MIGRATIONS)
