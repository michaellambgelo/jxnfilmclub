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
//
// Retried: the Cloudflare API answers a rapid burst of per-key reads with a
// spurious 401, so a one-shot spawn per key is not reliable. Everything below
// is also written to read the two aggregates rather than fan out per key,
// which keeps a whole run to a handful of calls.
function wrangler(args, { attempts = 3 } = {}) {
  let last
  for (let i = 1; i <= attempts; i++) {
    const res = spawnSync('npx', ['wrangler', ...args, '--remote', ...(ENV ? ['--env', ENV] : [])], {
      cwd: WORKER_DIR, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (res.status === 0) return res.stdout
    last = (res.stderr || '').trim()
    // A missing key is an answer, not a failure.
    if (/not found|404/i.test(last)) return ''
    if (i < attempts) {
      console.log(`  ! retry ${i}/${attempts - 1}: wrangler ${args.slice(0, 3).join(' ')}`)
      spawnSync('sleep', [String(i)])
    }
  }
  throw new Error(`wrangler ${args.join(' ')} failed after ${attempts} attempts:\n${last}`)
}

const kvGet = (key) => wrangler(['kv', 'key', 'get', '--binding', BINDING, key])

function kvPut(key, value) {
  wrangler(['kv', 'key', 'put', '--binding', BINDING, key, value])
}

const parse = (raw) => { try { return JSON.parse(raw) } catch { return null } }

console.log(`env=${ENV || 'production'} mode=${APPLY ? 'APPLY' : 'dry-run'}`)

// events:all carries the public projection of every event, hostId/hostName
// included — one read instead of a get per event:{id} row.
const events = parse(kvGet('events:all')) || []
const hosts = new Map()
for (const ev of events) {
  if (ev && ev.id && ev.hostId && ev.hostName) hosts.set(ev.id, { id: ev.hostId, name: ev.hostName })
}
console.log(`events: ${events.length}, hosted screenings: ${hosts.size}`)

const all = parse(kvGet('attendance:all')) || {}
let changed = 0

// Attendance entries are { id, name } keyed on member id. A row that still
// holds bare names is left in that shape apart from the host we insert —
// backfill-attendance-ids.mjs is the pass that links the rest.
for (const [eventId, host] of hosts) {
  const key = `attend:${eventId}`
  // Canonical per-event key wins; the aggregate covers rows that never got one.
  const current = parse(kvGet(key).trim() || 'null') || all[eventId] || []
  const present = current.some(a => (
    a && typeof a === 'object' ? a.id === host.id || (!a.id && a.name === host.name) : a === host.name
  ))
  if (present) continue

  const next = [{ id: host.id, name: host.name }, ...current]
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
