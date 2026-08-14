#!/usr/bin/env node
// Backfill: put every hosted screening's host into its attend:{id} array.
//
// The Worker already does this two ways — writeRsvp() mirrors the host name
// on every RSVP mutation, and withHost() overlays it on both public
// attendance reads (so the site, the snapshot workflow, and therefore the
// homepage leaderboard are already correct without running this). What the
// overlay does NOT reach is anything that reads raw KV: the local admin
// dashboard's "Attendance (N)" counts and contentgen's newsletter/social
// totals. This script makes KV itself agree, once.
//
// Usage:
//   node scripts/admin/backfill-host-attendance.mjs                 # dry run, production
//   node scripts/admin/backfill-host-attendance.mjs --apply         # write, production
//   node scripts/admin/backfill-host-attendance.mjs --env staging   # dry run, staging
//
// Safe to re-run: a host already present is left alone, and the pass is a
// no-op once it has converged.

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_DIR = resolve(ROOT, 'worker')
const BINDING = 'ATTENDANCE_KV'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ENV = (() => {
  const i = argv.indexOf('--env')
  return i === -1 ? null : argv[i + 1]
})()

// --remote: wrangler v4 defaults KV ops to LOCAL simulated storage. Every call
// here must be explicit or the script silently "fixes" a local sandbox.
function wrangler(args) {
  const res = spawnSync('npx', ['wrangler', ...args, '--remote', ...(ENV ? ['--env', ENV] : [])], {
    cwd: WORKER_DIR, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (exit ${res.status})`)
  return res.stdout
}

const kvList = (prefix) =>
  JSON.parse(wrangler(['kv', 'key', 'list', '--binding', BINDING, '--prefix', prefix])).map(k => k.name)

const kvGet = (key) => wrangler(['kv', 'key', 'get', '--binding', BINDING, key])

function kvPut(key, value) {
  spawnSync('npx', ['wrangler', 'kv', 'key', 'put', '--binding', BINDING, '--remote',
    ...(ENV ? ['--env', ENV] : []), key, value],
  { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] })
}

const parse = (raw) => { try { return JSON.parse(raw) } catch { return null } }

console.log(`env=${ENV || 'production'} mode=${APPLY ? 'APPLY' : 'dry-run'}`)

// Hosted events only — an admin-curated club event has no host to add.
const hosts = new Map()
for (const key of kvList('event:')) {
  const ev = parse(kvGet(key))
  if (ev && ev.hostId && ev.hostName) hosts.set(ev.id || key.slice('event:'.length), ev.hostName)
}
console.log(`hosted screenings: ${hosts.size}`)

const allRaw = kvGet('attendance:all')
const all = parse(allRaw) || {}
let changed = 0

for (const [eventId, hostName] of hosts) {
  const key = `attend:${eventId}`
  const current = parse(kvGet(key).trim() || 'null') || all[eventId] || []
  if (current.includes(hostName)) continue

  const next = [hostName, ...current]
  changed++
  console.log(`  + ${eventId}: ${JSON.stringify(current)} -> ${JSON.stringify(next)}`)
  all[eventId] = next
  if (APPLY) kvPut(key, JSON.stringify(next))
}

if (!changed) {
  console.log('Nothing to do — every hosted screening already lists its host.')
} else if (APPLY) {
  // Aggregate last, so a mid-run failure leaves per-event keys ahead of the
  // aggregate (the direction the Worker already tolerates) rather than behind.
  kvPut('attendance:all', JSON.stringify(all))
  console.log(`Updated ${changed} event(s) + attendance:all.`)
  console.log('Next: gh workflow run snapshot-attendance.yml (production only) to refresh the ledger.')
} else {
  console.log(`${changed} event(s) would change. Re-run with --apply to write.`)
}
